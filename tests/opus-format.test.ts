import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrispVTSDK } from "../src/KrispVTSDK";
import { isAudioFormatSupported } from "../src/audio-codec";
import { API_KEY, FakeWebSocket } from "./helpers";
import type { IErrorPayload, IRawAudioChunkInfo, VtAudioFormat } from "../src/types";
import { VtErrorType } from "../src/types";

/**
 * Minimal WebCodecs stand-ins. The encoder emits one fake "packet" per 20 ms
 * frame it is given (4 bytes: a marker plus the frame's first sample, so the
 * tests can tell which frame it came from); the decoder turns each packet into
 * 320 samples of a constant value taken from the packet's second byte.
 */
class FakeAudioData {
  static closed = 0;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  readonly init: { data?: Float32Array };
  constructor(init: {
    numberOfFrames: number;
    sampleRate?: number;
    data?: Float32Array;
  }) {
    this.init = init;
    this.numberOfFrames = init.numberOfFrames;
    this.sampleRate = init.sampleRate ?? 16000;
  }
  copyTo(dest: Float32Array): void {
    dest.fill(this.init.data?.[0] ?? 0);
  }
  close(): void {
    FakeAudioData.closed++;
  }
}

class FakeEncodedAudioChunk {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  constructor(init: { type: string; timestamp: number; data: ArrayBuffer | Uint8Array }) {
    this.bytes = new Uint8Array(init.data as ArrayBuffer);
    this.byteLength = this.bytes.byteLength;
  }
  copyTo(dest: Uint8Array): void {
    dest.set(this.bytes);
  }
}

class FakeAudioEncoder {
  static last: FakeAudioEncoder | null = null;
  state = "unconfigured";
  config: any = null;
  constructor(public init: { output: (c: FakeEncodedAudioChunk) => void }) {
    FakeAudioEncoder.last = this;
  }
  configure(config: unknown): void {
    this.config = config;
    this.state = "configured";
  }
  encode(data: FakeAudioData): void {
    const first = data.init.data?.[0] ?? 0;
    this.init.output(
      new FakeEncodedAudioChunk({
        type: "key",
        timestamp: 0,
        data: new Uint8Array([0x4f, Math.round(first * 100), 0, 0]),
      })
    );
  }
  close(): void {
    this.state = "closed";
  }
}

class FakeAudioDecoder {
  static last: FakeAudioDecoder | null = null;
  /** Real Chromium decodes Opus at 48 kHz whatever it is configured with. */
  static outputRate = 16000;
  state = "unconfigured";
  config: any = null;
  constructor(public init: { output: (d: FakeAudioData) => void }) {
    FakeAudioDecoder.last = this;
  }
  configure(config: unknown): void {
    this.config = config;
    this.state = "configured";
  }
  decode(chunk: FakeEncodedAudioChunk): void {
    const level = (chunk.bytes[1] ?? 0) / 100;
    this.init.output(
      new FakeAudioData({
        numberOfFrames: (320 * FakeAudioDecoder.outputRate) / 16000,
        sampleRate: FakeAudioDecoder.outputRate,
        data: new Float32Array([level]),
      })
    );
  }
  close(): void {
    this.state = "closed";
  }
}

const fakeStream = () => ({ getAudioTracks: () => [{ kind: "audio" }] }) as never;

function stubWebCodecs() {
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("AudioDecoder", FakeAudioDecoder);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("EncodedAudioChunk", FakeEncodedAudioChunk);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
  FakeAudioEncoder.last = null;
  FakeAudioDecoder.last = null;
  FakeAudioData.closed = 0;
  FakeAudioDecoder.outputRate = 16000;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startedSdk(format?: VtAudioFormat) {
  const errors: IErrorPayload[] = [];
  const sdk = new KrispVTSDK({ apiKey: API_KEY, disableInternalPlayback: true });
  sdk.setHooks({ onError: (e) => void errors.push(e) });
  const pending = sdk.start({
    from: "en-US",
    to: "es-ES",
    ...(format ? { audio: { format } } : {}),
  });
  const socket = FakeWebSocket.last!;
  socket.open();
  socket.emitReady();
  await pending;
  return { sdk, socket, errors };
}

/** Binary frames the SDK pushed, ignoring the ClientHello at index 0. */
const uplink = (socket: FakeWebSocket) => socket.sent.slice(1);

/** `samples` PCM16 samples, all equal to `value`. */
const pcm = (samples: number, value = 0) =>
  new Int16Array(samples).fill(value);

describe("start() validates the audio block", () => {
  it("rejects an unknown format before touching the network", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    await expect(
      sdk.start({ from: "en-US", to: "es-ES", audio: { format: "mp3" as never } })
    ).rejects.toThrow(/format/i);

    expect(errors[0]!.code).toBe(VtErrorType.ValidationErrorClient);
    expect(FakeWebSocket.last).toBeNull();
  });

  it("rejects a sample_rate other than 16000 before touching the network", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    await expect(
      sdk.start({ from: "en-US", to: "es-ES", audio: { sample_rate: 48000 } })
    ).rejects.toThrow(/sample_rate/i);

    expect(errors[0]!.code).toBe(VtErrorType.ValidationErrorClient);
    expect(FakeWebSocket.last).toBeNull();
  });

  it("accepts an explicit sample_rate of 16000", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY, disableInternalPlayback: true });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    const pending = sdk.start({
      from: "en-US",
      to: "es-ES",
      audio: { sample_rate: 16000 },
    });
    const socket = FakeWebSocket.last!;
    socket.open();
    socket.emitReady();
    await pending;

    expect(errors).toEqual([]);
    expect(sdk.getState()).toBe("CONNECTED");
  });
});

describe("opus without WebCodecs", () => {
  it("is reported as unsupported before connecting", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    expect(isAudioFormatSupported("opus")).toBe(false);
    await expect(
      sdk.start({ from: "en-US", to: "es-ES", audio: { format: "opus" } })
    ).rejects.toThrow(/WebCodecs/);

    expect(errors[0]!.code).toBe(VtErrorType.InvalidSessionConfigurations);
    expect(FakeWebSocket.last).toBeNull();
  });

  it("never blocks pcm_s16le", () => {
    expect(isAudioFormatSupported("pcm_s16le")).toBe(true);
  });
});

describe("opus uplink: callers still push PCM", () => {
  beforeEach(stubWebCodecs);

  it("is supported when WebCodecs exists", () => {
    expect(isAudioFormatSupported("opus")).toBe(true);
  });

  it("configures the codecs for 16 kHz mono Opus with 20 ms frames", async () => {
    await startedSdk("opus");

    expect(FakeAudioEncoder.last!.config).toMatchObject({
      codec: "opus",
      sampleRate: 16000,
      numberOfChannels: 1,
      opus: { frameDuration: 20000 },
    });
    expect(FakeAudioDecoder.last!.config).toMatchObject({
      codec: "opus",
      sampleRate: 16000,
      numberOfChannels: 1,
    });
  });

  it("sends one Opus packet per 20 ms of pushed PCM, not the PCM itself", async () => {
    const { sdk, socket, errors } = await startedSdk("opus");

    sdk.sendAudio(pcm(1280)); // 80 ms = 4 frames

    expect(errors).toEqual([]);
    expect(uplink(socket)).toHaveLength(4);
    for (const packet of uplink(socket)) {
      expect((packet as ArrayBuffer).byteLength).toBe(4);
    }
    expect(sdk.getState()).toBe("PROCESSING");
  });

  it("re-frames chunks that do not align to 20 ms", async () => {
    const { sdk, socket } = await startedSdk("opus");

    sdk.sendAudio(pcm(200)); // under one frame: nothing yet
    expect(uplink(socket)).toHaveLength(0);

    sdk.sendAudio(pcm(200)); // 400 total: one frame + 80 left over
    expect(uplink(socket)).toHaveLength(1);

    sdk.sendAudio(pcm(240)); // 320 total again: second frame
    expect(uplink(socket)).toHaveLength(2);
  });

  it("scales Int16 samples to floats for the encoder", async () => {
    const { sdk, socket } = await startedSdk("opus");

    sdk.sendAudio(pcm(320, 16384)); // 0.5 of full scale

    // The fake encoder encodes round(firstSample * 100) into byte 1.
    expect(new Uint8Array(uplink(socket)[0] as ArrayBuffer)[1]).toBe(50);
  });

  it("accepts the same PCM forms as the default format", async () => {
    const { sdk, socket, errors } = await startedSdk("opus");

    sdk.sendAudio(new Float32Array(320));
    sdk.sendAudio(pcm(320).buffer);

    expect(errors).toEqual([]);
    expect(uplink(socket)).toHaveLength(2);
  });

  it("still rejects an odd-length ArrayBuffer as not being PCM16", async () => {
    const { sdk, socket, errors } = await startedSdk("opus");

    sdk.sendAudio(new ArrayBuffer(3));

    expect(uplink(socket)).toEqual([]);
    expect(errors[0]!.code).toBe(VtErrorType.InvalidInputData);
  });

  it("works through process() too", async () => {
    // process() only needs a stream with an audio track here; capture itself is
    // stubbed out because the codec layer is what is under test.
    const { sdk, errors } = await startedSdk("opus");
    vi.stubGlobal("AudioContext", class {
      readonly sampleRate = 16000;
      readonly state = "running";
      readonly destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { connect() {}, disconnect() {} }; }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      async close() {}
    });

    await sdk.process(fakeStream());

    expect(errors).toEqual([]);
    expect(sdk.getState()).toBe("PROCESSING");
  });
});

describe("opus downlink: hooks still deliver PCM", () => {
  beforeEach(stubWebCodecs);

  it("decodes packets and emits PCM16 via onRawAudioChunk with format pcm_s16le", async () => {
    const { sdk, socket } = await startedSdk("opus");
    const chunks: Array<{ samples: Int16Array; info: IRawAudioChunkInfo }> = [];
    sdk.setHooks({
      onRawAudioChunk: (buffer, info) =>
        void chunks.push({ samples: new Int16Array(buffer), info }),
    });

    // Packet whose second byte is 50 → fake decoder yields 0.5 full scale.
    socket.onmessage?.({ data: new Uint8Array([0x4f, 50, 0, 0]).buffer });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.info).toEqual({
      sampleRate: 16000,
      format: "pcm_s16le",
      channels: 1,
    });
    expect(chunks[0]!.samples).toHaveLength(320);
    expect(chunks[0]!.samples[0]).toBe(16384);
  });

  it("brings 48 kHz decoder output (what Chromium returns) back to 16 kHz", async () => {
    FakeAudioDecoder.outputRate = 48000;
    const { sdk, socket } = await startedSdk("opus");
    const chunks: Int16Array[] = [];
    sdk.setHooks({ onRawAudioChunk: (b) => void chunks.push(new Int16Array(b)) });

    socket.onmessage?.({ data: new Uint8Array([0x4f, 50, 0, 0]).buffer });

    // 20 ms is 960 samples at 48 kHz but must reach consumers as 320 at 16 kHz,
    // otherwise playback runs three times too slow.
    expect(chunks[0]).toHaveLength(320);
    expect(chunks[0]![0]).toBe(16384);
  });

  it("feeds internal playback with the decoded PCM, not the packet", async () => {
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    const pending = sdk.start({ from: "en-US", to: "es-ES", audio: { format: "opus" } });
    const socket = FakeWebSocket.last!;
    socket.open();
    socket.emitReady();
    await pending;
    const played: ArrayBuffer[] = [];
    (sdk as any)._audioOutput.addPCM16Chunk = (b: ArrayBuffer) => void played.push(b);

    socket.onmessage?.({ data: new Uint8Array([0x4f, 10, 0, 0]).buffer });

    expect(played).toHaveLength(1);
    expect(played[0]!.byteLength).toBe(640); // 320 samples × 2 bytes
  });

  it("closes both codecs on stop()", async () => {
    const { sdk } = await startedSdk("opus");

    await sdk.stop();

    expect(FakeAudioEncoder.last!.state).toBe("closed");
    expect(FakeAudioDecoder.last!.state).toBe("closed");
  });
});

describe("pcm_s16le is untouched by the codec layer", () => {
  it("forwards pushed PCM verbatim and delivers incoming bytes as-is", async () => {
    const { sdk, socket } = await startedSdk();
    const received: ArrayBuffer[] = [];
    sdk.setHooks({ onRawAudioChunk: (b) => void received.push(b) });
    const sent = pcm(4, 7).buffer;

    sdk.sendAudio(sent);
    socket.emitBinary(16);

    expect(uplink(socket)).toEqual([sent]);
    expect(received).toHaveLength(1);
    expect(received[0]!.byteLength).toBe(16);
  });
});
