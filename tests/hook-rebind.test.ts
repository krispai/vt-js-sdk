import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrispVTSDK } from "../src/KrispVTSDK";
import { API_KEY, FakeWebSocket } from "./helpers";
import type { IRawAudioChunkInfo } from "../src/types";

/**
 * `setHooks()` must reach every service, including those built inside `start()`.
 * Services capture the hooks object by reference at construction, so it has to be
 * mutated in place rather than replaced.
 */

beforeEach(() => {
  // start() races connect() against a 20s timeout whose timer is never cleared.
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A started SDK sitting at CONNECTED, with no hooks registered yet. */
async function startedSdk(): Promise<{ sdk: KrispVTSDK; socket: FakeWebSocket }> {
  const sdk = new KrispVTSDK({ apiKey: API_KEY });
  const pending = sdk.start({ from: "en-US", to: "es-ES" });
  const socket = FakeWebSocket.last!;
  socket.open();
  socket.emitReady();
  await pending;
  return { sdk, socket };
}

describe("setHooks() after start()", () => {
  it("delivers transcript events to a hook registered after start()", async () => {
    const { sdk, socket } = await startedSdk();
    const onTranscript = vi.fn();

    sdk.setHooks({ onTranscript });
    socket.emitText({ transcript: { text: "Hello", final: true, utterance_id: "u1" } });

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript.mock.calls[0]![0]).toMatchObject({ text: "Hello" });
  });

  it("delivers raw messages to an onMessage registered after start()", async () => {
    const { sdk, socket } = await startedSdk();
    const onMessage = vi.fn();

    sdk.setHooks({ onMessage });
    socket.emitText({ translate: { text: "Hola", utterance_id: "u1" } });

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("delivers onDisconnected to a hook registered after start()", async () => {
    const { sdk, socket } = await startedSdk();
    const onDisconnected = vi.fn();

    sdk.setHooks({ onDisconnected });
    socket.close();

    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  it("keeps hooks registered before start() working", async () => {
    const onTranscript = vi.fn();
    const sdk = new KrispVTSDK({ apiKey: API_KEY });
    sdk.setHooks({ onTranscript });

    const pending = sdk.start({ from: "en-US", to: "es-ES" });
    const socket = FakeWebSocket.last!;
    socket.open();
    socket.emitReady();
    await pending;

    socket.emitText({ transcript: { text: "Hello" } });

    expect(onTranscript).toHaveBeenCalledOnce();
  });

  it("merges rather than replaces, and stays chainable", async () => {
    const { sdk, socket } = await startedSdk();
    const onTranscript = vi.fn();
    const onTranslate = vi.fn();

    expect(sdk.setHooks({ onTranscript })).toBe(sdk);
    sdk.setHooks({ onTranslate });

    socket.emitText({
      transcript: { text: "Hello", utterance_id: "u1" },
      translate: { text: "Hola", utterance_id: "u1" },
    });

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranslate).toHaveBeenCalledOnce();
  });
});

describe("onRawAudioChunk registered after start()", () => {
  it("receives translated audio with its format descriptor", async () => {
    const { sdk, socket } = await startedSdk();
    const chunks: Array<{ bytes: number; info: IRawAudioChunkInfo }> = [];
    sdk.setHooks({
      onRawAudioChunk: (buffer, info) =>
        void chunks.push({ bytes: buffer.byteLength, info }),
    });

    socket.emitBinary(16);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.bytes).toBe(16);
    expect(chunks[0]!.info).toEqual({
      sampleRate: 16000,
      format: "pcm_s16le",
      channels: 1,
    });
  });
});
