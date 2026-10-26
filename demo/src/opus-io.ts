/**
 * Opus encode / decode for the demo, built on WebCodecs.
 *
 * The SDK is a pass-through for `audio: { format: "opus" }`: it neither encodes
 * the microphone nor decodes the translation. The service speaks raw Opus
 * packets (no Ogg container), 16 kHz mono, 20 ms per packet, one packet per
 * WebSocket message — which is what WebCodecs' `opus` codec produces and consumes.
 */

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_US = 20_000;
const PLAYBACK_PREBUFFER_S = 0.12;

export function isOpusSupported(): boolean {
  return (
    typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined"
  );
}

// Collects the microphone into exact 20 ms frames off the main thread.
const CAPTURE_WORKLET_SOURCE = `
class OpusFrameCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.frame[this.filled++] = channel[i];
      if (this.filled === ${FRAME_SAMPLES}) {
        this.port.postMessage(this.frame.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("opus-frame-capture", OpusFrameCapture);
`;

/**
 * Encode the microphone to Opus and hand each packet to `onPacket`.
 * Resolves to a function that tears everything down.
 */
export async function startOpusUplink(
  microphone: MediaStream,
  onPacket: (packet: Uint8Array) => void,
  onError: (error: Error) => void
): Promise<() => Promise<void>> {
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      onPacket(packet);
    },
    error: onError,
  });
  encoder.configure({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: 24_000,
    opus: { frameDuration: FRAME_US },
  });

  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const workletUrl = URL.createObjectURL(
    new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" })
  );
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = context.createMediaStreamSource(microphone);
  const capture = new AudioWorkletNode(context, "opus-frame-capture");
  // A muted path to the destination keeps the graph pulled in every browser.
  const mute = context.createGain();
  mute.gain.value = 0;

  let timestamp = 0;
  capture.port.onmessage = (event: MessageEvent<Float32Array<ArrayBuffer>>) => {
    if (encoder.state !== "configured") return;
    const data = new AudioData({
      format: "f32",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp,
      data: event.data,
    });
    timestamp += FRAME_US;
    encoder.encode(data);
    data.close();
  };

  source.connect(capture);
  capture.connect(mute);
  mute.connect(context.destination);
  if (context.state === "suspended") await context.resume();

  return async () => {
    capture.port.onmessage = null;
    source.disconnect();
    capture.disconnect();
    mute.disconnect();
    if (encoder.state !== "closed") encoder.close();
    await context.close().catch(() => {});
  };
}

export interface IOpusDownlink {
  /** Translated audio, ready to play or mix like the SDK's own output stream. */
  stream: MediaStream;
  /** Decode one Opus packet and queue it for playback. */
  feed(packet: ArrayBuffer): void;
  stop(): Promise<void>;
}

/** Decode translated Opus packets into a jitter-buffered `MediaStream`. */
export async function createOpusDownlink(
  onError: (error: Error) => void
): Promise<IOpusDownlink> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const destination = context.createMediaStreamDestination();
  let nextStart = 0;
  let timestamp = 0;

  const decoder = new AudioDecoder({
    output: (data) => {
      const frames = data.numberOfFrames;
      const samples = new Float32Array(frames);
      data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
      data.close();

      const buffer = context.createBuffer(1, frames, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(destination);

      // Restart the queue after an underrun (and on the first packet) with a
      // small cushion so the next packets arrive before they are due.
      const now = context.currentTime;
      if (nextStart < now) nextStart = now + PLAYBACK_PREBUFFER_S;
      node.start(nextStart);
      nextStart += buffer.duration;
    },
    error: onError,
  });
  decoder.configure({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
  });

  if (context.state === "suspended") await context.resume();

  return {
    stream: destination.stream,
    feed(packet) {
      if (decoder.state !== "configured") return;
      decoder.decode(
        new EncodedAudioChunk({ type: "key", timestamp, data: packet })
      );
      timestamp += FRAME_US;
    },
    async stop() {
      if (decoder.state !== "closed") decoder.close();
      destination.disconnect();
      await context.close().catch(() => {});
    },
  };
}
