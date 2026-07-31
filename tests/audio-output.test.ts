import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioOutputService } from "../src/audio-output";
import { silentLogger } from "./helpers";
import type { IAudioOutputConfig, IHooks } from "../src/types";

/**
 * Covers render-node selection, fallback, staging audio that arrives before the
 * node is ready, and teardown. Jitter-buffer behaviour is asserted in
 * tests/playback-worklet.test.ts.
 */

class StubProcessor {
  onaudioprocess: ((e: unknown) => void) | null = null;
  connect(): void {}
  disconnect(): void {}
}

class StubAudioContext {
  static last: StubAudioContext | null = null;
  readonly sampleRate = 16000;
  processor: StubProcessor | null = null;
  closed = false;
  audioWorklet: { addModule: (u: string) => Promise<void> } | undefined;

  constructor() {
    StubAudioContext.last = this;
    this.audioWorklet = workletOpts.available
      ? {
          addModule: async () => {
            if (workletOpts.addModuleRejects) throw new Error("CSP blocked blob:");
          },
        }
      : undefined;
  }
  async resume(): Promise<void> {}
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [{ kind: "audio" }] } };
  }
  createScriptProcessor() {
    this.processor = new StubProcessor();
    return this.processor;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class StubWorkletNode {
  static last: StubWorkletNode | null = null;
  static options: any = null;
  readonly port = {
    onmessage: null as unknown,
    posted: [] as any[],
    closed: false,
    postMessage(msg: any) {
      this.posted.push(msg);
    },
    close() {
      this.closed = true;
    },
  };
  onprocessorerror: ((e: unknown) => void) | null = null;
  disconnected = false;
  constructor(_ctx: unknown, _name: string, options: unknown) {
    StubWorkletNode.last = this;
    StubWorkletNode.options = options;
  }
  connect(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

const workletOpts = { available: false, addModuleRejects: false };

function pcm16(n: number, value = 0.5): ArrayBuffer {
  return new Int16Array(n).fill(Math.round(value * 32768)).buffer;
}

/**
 * Let the async attach finish. `mode` is set inside the worklet branch, but the
 * staged-chunk flush runs a microtask later when _attachRenderNode resumes — so
 * poll for the mode, then drain a few more microtasks.
 */
async function settle(svc: AudioOutputService): Promise<void> {
  for (let i = 0; i < 20 && svc.mode === null; i++) await Promise.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Build, init, and wait for the render node to attach (attach is async). */
async function start(config?: IAudioOutputConfig, hooks: IHooks = {}) {
  const svc = new AudioOutputService(hooks, silentLogger, config);
  svc.initOutputStream();
  await settle(svc);
  return svc;
}

beforeEach(() => {
  workletOpts.available = false;
  workletOpts.addModuleRejects = false;
  StubAudioContext.last = null;
  StubWorkletNode.last = null;
  vi.stubGlobal("AudioContext", StubAudioContext);
  vi.stubGlobal("Blob", class { constructor(public parts: unknown[]) {} });
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("render node selection", () => {
  it("uses the AudioWorklet when available", async () => {
    workletOpts.available = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);

    const svc = await start();

    expect(svc.mode).toBe("audioworklet");
    expect(StubAudioContext.last!.processor).toBeNull();
  });

  it("falls back when the browser has no AudioWorklet", async () => {
    expect((await start()).mode).toBe("scriptprocessor");
  });

  it("falls back when a CSP rejects the blob module", async () => {
    workletOpts.available = true;
    workletOpts.addModuleRejects = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);

    expect((await start()).mode).toBe("scriptprocessor");
  });

  it("passes the tuning config through to the processor", async () => {
    workletOpts.available = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);

    await start({ prebufferSamples: 8000, maxQueueSamples: 64000 });

    expect(StubWorkletNode.options.processorOptions).toMatchObject({
      prebufferSamples: 8000,
      maxQueueSamples: 64000,
    });
  });
});

describe("delivering audio to the renderer", () => {
  it("posts decoded Float32 to the worklet port", async () => {
    workletOpts.available = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);
    const svc = await start();

    svc.addPCM16Chunk(pcm16(128));

    const posted = StubWorkletNode.last!.port.posted;
    expect(posted).toHaveLength(1);
    expect(posted[0].samples).toBeInstanceOf(Float32Array);
    expect(posted[0].samples.length).toBe(128);
  });

  it("stages audio that arrives while the node is still attaching", async () => {
    // Building an AudioWorklet is async, but addPCM16Chunk is called from the
    // WebSocket handler and cannot wait — early chunks must not be dropped.
    workletOpts.available = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);

    const svc = new AudioOutputService({}, silentLogger);
    svc.initOutputStream();
    svc.addPCM16Chunk(pcm16(128)); // before attach completes
    await settle(svc);

    expect(StubWorkletNode.last!.port.posted).toHaveLength(1);
  });

  it("discards audio that arrives before the output is initialised", () => {
    const svc = new AudioOutputService({}, silentLogger);
    expect(() => svc.addPCM16Chunk(pcm16(100))).not.toThrow();
  });

  it("ignores an empty chunk", async () => {
    const svc = await start();
    expect(() => svc.addPCM16Chunk(new ArrayBuffer(0))).not.toThrow();
  });
});

describe("initOutputStream", () => {
  it("emits the output MediaStream synchronously, before the node attaches", () => {
    const onProcessedAudio = vi.fn();
    new AudioOutputService({ onProcessedAudio }, silentLogger).initOutputStream();

    // The stream comes from the destination node, so consumers can attach it
    // immediately even though the render node is still being built.
    expect(onProcessedAudio).toHaveBeenCalledOnce();
  });

  it("is idempotent — a second call does not build a second context", async () => {
    const svc = await start();
    const first = StubAudioContext.last;
    svc.initOutputStream();

    expect(StubAudioContext.last).toBe(first);
  });

  it("reports a construction failure through onError instead of throwing", () => {
    const onError = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio device");
        }
      }
    );

    expect(() =>
      new AudioOutputService({ onError }, silentLogger).initOutputStream()
    ).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("cleanup", () => {
  it("closes the context and stops accepting audio", async () => {
    const svc = await start();
    const ctx = StubAudioContext.last!;

    svc.cleanup();

    expect(ctx.closed).toBe(true);
    expect(svc.mode).toBeNull();
    expect(() => svc.addPCM16Chunk(pcm16(100))).not.toThrow();
  });

  it("stops and releases the worklet", async () => {
    workletOpts.available = true;
    vi.stubGlobal("AudioWorkletNode", StubWorkletNode);
    const svc = await start();
    const node = StubWorkletNode.last!;

    svc.cleanup();

    expect(node.port.posted).toContainEqual({ type: "stop" });
    expect(node.port.closed).toBe(true);
    expect(node.disconnected).toBe(true);
  });

  it("cancels an attach that is still in flight", async () => {
    const svc = new AudioOutputService({}, silentLogger);
    svc.initOutputStream();
    svc.cleanup(); // before attach resolves
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(svc.mode).toBeNull();
  });

  it("allows a fresh output stream afterwards", async () => {
    const svc = await start();
    const first = StubAudioContext.last;
    svc.cleanup();
    svc.initOutputStream();
    await settle(svc);

    expect(StubAudioContext.last).not.toBe(first);
  });
});
