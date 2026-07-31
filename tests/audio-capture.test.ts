import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioCaptureService } from "../src/audio-capture";
import { silentLogger } from "./helpers";

/**
 * Capture prefers an AudioWorklet and falls back to ScriptProcessorNode. Node has
 * neither a real AudioWorkletGlobalScope nor an audio clock, so both graphs are
 * stubbed and driven by hand to pin path selection, the fallback triggers,
 * teardown ordering and the conversion that feeds the WebSocket.
 */

class StubPort {
  onmessage: ((e: unknown) => void) | null = null;
  posted: unknown[] = [];
  closed = false;
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  /** Simulate the processor handing a block of frames to the main thread. */
  deliver(samples: Float32Array): void {
    this.onmessage?.({ data: { samples } });
  }
}

class StubWorkletNode {
  static last: StubWorkletNode | null = null;
  static options: any = null;
  readonly port = new StubPort();
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

class StubScriptProcessor {
  static last: StubScriptProcessor | null = null;
  static bufferSize = 0;
  onaudioprocess: ((e: unknown) => void) | null = null;
  constructor(bufferSize: number) {
    StubScriptProcessor.last = this;
    StubScriptProcessor.bufferSize = bufferSize;
  }
  connect(): void {}
  disconnect(): void {}
  /** Simulate one render callback carrying `samples`. */
  deliver(samples: Float32Array): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }
}

/** Config knobs for the stub AudioContext, set per test. */
const ctxOpts = {
  rate: 16000,
  state: "running" as string,
  addModuleRejects: false,
  hasAudioWorklet: true,
  throwOnRateHint: false,
};

class StubAudioContext {
  static last: StubAudioContext | null = null;
  static created = 0;
  readonly sampleRate: number;
  state: string;
  readonly destination = {};
  closed = false;
  resumed = false;
  audioWorklet: { addModule: (url: string) => Promise<void> } | undefined;

  constructor(options?: { sampleRate?: number }) {
    // Counted before the throw so a refused rate hint still registers as an attempt.
    StubAudioContext.created++;
    if (options?.sampleRate !== undefined && ctxOpts.throwOnRateHint) {
      throw new Error("NotSupportedError");
    }
    this.sampleRate = ctxOpts.rate;
    this.state = ctxOpts.state;
    this.audioWorklet = ctxOpts.hasAudioWorklet
      ? {
          addModule: async () => {
            if (ctxOpts.addModuleRejects) throw new Error("CSP blocked blob:");
          },
        }
      : undefined;
    StubAudioContext.last = this;
  }
  async resume(): Promise<void> {
    this.resumed = true;
    this.state = "running";
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createScriptProcessor(bufferSize: number) {
    return new StubScriptProcessor(bufferSize);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const stream = {} as MediaStream;

function build() {
  const chunks: ArrayBuffer[] = [];
  const svc = new AudioCaptureService(silentLogger, (b) => void chunks.push(b));
  return { svc, chunks };
}

beforeEach(() => {
  ctxOpts.rate = 16000;
  ctxOpts.state = "running";
  ctxOpts.addModuleRejects = false;
  ctxOpts.hasAudioWorklet = true;
  ctxOpts.throwOnRateHint = false;
  StubAudioContext.last = null;
  StubAudioContext.created = 0;
  StubWorkletNode.last = null;
  StubScriptProcessor.last = null;

  vi.stubGlobal("AudioContext", StubAudioContext);
  vi.stubGlobal("AudioWorkletNode", StubWorkletNode);
  vi.stubGlobal("Blob", class { constructor(public parts: unknown[]) {} });
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe("path selection", () => {
  it("uses the AudioWorklet when it is available", async () => {
    const { svc } = build();
    await svc.start(stream);

    expect(svc.mode).toBe("audioworklet");
    expect(StubWorkletNode.last).not.toBeNull();
    expect(StubScriptProcessor.last).toBeNull();
    await svc.stop();
  });

  it("falls back when the browser has no AudioWorklet", async () => {
    ctxOpts.hasAudioWorklet = false;
    const { svc } = build();
    await svc.start(stream);

    expect(svc.mode).toBe("scriptprocessor");
    await svc.stop();
  });

  it("falls back when a CSP rejects the blob module", async () => {
    ctxOpts.addModuleRejects = true;
    const { svc } = build();
    await svc.start(stream);

    expect(svc.mode).toBe("scriptprocessor");
    expect(StubScriptProcessor.last).not.toBeNull();
    await svc.stop();
  });

  it("falls back when the worklet node fails to construct", async () => {
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new Error("unknown processor");
        }
      }
    );
    const { svc } = build();
    await svc.start(stream);

    expect(svc.mode).toBe("scriptprocessor");
    await svc.stop();
  });
});

describe("AudioContext setup", () => {
  it("requests a 16 kHz context", async () => {
    const { svc } = build();
    await svc.start(stream);

    expect(StubAudioContext.last!.sampleRate).toBe(16000);
    await svc.stop();
  });

  it("falls back to a default context when the rate hint is refused", async () => {
    ctxOpts.throwOnRateHint = true;
    const { svc } = build();

    await expect(svc.start(stream)).resolves.toBeUndefined();
    expect(StubAudioContext.created).toBe(2); // hinted attempt, then default
    await svc.stop();
  });

  it("refuses to capture at any rate other than 16 kHz", async () => {
    // The ClientHello declares sample_rate: 16000 unconditionally and the SDK does
    // not resample, so streaming 48 kHz audio would be read back at triple speed by
    // the server — silent garbage. Fail loudly instead.
    ctxOpts.rate = 48000;
    const { svc } = build();

    await expect(svc.start(stream)).rejects.toThrow(/16 kHz/);
    expect(svc.mode).toBeNull();
  });

  it("closes the rejected context rather than leaking it", async () => {
    ctxOpts.rate = 44100;
    const { svc } = build();

    await svc.start(stream).catch(() => {});

    expect(StubAudioContext.last!.closed).toBe(true);
  });

  it("resumes a suspended context", async () => {
    ctxOpts.state = "suspended";
    const { svc } = build();
    await svc.start(stream);

    expect(StubAudioContext.last!.resumed).toBe(true);
    await svc.stop();
  });

  it("posts a whole number of render quanta per chunk", async () => {
    const { svc } = build();
    await svc.start(stream);

    const frames = StubWorkletNode.options.processorOptions.framesPerPost;
    expect(frames % 128).toBe(0); // never straddles a render quantum
    expect(frames).toBe(1280); // 80 ms at 16 kHz
    await svc.stop();
  });

  it("sizes the fallback buffer for the 16 kHz context", async () => {
    // A hardcoded 4096 would be a 256 ms chunk at this rate.
    ctxOpts.hasAudioWorklet = false;
    const { svc } = build();
    await svc.start(stream);

    expect(StubScriptProcessor.bufferSize).toBe(1024);
    await svc.stop();
  });
});

describe("audio reaches onChunk as PCM16", () => {
  it("emits from the worklet path", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);

    StubWorkletNode.last!.port.deliver(new Float32Array([0, 0.5, -1]));

    expect(chunks).toHaveLength(1);
    expect(Array.from(new Int16Array(chunks[0]!))).toEqual([0, 16384, -32768]);
    await svc.stop();
  });

  it("emits from the ScriptProcessor fallback path", async () => {
    ctxOpts.hasAudioWorklet = false;
    const { svc, chunks } = build();
    await svc.start(stream);

    StubScriptProcessor.last!.deliver(new Float32Array([0, 0.5, -1]));

    expect(Array.from(new Int16Array(chunks[0]!))).toEqual([0, 16384, -32768]);
    await svc.stop();
  });

  it("passes frames straight through — two bytes per sample, no resampling", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);

    StubWorkletNode.last!.port.deliver(new Float32Array(1280));

    expect(chunks[0]!.byteLength).toBe(2560);
    await svc.stop();
  });

  it("ignores an empty block", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);

    StubWorkletNode.last!.port.deliver(new Float32Array(0));

    expect(chunks).toHaveLength(0);
    await svc.stop();
  });

  it("ignores a malformed message from the worklet port", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);

    StubWorkletNode.last!.port.onmessage!({ data: {} });
    StubWorkletNode.last!.port.onmessage!({ data: null });

    expect(chunks).toHaveLength(0);
    await svc.stop();
  });

  it("logs a processor error rather than throwing", async () => {
    const warn = vi.fn();
    const svc = new AudioCaptureService(
      { ...silentLogger, error: warn },
      () => {}
    );
    await svc.start(stream);

    StubWorkletNode.last!.onprocessorerror!(new Error("processor died"));

    expect(warn).toHaveBeenCalledOnce();
    await svc.stop();
  });
});

describe("teardown", () => {
  it("stops the processor, disconnects and closes the context", async () => {
    const { svc } = build();
    await svc.start(stream);
    const node = StubWorkletNode.last!;
    const ctx = StubAudioContext.last!;

    await svc.stop();

    expect(node.port.posted).toEqual([{ type: "stop" }]);
    expect(node.port.closed).toBe(true);
    expect(node.disconnected).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(svc.mode).toBeNull();
  });

  it("drops audio delivered after stop()", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);
    const node = StubWorkletNode.last!;

    await svc.stop();
    node.port.deliver(new Float32Array([0.5, 0.5]));

    expect(chunks).toHaveLength(0);
  });

  it("is safe to call before start()", async () => {
    const { svc } = build();
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it("can be restarted after a stop", async () => {
    const { svc, chunks } = build();
    await svc.start(stream);
    await svc.stop();
    await svc.start(stream);

    StubWorkletNode.last!.port.deliver(new Float32Array([0.5]));

    expect(chunks).toHaveLength(1);
    await svc.stop();
  });
});
