import type { IErrorPayload, IHooks, ILogger, IAudioOutputConfig } from "./types";
import { VtErrorType } from "./types";
import { VT_MESSAGES } from "./constants";
import {
  PLAYBACK_WORKLET_PROCESSOR,
  PLAYBACK_WORKLET_SOURCE,
} from "./playback-worklet-source";

/**
 * Audio output service.
 *
 * Receives PCM16 chunks from the WebSocket and renders them as a continuous
 * MediaStream via a jitter-buffered pull queue.
 *
 * The previous implementation scheduled one AudioBufferSourceNode per chunk
 * with only 150 ms of lead time. Under main-thread jitter (large React
 * renders, GC, autosize, etc.) the queue would starve, the next chunk would
 * be re-anchored to `currentTime`, and you would hear clicks at every
 * chunk boundary.
 *
 * The current design:
 *   - one continuous-output render node feeding a MediaStreamAudioDestinationNode
 *   - a Float32 sample queue
 *   - a pre-buffer fill before output starts
 *   - rebuffer-with-fade on underrun to avoid clicks
 *   - a hard cap on the queue to prevent latency growth if the consumer
 *     pauses the destination
 *
 * The render node is an AudioWorklet, so playback is pulled on the audio thread
 * rather than the main thread. Because `process()` must fill its output
 * synchronously, the queue lives inside the worklet — see
 * src/playback-worklet-source.ts. The `_enqueue` / `_renderInto` pair below is the
 * main-thread equivalent, driving the ScriptProcessorNode fallback used where
 * AudioWorklet is unavailable or a CSP blocks `blob:`.
 *
 * Sample rate is 16 kHz to match what the Krisp VT backend sends.
 */
export class AudioOutputService {
  private static readonly OUTPUT_SAMPLE_RATE = 16000;

  /** ScriptProcessor render quantum. 2048 = ~128 ms at 16 kHz. */
  private static readonly OUTPUT_BUFFER_SIZE = 2048;

  /** Default pre-buffer (samples) before playback starts. ~250 ms @ 16 kHz. */
  private static readonly DEFAULT_PREBUFFER_SAMPLES = 4000;

  /** Default rebuffer threshold (samples) below which we pause and refill. ~150 ms @ 16 kHz. */
  private static readonly DEFAULT_REBUFFER_SAMPLES = 2400;

  /** Default queue cap (samples) – older audio is dropped above this. ~3 s @ 16 kHz. */
  private static readonly DEFAULT_MAX_QUEUE_SAMPLES = 48000;

  /** Length of fade-in / fade-out (samples) applied at underrun boundaries. */
  private static readonly FADE_SAMPLES = 64;

  private _audioContext: AudioContext | null = null;
  private _destination: MediaStreamAudioDestinationNode | null = null;
  private _processor: ScriptProcessorNode | null = null;
  private _worklet: AudioWorkletNode | null = null;
  private _initialized: boolean = false;

  private _mode: "audioworklet" | "scriptprocessor" | null = null;

  private _pending: Float32Array[] = [];

  /** Invalidates an in-flight attach when cleanup() lands first. */
  private _generation = 0;

  /** FIFO of Float32 sample chunks, already sample-rate-correct. */
  private _queue: Float32Array[] = [];
  /** Read offset within _queue[0]. */
  private _readOffset: number = 0;
  /** Total samples currently buffered across _queue. */
  private _queuedSamples: number = 0;

  /** True once pre-buffer has been satisfied at least once. */
  private _started: boolean = false;
  /** True while waiting for rebuffer after an underrun. */
  private _rebuffering: boolean = false;
  /** Apply a short fade-in on the next non-silent output (after underrun). */
  private _fadeInPending: boolean = false;

  private readonly _prebufferSamples: number;
  private readonly _rebufferSamples: number;
  private readonly _maxQueueSamples: number;

  constructor(
    private hooks: IHooks,
    private logger: ILogger,
    config?: IAudioOutputConfig
  ) {
    this._prebufferSamples = Math.max(
      AudioOutputService.OUTPUT_BUFFER_SIZE,
      config?.prebufferSamples ?? AudioOutputService.DEFAULT_PREBUFFER_SAMPLES
    );
    this._rebufferSamples = Math.max(
      0,
      Math.min(
        this._prebufferSamples,
        config?.rebufferSamples ?? AudioOutputService.DEFAULT_REBUFFER_SAMPLES
      )
    );
    this._maxQueueSamples = Math.max(
      this._prebufferSamples * 2,
      config?.maxQueueSamples ?? AudioOutputService.DEFAULT_MAX_QUEUE_SAMPLES
    );
  }

  /**
   * Update hooks reference without recreating audio state.
   */
  setHooks(hooks: IHooks): void {
    this.hooks = hooks;
  }

  /**
   * Create the output AudioContext + MediaStreamDestination + processor and
   * immediately emit the stream via onProcessedAudio. Must be called before
   * addPCM16Chunk.
   */
  initOutputStream(): void {
    if (this._initialized) {
      this.logger.debug("VT Session: Output stream already initialised – skipping");
      return;
    }

    try {
      const generation = ++this._generation;

      this._audioContext = new AudioContext({
        sampleRate: AudioOutputService.OUTPUT_SAMPLE_RATE,
      });

      // Resume in case the browser suspended the context (autoplay policy)
      this._audioContext.resume().catch(() => {});

      this._destination = this._audioContext.createMediaStreamDestination();

      this._initialized = true;
      this._started = false;
      this._rebuffering = false;
      this._fadeInPending = false;
      this._queue = [];
      this._readOffset = 0;
      this._queuedSamples = 0;
      this._pending = [];

      const outputStream = this._destination.stream;

      this.logger.info("VT Session: Output stream ready", {
        sampleRate: this._audioContext.sampleRate,
        audioTracks: outputStream.getAudioTracks().length,
        prebufferSamples: this._prebufferSamples,
        rebufferSamples: this._rebufferSamples,
        maxQueueSamples: this._maxQueueSamples,
      });

      this.hooks.onProcessedAudio?.(outputStream);
      void this._attachRenderNode(this._audioContext, generation);
    } catch (error) {
      this.logger.error(`${VT_MESSAGES.AUDIO_STREAM_ERROR}:`, error);
      const payload: IErrorPayload = {
        code: VtErrorType.InternalErrorClient,
        message: error instanceof Error ? error.message : String(error),
        context: { error },
      };
      this.hooks.onError?.(payload);
    }
  }

  get mode(): "audioworklet" | "scriptprocessor" | null {
    return this._mode;
  }

  /**
   * Attach a render node: AudioWorklet if possible, ScriptProcessorNode if not.
   * Either way, drain anything that arrived while this was in flight.
   */
  private async _attachRenderNode(
    ctx: AudioContext,
    generation: number
  ): Promise<void> {
    const onWorklet = await this._tryPlaybackWorklet(ctx, generation);
    if (generation !== this._generation) return;

    if (!onWorklet) this._attachScriptProcessor(ctx);
    if (generation !== this._generation) return;

    const staged = this._pending;
    this._pending = [];
    for (const chunk of staged) this._deliver(chunk);
  }

  /**
   * Try the AudioWorklet path. Returns false — without throwing — when the UA has
   * no AudioWorklet, when a CSP without `blob:` rejects the module, or when the
   * processor fails to construct.
   */
  private async _tryPlaybackWorklet(
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
      const blob = new Blob([PLAYBACK_WORKLET_SOURCE], { type: "text/javascript" });
      url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      this.logger.warn(VT_MESSAGES.AUDIO_WORKLET_UNAVAILABLE, err);
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }

    if (generation !== this._generation) return true; // cleanup() won

    try {
      const node = new AudioWorkletNode(ctx, PLAYBACK_WORKLET_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          prebufferSamples: this._prebufferSamples,
          rebufferSamples: this._rebufferSamples,
          maxQueueSamples: this._maxQueueSamples,
          fadeSamples: AudioOutputService.FADE_SAMPLES,
        },
      });

      node.onprocessorerror = (err) => {
        this.logger.error("VT Session: playback worklet processor error", err);
      };

      node.connect(this._destination!);
      this._worklet = node;
      this._mode = "audioworklet";
      this.logger.debug("VT Session: playback using AudioWorklet");
      return true;
    } catch (err) {
      this.logger.warn(VT_MESSAGES.AUDIO_WORKLET_UNAVAILABLE, err);
      return false;
    }
  }

  /** Deprecated main-thread path, kept as the CSP / old-browser fallback. */
  private _attachScriptProcessor(ctx: AudioContext): void {
    const processor = ctx.createScriptProcessor(
      AudioOutputService.OUTPUT_BUFFER_SIZE,
      0,
      1
    );
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      this._renderInto(event.outputBuffer.getChannelData(0));
    };
    processor.connect(this._destination!);

    this._processor = processor;
    this._mode = "scriptprocessor";
    this.logger.debug("VT Session: playback using ScriptProcessorNode");
  }

  /** Hand a decoded block to whichever renderer is attached. */
  private _deliver(samples: Float32Array): void {
    if (this._worklet) {
      this._worklet.port.postMessage({ samples }, [samples.buffer]);
      return;
    }
    if (this._processor) {
      this._enqueue(samples);
      return;
    }
    this._pending.push(samples);
  }

  /**
   * Decode an incoming PCM16 ArrayBuffer and enqueue it for playback. The
   * renderer pulls from the queue at the AudioContext's render rate, so
   * irregular WebSocket arrival cadence is absorbed by the queue.
   */
  addPCM16Chunk(buffer: ArrayBuffer): void {
    if (!this._initialized) {
      this.logger.debug("VT Session: Received audio chunk before output init – discarding");
      return;
    }

    try {
      const int16 = new Int16Array(buffer);
      if (int16.length === 0) return;

      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i]! / 32768;
      }

      this._deliver(float32);
    } catch (error) {
      this.logger.error("VT Session: Error enqueuing audio chunk:", error);
    }
  }

  /**
   * Clean up AudioContext and release resources.
   */
  cleanup(): void {
    this._generation++;

    this._initialized = false;
    this._started = false;
    this._rebuffering = false;
    this._fadeInPending = false;
    this._queue = [];
    this._readOffset = 0;
    this._queuedSamples = 0;
    this._pending = [];
    this._mode = null;

    try { this._worklet?.port.postMessage({ type: "stop" }); } catch (_) {}
    try { this._worklet?.port.close(); } catch (_) {}
    try { this._worklet?.disconnect(); } catch (_) {}
    this._worklet = null;

    if (this._processor) this._processor.onaudioprocess = null;
    try { this._processor?.disconnect(); } catch (_) {}
    this._processor = null;
    this._destination = null;
    try { this._audioContext?.close(); } catch (_) {}
    this._audioContext = null;
    this.logger.debug("VT Session: Audio output cleaned up");
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _enqueue(samples: Float32Array): void {
    this._queue.push(samples);
    this._queuedSamples += samples.length;

    // Cap queue – drop oldest if the consumer is paused / slow. Without
    // this, a paused <audio> element would let the queue grow unbounded
    // and produce huge end-to-end latency on resume.
    while (this._queuedSamples > this._maxQueueSamples && this._queue.length > 0) {
      const head = this._queue[0]!;
      const headRemaining = head.length - this._readOffset;
      if (headRemaining <= this._queuedSamples - this._maxQueueSamples) {
        this._queuedSamples -= headRemaining;
        this._queue.shift();
        this._readOffset = 0;
      } else {
        const toDrop = this._queuedSamples - this._maxQueueSamples;
        this._readOffset += toDrop;
        this._queuedSamples -= toDrop;
        break;
      }
      this.logger.warn(
        "VT Session: Output queue overflow – dropping oldest audio to keep latency bounded"
      );
    }
  }

  /** Pull up to `out.length` samples into `out`, padding with zeros on underrun. */
  private _renderInto(out: Float32Array): void {
    const need = out.length;

    // Decide whether to play this quantum.
    if (!this._started) {
      if (this._queuedSamples >= this._prebufferSamples) {
        this._started = true;
        this._fadeInPending = true;
      } else {
        out.fill(0);
        return;
      }
    } else if (this._rebuffering) {
      if (this._queuedSamples >= this._prebufferSamples) {
        this._rebuffering = false;
        this._fadeInPending = true;
      } else {
        out.fill(0);
        return;
      }
    }

    let written = 0;
    while (written < need && this._queue.length > 0) {
      const head = this._queue[0]!;
      const available = head.length - this._readOffset;
      const take = Math.min(available, need - written);

      // Fast path: copyWithin equivalent via subarray + set
      out.set(head.subarray(this._readOffset, this._readOffset + take), written);
      this._readOffset += take;
      this._queuedSamples -= take;
      written += take;

      if (this._readOffset >= head.length) {
        this._queue.shift();
        this._readOffset = 0;
      }
    }

    if (written < need) {
      // Underrun.
      // 1. Fade out the partial tail to avoid a click.
      if (written > 0) {
        const fadeLen = Math.min(AudioOutputService.FADE_SAMPLES, written);
        for (let i = 0; i < fadeLen; i++) {
          const idx = written - fadeLen + i;
          out[idx] = out[idx]! * (1 - (i + 1) / fadeLen);
        }
      }
      // 2. Zero-fill the rest of the quantum.
      for (let i = written; i < need; i++) out[i] = 0;
      // 3. Enter rebuffering – next non-silent quantum will fade in.
      if (!this._rebuffering) {
        this._rebuffering = true;
        // Don't log on every quantum, only on transition.
        this.logger.debug(
          `VT Session: Output underrun (had ${written}/${need} samples) – rebuffering`
        );
      }
      return;
    }

    if (this._fadeInPending) {
      const fadeLen = Math.min(AudioOutputService.FADE_SAMPLES, out.length);
      for (let i = 0; i < fadeLen; i++) {
        out[i] = out[i]! * ((i + 1) / fadeLen);
      }
      this._fadeInPending = false;
    }

    // Soft check: if the queue has dropped below the rebuffer threshold,
    // arm a rebuffer for the next quantum so we proactively fade out
    // before a hard underrun.
    if (this._queuedSamples < this._rebufferSamples && this._queue.length === 0) {
      // Let the next quantum's underrun branch handle the fade.
    }
  }
}
