import type { IErrorPayload, IHooks, ILogger } from "./types";
import { VtErrorType } from "./types";
import { VT_MESSAGES } from "./constants";

/**
 * Audio output service.
 *
 * Creates a Web Audio MediaStreamDestinationNode and emits its stream via the
 * onProcessedAudio hook.  Incoming PCM16 chunks from the WebSocket are decoded
 * and scheduled into the AudioContext so the consumer's MediaStream plays them
 * continuously without audible gaps.
 *
 * Sample rate is 16 kHz to match what the Krisp VT backend sends.
 */
export class AudioOutputService {
  private static readonly OUTPUT_SAMPLE_RATE = 16000;
  /** Initial scheduling offset – gives the jitter buffer a head start. */
  private static readonly SCHEDULE_AHEAD_S = 0.15;

  private _audioContext: AudioContext | null = null;
  private _destination: MediaStreamAudioDestinationNode | null = null;
  private _nextScheduleTime: number = 0;
  private _initialized: boolean = false;

  constructor(private hooks: IHooks, private logger: ILogger) {}

  /**
   * Update hooks reference without recreating audio state.
   */
  setHooks(hooks: IHooks): void {
    this.hooks = hooks;
  }

  /**
   * Create the output AudioContext + MediaStreamDestination and immediately
   * emit the stream via onProcessedAudio.  Must be called before addPCM16Chunk.
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
      this._nextScheduleTime =
        this._audioContext.currentTime + AudioOutputService.SCHEDULE_AHEAD_S;
      this._initialized = true;

      const outputStream = this._destination.stream;

      this.logger.info("VT Session: Output stream ready", {
        sampleRate: this._audioContext.sampleRate,
        audioTracks: outputStream.getAudioTracks().length,
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
   * Decode an incoming PCM16 ArrayBuffer and schedule it for playback.
   * Chunks are scheduled back-to-back so there are no gaps between them.
   */
  addPCM16Chunk(buffer: ArrayBuffer): void {
    if (!this._initialized || !this._audioContext || !this._destination) {
      this.logger.debug("VT Session: Received audio chunk before output init – discarding");
      return;
    }

    try {
      const int16 = new Int16Array(buffer);
      if (int16.length === 0) return;

      // PCM16 → Float32
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i]! / 32768;
      }

      const audioBuffer = this._audioContext.createBuffer(
        1,
        float32.length,
        this._audioContext.sampleRate
      );
      audioBuffer.copyToChannel(float32, 0);

      const source = this._audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._destination);

      // Schedule sequentially, never in the past
      const now = this._audioContext.currentTime;
      const startTime = Math.max(now, this._nextScheduleTime);
      source.start(startTime);
      this._nextScheduleTime = startTime + audioBuffer.duration;
    } catch (error) {
      this.logger.error("VT Session: Error scheduling audio chunk:", error);
    }
  }

  /**
   * Clean up AudioContext and release resources.
   */
  cleanup(): void {
    this._initialized = false;
    this._destination = null;
    this._nextScheduleTime = 0;
    try { this._audioContext?.close(); } catch (_) {}
    this._audioContext = null;
    this.logger.debug("VT Session: Audio output cleaned up");
  }
}
