import { describe, expect, it, vi } from "vitest";
import { PLAYBACK_WORKLET_SOURCE } from "../src/playback-worklet-source";
import { AudioOutputService } from "../src/audio-output";
import { silentLogger } from "./helpers";

/**
 * The jitter buffer exists twice — inside the playback worklet and, for the
 * ScriptProcessorNode fallback, in src/audio-output.ts. These drive both through
 * the same push/render script and require them to agree sample for sample.
 *
 * The worklet source is a string, so it is evaluated with stubbed
 * AudioWorkletGlobalScope globals to get at the processor.
 */

interface Processor {
  port: { onmessage: ((e: unknown) => void) | null };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

/** Evaluate the worklet source and instantiate its processor. */
function makeProcessor(processorOptions: Record<string, number>): Processor {
  class AudioWorkletProcessorStub {
    port = {
      onmessage: null as ((e: unknown) => void) | null,
      postMessage: () => {},
      close: () => {},
    };
  }

  let Registered: (new (o: unknown) => Processor) | null = null;
  const registerProcessor = (_name: string, cls: unknown) => {
    Registered = cls as new (o: unknown) => Processor;
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    PLAYBACK_WORKLET_SOURCE
  );
  load(AudioWorkletProcessorStub, registerProcessor);

  if (!Registered) throw new Error("worklet source did not register a processor");
  return new Registered({ processorOptions });
}

describe("the worklet source is well-formed", () => {
  it("registers a processor under the expected name", () => {
    expect(PLAYBACK_WORKLET_SOURCE).toContain('registerProcessor("krisp-vt-playback"');
    expect(() => makeProcessor({ prebufferSamples: 128 })).not.toThrow();
  });

  it("contains no template-literal syntax that would break the enclosing string", () => {
    expect(PLAYBACK_WORKLET_SOURCE).not.toContain("${");
    expect(PLAYBACK_WORKLET_SOURCE).not.toContain("`");
  });
});

describe("conformance with the ScriptProcessorNode fallback", () => {
  it("renders identically to the main-thread implementation", async () => {
    const config = { prebufferSamples: 2048, rebufferSamples: 1024, maxQueueSamples: 8192 };

    // Main-thread path: a context with no AudioWorklet forces the fallback.
    let scriptNode: {
      onaudioprocess: ((e: unknown) => void) | null;
      connect(): void;
      disconnect(): void;
    } | null = null;
    class StubCtx {
      readonly sampleRate = 16000;
      async resume() {}
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [] } };
      }
      createScriptProcessor() {
        scriptNode = { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
        return scriptNode;
      }
      async close() {}
    }
    vi.stubGlobal("AudioContext", StubCtx);

    const svc = new AudioOutputService({}, silentLogger, config);
    svc.initOutputStream();
    for (let i = 0; i < 20 && svc.mode === null; i++) await Promise.resolve();
    expect(svc.mode).toBe("scriptprocessor");

    const proc = makeProcessor({ ...config, fadeSamples: 64 });

    const renderMain = (size: number) => {
      const out = new Float32Array(size);
      scriptNode!.onaudioprocess!({ outputBuffer: { getChannelData: () => out } });
      return out;
    };
    const renderWorklet = (size: number) => {
      const out = new Float32Array(size);
      proc.process([], [[out]]);
      return out;
    };

    // Walks the pre-buffer gate, steady drain, underrun and recovery.
    const script: Array<{ push?: number; render: number }> = [
      { push: 512, render: 128 },
      { push: 512, render: 128 },
      { push: 2048, render: 128 },
      { render: 128 },
      { render: 512 },
      { render: 2048 },
      { push: 256, render: 128 },
      { push: 4096, render: 1024 },
      { render: 4096 },
    ];

    for (const [i, step] of script.entries()) {
      if (step.push) {
        const pcm = new Int16Array(step.push);
        for (let s = 0; s < pcm.length; s++) pcm[s] = Math.round(Math.sin(s / 8) * 20000);
        svc.addPCM16Chunk(pcm.buffer.slice(0));

        const asFloat = new Float32Array(pcm.length);
        for (let s = 0; s < pcm.length; s++) asFloat[s] = pcm[s]! / 32768;
        proc.port.onmessage!({ data: { samples: asFloat } });
      }

      expect(
        Array.from(renderWorklet(step.render)),
        `step ${i} diverged`
      ).toEqual(Array.from(renderMain(step.render)));
    }

    svc.cleanup();
    vi.unstubAllGlobals();
  });
});
