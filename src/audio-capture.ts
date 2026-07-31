import type { ILogger } from "./types";
import {
  CAPTURE_SAMPLE_RATE,
  CAPTURE_CHUNK_MS,
  VT_MESSAGES,
} from "./constants";
import { floatToPcm16 } from "./pcm";
import {
  CAPTURE_WORKLET_PROCESSOR,
  CAPTURE_WORKLET_SOURCE,
} from "./capture-worklet-source";

/** Which Web Audio node is tapping the microphone. */
export type CaptureMode = "audioworklet" | "scriptprocessor";

/** Frames in one uplink chunk. 16 kHz × 80 ms = 1280. */
const CHUNK_FRAMES = (CAPTURE_SAMPLE_RATE * CAPTURE_CHUNK_MS) / 1000;

/**
 * Frames the worklet accumulates before posting to the main thread. Rounded to a
 * whole number of 128-frame render quanta so a chunk never straddles one.
 */
const FRAMES_PER_POST = Math.max(128, Math.round(CHUNK_FRAMES / 128) * 128);

/**
 * ScriptProcessorNode buffer size for the fallback path. Must be a power of two;
 * 1024 is the nearest one to a 1280-frame chunk (64 ms rather than 80).
 */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024;

/**
 * Audio capture service.
 *
 * Taps a MediaStream, converts it to mono PCM16 at {@link CAPTURE_SAMPLE_RATE},
 * and fires `onChunk` with each ArrayBuffer ready for the WebSocket.
 *
 * Capture runs on an AudioWorklet — off the main thread, so main-thread jank
 * delays a queue drain instead of dropping samples at the audio deadline. The
 * worklet is loaded from a blob URL and does no arithmetic of its own; it
 * accumulates frames and posts them, and the Float32 → PCM16 conversion happens in
 * {@link floatToPcm16}. Where AudioWorklet is unavailable or a strict CSP blocks
 * `blob:`, it falls back to the deprecated ScriptProcessorNode rather than
 * failing to capture at all.
 *
 * The context is requested at 16 kHz and `start()` refuses to run at any other
 * rate.
 */
export class AudioCaptureService {
  private _ctx: AudioContext | null = null;
  private _source: MediaStreamAudioSourceNode | null = null;
  private _worklet: AudioWorkletNode | null = null;
  private _script: ScriptProcessorNode | null = null;
  private _sink: GainNode | null = null;
  private _mode: CaptureMode | null = null;

  /**
   * Bumped by stop(). start() re-checks it after every await, and both audio
   * callbacks check it before doing work, so a stop() landing mid-start can never
   * leave a graph attached to a closing context or emit a late chunk.
   */
  private _generation = 0;

  constructor(
    private logger: ILogger,
    private onChunk: (buffer: ArrayBuffer) => void
  ) {}

  /** Which node is currently tapping the microphone, or null when not capturing. */
  get mode(): CaptureMode | null {
    return this._mode;
  }

  /**
   * Start capturing from the given MediaStream.
   *
   * Resolves once audio is actually flowing, so a caller that awaits it knows the
   * worklet loaded (or that the fallback took over).
   */
  async start(stream: MediaStream): Promise<void> {
    const generation = ++this._generation;

    // Ask for a 16 kHz context so the browser's own resampler does the rate
    // conversion, properly filtered, on the way into the graph. Every current
    // browser honours this; older Safari throws instead of ignoring it.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this._ctx = ctx;

    const rate = ctx.sampleRate;

    // The ClientHello declares sample_rate: 16000 unconditionally, so audio at any
    // other rate would be read back at the wrong speed by the server and produce
    // silent garbage. The SDK does not resample — fail loudly instead.
    if (rate !== CAPTURE_SAMPLE_RATE) {
      await this._discard(ctx);
      this._ctx = null;
      throw new Error(
        `${VT_MESSAGES.UNSUPPORTED_CAPTURE_RATE} (got ${rate} Hz)`
      );
    }

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
      }
      if (generation !== this._generation) return this._discard(ctx);
    }

    this._source = ctx.createMediaStreamSource(stream);

    const startedWorklet = await this._startWorklet(ctx, generation);
    if (generation !== this._generation) return this._discard(ctx);
    if (!startedWorklet) this._startScriptProcessor(ctx, generation);

    this.logger.info("VT Session: Audio capture started", {
      mode: this._mode,
      sampleRate: rate,
    });
  }

  /** Stop capturing and release all Web Audio resources. */
  async stop(): Promise<void> {
    this._generation++;

    const ctx = this._ctx;
    try {
      this._worklet?.port.postMessage({ type: "stop" });
    } catch {
    }
    try {
      this._worklet?.port.close();
    } catch {
    }
    try {
      this._worklet?.disconnect();
    } catch {
    }
    if (this._script) {
      this._script.onaudioprocess = null;
      try {
        this._script.disconnect();
      } catch {
      }
    }
    try {
      this._sink?.disconnect();
    } catch {
    }
    try {
      this._source?.disconnect();
    } catch {
    }

    this._worklet = null;
    this._script = null;
    this._sink = null;
    this._source = null;
    this._mode = null;
    this._ctx = null;

    if (ctx) {
      try {
        await ctx.close();
      } catch {
      }
    }

    this.logger.debug("VT Session: Audio capture stopped");
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _discard(ctx: AudioContext): Promise<void> {
    try {
      await ctx.close();
    } catch {
    }
  }

  /**
   * Try the AudioWorklet path. Returns false — without throwing — when the UA has
   * no AudioWorklet, when a CSP without `blob:` rejects the module, or when the
   * processor fails to construct.
   */
  private async _startWorklet(
    ctx: AudioContext,
    generation: number
  ): Promise<boolean> {
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) {
      this.logger.warn(VT_MESSAGES.AUDIO_WORKLET_UNAVAILABLE, {
        reason: "AudioWorklet not supported",
      });
      return false;
    }

    let url: string | null = null;
    try {
      const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" });
      url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      this.logger.warn(VT_MESSAGES.AUDIO_WORKLET_UNAVAILABLE, err);
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }

    if (generation !== this._generation) return true;

    try {
      const node = new AudioWorkletNode(ctx, CAPTURE_WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { framesPerPost: FRAMES_PER_POST },
      });

      node.port.onmessage = (event: MessageEvent) => {
        if (generation !== this._generation) return;
        const samples = (event.data as { samples?: Float32Array })?.samples;
        if (samples instanceof Float32Array) this._emit(samples);
      };

      node.onprocessorerror = (err) => {
        this.logger.error("VT Session: capture worklet processor error", err);
      };


      const sink = ctx.createGain();
      sink.gain.value = 0;

      this._source!.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      this._worklet = node;
      this._sink = sink;
      this._mode = "audioworklet";
      return true;
    } catch (err) {
      this.logger.warn(VT_MESSAGES.AUDIO_WORKLET_UNAVAILABLE, err);
      return false;
    }
  }

  /** Deprecated main-thread path, kept as the CSP / old-browser fallback. */
  private _startScriptProcessor(ctx: AudioContext, generation: number): void {
    const bufferSize = SCRIPT_PROCESSOR_BUFFER_SIZE;
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (generation !== this._generation) return;
      this._emit(event.inputBuffer.getChannelData(0));
    };

    this._source!.connect(processor);
    processor.connect(ctx.destination);

    this._script = processor;
    this._mode = "scriptprocessor";
    this.logger.debug("VT Session: capture using ScriptProcessorNode", {
      bufferSize,
    });
  }

  /**
   * Shared sink for both capture paths: convert to PCM16 and hand off.
   *
   * `samples` may be a reused Web Audio buffer — it is read synchronously and
   * never retained.
   */
  private _emit(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.onChunk(floatToPcm16(samples).buffer as ArrayBuffer);
  }
}
