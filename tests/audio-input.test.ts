import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrispVTSDK } from "../src/KrispVTSDK";
import { API_KEY, FakeWebSocket } from "./helpers";
import type { IErrorPayload } from "../src/types";
import { VtErrorType } from "../src/types";

/**
 * Minimal Web Audio stub. `AudioWorkletNode` is undefined in node, so
 * AudioCaptureService takes its ScriptProcessorNode fallback path — which is all
 * these tests need, since none of them assert on captured audio.
 */
class StubScriptProcessor {
  onaudioprocess: unknown = null;
  connect(): void {}
  disconnect(): void {}
}

class StubAudioContext {
  static created = 0;
  static closed = 0;
  readonly sampleRate = 16000;
  readonly state = "running";
  readonly destination = {};
  constructor() {
    StubAudioContext.created++;
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createScriptProcessor() {
    return new StubScriptProcessor();
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  async close(): Promise<void> {
    StubAudioContext.closed++;
  }
}

const fakeStream = () => ({ getAudioTracks: () => [{ kind: "audio" }] }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("AudioContext", StubAudioContext);
  FakeWebSocket.reset();
  StubAudioContext.created = 0;
  StubAudioContext.closed = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startedSdk(disableInternalPlayback = true) {
  const errors: IErrorPayload[] = [];
  const sdk = new KrispVTSDK({ apiKey: API_KEY, disableInternalPlayback });
  sdk.setHooks({ onError: (e) => void errors.push(e) });
  const pending = sdk.start({ from: "en-US", to: "es-ES" });
  const socket = FakeWebSocket.last!;
  socket.open();
  socket.emitReady();
  await pending;
  return { sdk, socket, errors };
}

/** Binary frames the SDK pushed, ignoring the ClientHello at index 0. */
const uplink = (socket: FakeWebSocket) => socket.sent.slice(1);

describe("process() called twice swaps input without dropping the session", () => {
  it("swaps the input without closing the WebSocket", async () => {
    const { sdk, socket, errors } = await startedSdk();

    await sdk.process(fakeStream());
    await sdk.process(fakeStream());

    // Previously the restart path ran stop(), which closed the socket and then
    // bailed out with SessionNotStarted — a session that looked alive and sent
    // nothing.
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(sdk.getState()).toBe("PROCESSING");
    expect(errors).toEqual([]);
  });

  it("releases the previous capture graph on the swap", async () => {
    const { sdk } = await startedSdk();

    await sdk.process(fakeStream());
    await sdk.process(fakeStream());

    expect(StubAudioContext.created).toBe(2);
    expect(StubAudioContext.closed).toBe(1);
  });

  it("still refuses to process before start()", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY, disableInternalPlayback: true });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    await sdk.process(fakeStream());

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(VtErrorType.SessionNotStarted);
  });
});

describe("sendAudio() accepts the documented PCM forms (#6)", () => {
  it("forwards an ArrayBuffer of PCM16 verbatim", async () => {
    const { sdk, socket } = await startedSdk();
    const buffer = new Int16Array([1, -1, 32767, -32768]).buffer;

    sdk.sendAudio(buffer);

    expect(uplink(socket)).toEqual([buffer]);
    expect(sdk.getState()).toBe("PROCESSING");
  });

  it("forwards an Int16Array", async () => {
    const { sdk, socket } = await startedSdk();
    const pcm = new Int16Array([5, 6, 7]);

    sdk.sendAudio(pcm);

    expect(new Int16Array(uplink(socket)[0] as ArrayBuffer)).toEqual(pcm);
  });

  it("sends only a subarray's own bytes, not its backing buffer", async () => {
    const { sdk, socket } = await startedSdk();
    const backing = new Int16Array([1, 2, 3, 4, 5, 6]);

    sdk.sendAudio(backing.subarray(2, 4));

    const sent = new Int16Array(uplink(socket)[0] as ArrayBuffer);
    expect(Array.from(sent)).toEqual([3, 4]);
  });

  it("converts Float32 samples to PCM16", async () => {
    const { sdk, socket } = await startedSdk();

    sdk.sendAudio(new Float32Array([0, 1, -1]));

    const sent = new Int16Array(uplink(socket)[0] as ArrayBuffer);
    expect(Array.from(sent)).toEqual([0, 32767, -32768]);
  });

  it("ignores an empty chunk without raising an error", async () => {
    const { sdk, socket, errors } = await startedSdk();

    sdk.sendAudio(new Float32Array(0));
    sdk.sendAudio(new ArrayBuffer(0));

    expect(uplink(socket)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("sendAudio() misuse is reported, never thrown", () => {
  it("rejects an odd-length ArrayBuffer as not being PCM16", async () => {
    const { sdk, socket, errors } = await startedSdk();

    expect(() => sdk.sendAudio(new ArrayBuffer(3))).not.toThrow();

    expect(uplink(socket)).toEqual([]);
    expect(errors[0]!.code).toBe(VtErrorType.InvalidInputData);
  });

  it("rejects audio pushed before the session is connected", async () => {
    const errors: IErrorPayload[] = [];
    const sdk = new KrispVTSDK({ apiKey: API_KEY, disableInternalPlayback: true });
    sdk.setHooks({ onError: (e) => void errors.push(e) });

    expect(() => sdk.sendAudio(new Int16Array([1, 2]))).not.toThrow();

    expect(errors[0]!.code).toBe(VtErrorType.SessionNotStarted);
  });

  it("reports once per session, not once per chunk", async () => {
    // sendAudio runs at audio rate; an unlatched error would fire a dozen times a
    // second for as long as the caller keeps pushing.
    const { sdk, errors } = await startedSdk();

    for (let i = 0; i < 50; i++) sdk.sendAudio(new ArrayBuffer(3));

    expect(errors).toHaveLength(1);
  });
});

describe("a session commits to one input path", () => {
  it("rejects sendAudio() after process(), leaving the session alive", async () => {
    const { sdk, socket, errors } = await startedSdk();
    await sdk.process(fakeStream());

    sdk.sendAudio(new Int16Array([1, 2]));

    expect(uplink(socket)).toEqual([]);
    expect(errors[0]!.code).toBe(VtErrorType.InvalidSessionConfigurations);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(sdk.getState()).toBe("PROCESSING");
  });

  it("rejects process() after sendAudio(), leaving the session alive", async () => {
    const { sdk, socket, errors } = await startedSdk();
    sdk.sendAudio(new Int16Array([1, 2]));

    await sdk.process(fakeStream());

    expect(errors[0]!.code).toBe(VtErrorType.InvalidSessionConfigurations);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("clears the committed path on stop()", async () => {
    const { sdk } = await startedSdk();
    sdk.sendAudio(new Int16Array([1, 2]));

    await expect(sdk.stop()).resolves.toEqual({ success: true });

    expect(sdk.getState()).toBe("STOPPED");
  });
});
