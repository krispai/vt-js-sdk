import type { IErrorPayload, IHooks, ILogger, IAudioOutputConfig } from "./types";
import { VtErrorType } from "./types";
import { VT_MESSAGES } from "./constants";

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
 * The current design mirrors the AudioPlayer used in the rt-inference-gateway
 * demo (which doesn't crackle):
 *   - one continuous-output ScriptProcessorNode connected to a
 *     MediaStreamAudioDestinationNode
 *   - an internal Float32 sample queue
 *   - a pre-buffer fill before output starts
 *   - rebuffer-with-fade on underrun to avoid clicks
 *   - a hard cap on the queue to prevent latency growth if the consumer
 *     pauses the destination
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
  private _initialized: boolean = false;

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
      this._audioContext = new AudioContext({
        sampleRate: AudioOutputService.OUTPUT_SAMPLE_RATE,
      });

      // Resume in case the browser suspended the context (autoplay policy)
      this._audioContext.resume().catch(() => {});

      this._destination = this._audioContext.createMediaStreamDestination();

      // ScriptProcessorNode is deprecated but has near-universal browser support
      // and matches the AudioCaptureService precedent. AudioWorklet migration
      // is a follow-up (it requires shipping a worklet file with the bundle).
      this._processor = this._audioContext.createScriptProcessor(
        AudioOutputService.OUTPUT_BUFFER_SIZE,
        0,
        1
      );
      this._processor.onaudioprocess = (event: AudioProcessingEvent) => {
        this._renderInto(event.outputBuffer.getChannelData(0));
      };
      this._processor.connect(this._destination);

      this._initialized = true;
      this._started = false;
      this._rebuffering = false;
      this._fadeInPending = false;
      this._queue = [];
      this._readOffset = 0;
      this._queuedSamples = 0;

      const outputStream = this._destination.stream;

      this.logger.info("VT Session: Output stream ready", {
        sampleRate: this._audioContext.sampleRate,
        audioTracks: outputStream.getAudioTracks().length,
        prebufferSamples: this._prebufferSamples,
        rebufferSamples: this._rebufferSamples,
        maxQueueSamples: this._maxQueueSamples,
      });

      this.hooks.onProcessedAudio?.(outputStream);
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

  /**
   * Decode an incoming PCM16 ArrayBuffer and enqueue it for playback. The
   * processor pulls from this queue at the AudioContext's render rate, so
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

      this._enqueue(float32);
    } catch (error) {
      this.logger.error("VT Session: Error enqueuing audio chunk:", error);
    }
  }

  /**
   * Clean up AudioContext and release resources.
   */
  cleanup(): void {
    this._initialized = false;
    this._started = false;
    this._rebuffering = false;
    this._fadeInPending = false;
    this._queue = [];
    this._readOffset = 0;
    this._queuedSamples = 0;

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
