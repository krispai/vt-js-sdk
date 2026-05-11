import type { ILogger } from "./types";

/**
 * Audio capture service.
 *
 * Taps into a MediaStream, resamples to 16 kHz via linear interpolation,
 * converts Float32 samples to PCM16 (signed 16-bit little-endian), and
 * fires onChunk with each ArrayBuffer ready to be sent over WebSocket.
 *
 * Mirrors the AudioCapture class used in the rt-inference-gateway demo.
 */
export class AudioCaptureService {
  private _audioContext: AudioContext | null = null;
  private _source: MediaStreamAudioSourceNode | null = null;
  private _processor: ScriptProcessorNode | null = null;

  constructor(
    private logger: ILogger,
    private onChunk: (buffer: ArrayBuffer) => void
  ) {}

  /**
   * Start capturing audio from the given MediaStream.
   * The stream must contain at least one audio track.
   */
  start(stream: MediaStream): void {
    const targetRate = 16000;

    // Use the browser's native rate; we'll downsample in the processor
    this._audioContext = new AudioContext();
    const nativeRate = this._audioContext.sampleRate;
    const resampleRatio = nativeRate / targetRate;

    this._source = this._audioContext.createMediaStreamSource(stream);

    // ScriptProcessorNode is deprecated but has near-universal browser support.
    // Buffer size of 4096 gives ~85 ms chunks at 48 kHz (matches demo).
    const bufferSize = 4096;
    this._processor = this._audioContext.createScriptProcessor(bufferSize, 1, 1);

    this._processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0); // Float32, native rate

      // Linear-interpolation downsample to targetRate
      const outLen = Math.floor(input.length / resampleRatio);
      const float32 = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const src = i * resampleRatio;
        const idx = Math.floor(src);
        const frac = src - idx;
        const next = Math.min(idx + 1, input.length - 1);
        float32[i] = input[idx]! * (1 - frac) + input[next]! * frac;
      }

      // Float32 → PCM16 little-endian
      const int16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]!));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.onChunk(int16.buffer);
    };

    this._source.connect(this._processor);
    // Connect to destination to keep the processor alive in all browsers
    this._processor.connect(this._audioContext.destination);

    this.logger.info("VT Session: Audio capture started", {
      nativeRate,
      targetRate,
      bufferSize,
    });
  }

  /**
   * Stop capturing and release all Web Audio resources.
   */
  stop(): void {
    try { this._processor?.disconnect(); } catch (_) {}
    try { this._source?.disconnect(); } catch (_) {}
    try { this._audioContext?.close(); } catch (_) {}
    this._processor = null;
    this._source = null;
    this._audioContext = null;
    this.logger.debug("VT Session: Audio capture stopped");
  }
}
