import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrispVTSDK } from "../src/KrispVTSDK";
import { API_KEY, FakeWebSocket } from "./helpers";
import type { IErrorPayload, IRawAudioChunkInfo, VtAudioFormat } from "../src/types";
import { VtErrorType } from "../src/types";

const fakeStream = () => ({ getAudioTracks: () => [{ kind: "audio" }] }) as never;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
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

describe("sendAudio() in opus mode", () => {
  it("forwards an ArrayBuffer packet verbatim, odd lengths included", async () => {
    const { sdk, socket } = await startedSdk("opus");
    // Opus packets are opaque bytes; 3 bytes would be rejected as PCM16.
    const packet = new Uint8Array([0x78, 0x01, 0x02]).buffer;

    sdk.sendAudio(packet);

    expect(uplink(socket)).toEqual([packet]);
    expect(sdk.getState()).toBe("PROCESSING");
  });

  it("sends only a Uint8Array view's own bytes", async () => {
    const { sdk, socket } = await startedSdk("opus");
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);

    sdk.sendAudio(backing.subarray(2, 5));

    const sent = new Uint8Array(uplink(socket)[0] as ArrayBuffer);
    expect(Array.from(sent)).toEqual([3, 4, 5]);
  });

  it("rejects PCM-shaped typed arrays", async () => {
    const { sdk, socket, errors } = await startedSdk("opus");

    expect(() => sdk.sendAudio(new Float32Array([0, 1]))).not.toThrow();

    expect(uplink(socket)).toEqual([]);
    expect(errors[0]!.code).toBe(VtErrorType.InvalidInputData);
    expect(errors[0]!.message).toMatch(/opus/i);
  });

  it("still accepts the PCM forms when format is omitted", async () => {
    const { sdk, socket, errors } = await startedSdk();

    sdk.sendAudio(new Int16Array([1, 2]));

    expect(uplink(socket)).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("process() in opus mode", () => {
  it("is rejected – the SDK does not encode Opus", async () => {
    const { sdk, socket, errors } = await startedSdk("opus");

    await sdk.process(fakeStream());

    expect(errors[0]!.code).toBe(VtErrorType.InvalidSessionConfigurations);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(sdk.getState()).toBe("CONNECTED");
  });
});

describe("downlink chunks in opus mode", () => {
  it("are emitted via onRawAudioChunk with format 'opus'", async () => {
    const { sdk, socket } = await startedSdk("opus");
    const infos: IRawAudioChunkInfo[] = [];
    sdk.setHooks({ onRawAudioChunk: (_buffer, info) => void infos.push(info) });

    socket.emitBinary(11);

    expect(infos).toEqual([{ sampleRate: 16000, format: "opus", channels: 1 }]);
  });

  it("never reach internal playback even when it is not disabled", async () => {
    // disableInternalPlayback: false — opus alone must keep PCM playback off.
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    const onProcessedAudio = vi.fn();
    sdk.setHooks({ onProcessedAudio });
    const pending = sdk.start({ from: "en-US", to: "es-ES", audio: { format: "opus" } });
    const socket = FakeWebSocket.last!;
    socket.open();
    socket.emitReady();
    await pending;

    sdk.sendAudio(new Uint8Array([1, 2, 3]));
    socket.emitBinary(11);

    expect(onProcessedAudio).not.toHaveBeenCalled();
  });
});
