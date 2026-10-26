import type { VtAudioFormat } from "./types";
import { CAPTURE_SAMPLE_RATE } from "./constants";
import { floatToPcm16 } from "./pcm";

/**
 * Wire-format codec. Everything above this layer — `process()`, `sendAudio()`,
 * `onRawAudioChunk`, internal playback — speaks mono PCM16 @ 16 kHz regardless
 * of `audio.format`; the codec alone converts to and from what goes over the
 * WebSocket.
 */
export interface IAudioCodec {
  /** PCM16 little-endian in; zero or more wire packets out via `onEncoded`. */
  encode(pcm: ArrayBuffer): void;
  /** One wire packet in; PCM16 little-endian out via `onDecoded`. */
  decode(packet: ArrayBuffer): void;
  close(): void;
}

export interface IAudioCodecCallbacks {
  onEncoded: (packet: ArrayBuffer) => void;
  onDecoded: (pcm: ArrayBuffer) => void;
  onError: (error: Error) => void;
}

/** Opus packets are a fixed 20 ms of audio, matching the service. */
const OPUS_FRAME_MS = 20;
const OPUS_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE * OPUS_FRAME_MS) / 1000;
const OPUS_FRAME_US = OPUS_FRAME_MS * 1000;
const OPUS_BITRATE = 24_000;

/**
 * Whether this environment can run `format`. `pcm_s16le` always can; `opus`
 * needs the WebCodecs audio API (Chromium-based browsers, recent Safari).
 */
export function isAudioFormatSupported(format: VtAudioFormat): boolean {
  if (format === "pcm_s16le") return true;
  return (
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof AudioData !== "undefined" &&
    typeof EncodedAudioChunk !== "undefined"
  );
}

/**
 * Resample decoded audio to the 16 kHz the rest of the SDK works in.
 *
 * WebCodecs' Opus decoder returns 48 kHz whatever sample rate it was configured
 * with, so decoded frames must be brought back down. Box-averaging each output
 * sample's span of input is a cheap low-pass that suits speech; for the usual
 * 48 kHz → 16 kHz it averages groups of three.
 */
export function resampleToCaptureRate(
  samples: Float32Array,
  fromRate: number
): Float32Array {
  if (fromRate === CAPTURE_SAMPLE_RATE) return samples;
  const ratio = fromRate / CAPTURE_SAMPLE_RATE;
  const out = new Float32Array(Math.round(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((i + 1) * ratio))
    );
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = sum / (end - start);
  }
  return out;
}

export function createAudioCodec(
  format: VtAudioFormat,
  callbacks: IAudioCodecCallbacks
): IAudioCodec {
  return format === "opus"
    ? new OpusCodec(callbacks)
    : new PcmCodec(callbacks);
}

/** `pcm_s16le`: the wire carries PCM16 as-is. */
class PcmCodec implements IAudioCodec {
  constructor(private callbacks: IAudioCodecCallbacks) {}

  encode(pcm: ArrayBuffer): void {
    this.callbacks.onEncoded(pcm);
  }

  decode(packet: ArrayBuffer): void {
    this.callbacks.onDecoded(packet);
  }

  close(): void {}
}

/**
 * `opus`: raw Opus packets (no Ogg container), one per WebSocket message,
 * 20 ms each, via WebCodecs. Encoding and decoding run on the browser's codec
 * threads; results arrive through the callbacks.
 */
class OpusCodec implements IAudioCodec {
  private encoder: AudioEncoder;
  private decoder: AudioDecoder;
  private frame = new Float32Array(OPUS_FRAME_SAMPLES);
  private filled = 0;
  private encodeTimestamp = 0;
  private decodeTimestamp = 0;

  constructor(private callbacks: IAudioCodecCallbacks) {
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        callbacks.onEncoded(packet.buffer);
      },
      error: callbacks.onError,
    });
    this.encoder.configure({
      codec: "opus",
      sampleRate: CAPTURE_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: OPUS_BITRATE,
      opus: { frameDuration: OPUS_FRAME_US },
    });

    this.decoder = new AudioDecoder({
      output: (data) => {
        const decoded = new Float32Array(data.numberOfFrames);
        data.copyTo(decoded, { planeIndex: 0, format: "f32-planar" });
        const rate = data.sampleRate;
        data.close();
        const pcm = floatToPcm16(resampleToCaptureRate(decoded, rate));
        callbacks.onDecoded(pcm.buffer as ArrayBuffer);
      },
      error: callbacks.onError,
    });
    this.decoder.configure({
      codec: "opus",
      sampleRate: CAPTURE_SAMPLE_RATE,
      numberOfChannels: 1,
    });
  }

  encode(pcm: ArrayBuffer): void {
    if (this.encoder.state !== "configured") return;
    const samples = new Int16Array(pcm);
    // Callers deliver arbitrary chunk sizes; Opus needs exact 20 ms frames.
    for (let i = 0; i < samples.length; i++) {
      this.frame[this.filled++] = samples[i]! / 0x8000;
      if (this.filled === OPUS_FRAME_SAMPLES) this.encodeFrame();
    }
  }

  decode(packet: ArrayBuffer): void {
    if (this.decoder.state !== "configured") return;
    this.decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: this.decodeTimestamp,
        data: packet,
      })
    );
    this.decodeTimestamp += OPUS_FRAME_US;
  }

  close(): void {
    this.filled = 0;
    if (this.encoder.state !== "closed") this.encoder.close();
    if (this.decoder.state !== "closed") this.decoder.close();
  }

  private encodeFrame(): void {
    const data = new AudioData({
      format: "f32",
      sampleRate: CAPTURE_SAMPLE_RATE,
      numberOfFrames: OPUS_FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: this.encodeTimestamp,
      data: this.frame,
    });
    this.encodeTimestamp += OPUS_FRAME_US;
    this.filled = 0;
    this.encoder.encode(data);
    data.close();
  }
}
