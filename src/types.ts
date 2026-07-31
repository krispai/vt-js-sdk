/**
 * SDK state enumeration (follows javascript-sdk pattern)
 */
export const enum ISDKStates {
  INITIAL = "INITIAL",
  READY = "READY",
  PROCESSING = "PROCESSING",
  CONNECTED = "CONNECTED",
  ERROR = "ERROR",
  STOPPED = "STOPPED",
}

/**
 * Voice Translation Language Info
 */
export interface VtLanguageInfo {
  /** Language code (e.g., "en-US", "fr-FR") */
  code: string;
  /** Language name (e.g., "English (United States)") */
  name: string;
}

/** ClientHello `transcript` block — controls interim / final / translated text events from the server. */
export interface IVtTranscriptSubscribeConfig {
  interim?: boolean;
  final?: boolean;
  translate?: boolean;
}

/** ClientHello `features` block — optional server-side processing features. */
export interface IVtFeatures {
  /** Enable background voice cancellation on the server side. Default: false. */
  background_voice_cancellation?: boolean;
}

export interface IStartConfig {
  from: string;
  to: string;
  voice?: "male" | "female";
  /** Custom vocabulary words for improved STT and translation accuracy */
  vocabulary?: string[];
  /** Custom word-to-word translations (source → target) */
  dictionary?: Record<string, string>;
  /**
   * ClientHello `transcript` subscription, merged over `{ interim: false, final: false, translate: false }`.
   * If omitted, interim + final + translated text are enabled. Pass `{}` to leave all flags off.
   */
  transcript?: IVtTranscriptSubscribeConfig;
  /**
   * Optional server-side processing features. Omitted from ClientHello when not set.
   * All feature flags default to false when unset.
   */
  features?: IVtFeatures;

  /**
   * Optional metadata to be sent to the server.
   * Omitted from ClientHello when not set.
   */
  metadata?: object;
}

/**
 * Audio output tuning.
 *
 * The SDK plays incoming PCM16 through a jitter-buffered queue.
 * Increase the buffers if you observe occasional clicks or rebuffers under
 * heavy main-thread load; decrease them to reduce playback latency.
 *
 * All values are in **samples at 16 kHz** (1000 samples ≈ 62.5 ms).
 */
export interface IAudioOutputConfig {
  /**
   * Samples that must be queued before playback starts (or restarts after
   * an underrun). Default: 4000 (~250 ms).
   */
  prebufferSamples?: number;
  /**
   * If the queue drops below this and runs out, a rebuffer is triggered.
   * Default: 2400 (~150 ms). Must be ≤ prebufferSamples.
   */
  rebufferSamples?: number;
  /**
   * Hard cap on queued samples. Older audio is dropped above this so a
   * paused / slow consumer doesn't grow latency unbounded. Default: 48000 (~3 s).
   */
  maxQueueSamples?: number;
}

export interface IKrispVTSDKConfig {
  apiKey: string;
  logLevel?: LogLevel;
  /**
   * If true, the SDK will not build an internal MediaStream for translated
   * audio playback. Use with `IHooks.onRawAudioChunk` if you want to
   * implement playback yourself (e.g. mixing with the mic, custom buffering,
   * recording to disk). Default: false.
   */
  disableInternalPlayback?: boolean;
  /** Override jitter-buffer / playback tuning. */
  audioOutput?: IAudioOutputConfig;
}

/**
 * VT error type enum
 */
export enum VtErrorType {
  Success = 0,
  ValidationErrorServer = 1,
  ValidationErrorClient = 2,
  InvalidAuthToken = 3,
  InternalErrorServer = 4,
  InternalErrorClient = 5,
  NetworkError = 6,
  SessionNotStarted = 7,
  InvalidSessionConfigurations = 8,
  InvalidInputData = 9,
}

/**
 * VT event type enum
 */
export enum VtEventType {
  InputAllowed = 0,
  InputNotAllowed = 1,
}

export interface ICustomError extends Error {
  code?: VtErrorType;
  context?: Record<string, any>;
}

export interface IErrorPayload {
  code: VtErrorType;
  message: string;
  context?: Record<string, any>;
}

/**
 * Logging levels
 */
export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

export interface ILogger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  setState?(oldState: ISDKStates, newState: ISDKStates): void;
  setLogLevel?(level: LogLevel): void;
}

export interface IErrorHandler {
  emitError(
    error: ICustomError | Error,
    code: VtErrorType,
    context?: Record<string, any>
  ): void;
  setHooks(hooks: IHooks): void;
}

/** Format descriptor passed to onRawAudioChunk so consumers don't need to hardcode it. */
export interface IRawAudioChunkInfo {
  sampleRate: 16000;
  format: "pcm_s16le";
  channels: 1;
}

/**
 * A parsed inbound text event — recognised speech (`onTranscript`) or its
 * translation (`onTranslate`).
 *
 * Optional fields come from a server frame that may omit them: read the
 * **value**, not the key.
 */
export interface IVtTextEvent {
  /** Text exactly as the server sent it, untrimmed. Never empty. */
  text: string;
  /**
   * `false` for an interim result that a later event supersedes, `true` for a
   * completed utterance. Tolerates the legacy `is_final` wire spelling; a frame
   * carrying neither is treated as final.
   */
  final: boolean;
  /** Server-assigned id linking the transcript and translate events of one utterance. */
  utteranceId?: string | undefined;
  /**
   * BCP 47 language tag of `text`. **Not emitted by the server today** — reserved
   * for forward compatibility. The SDK never substitutes the `from` / `to` values
   * passed to `start()`.
   */
  language?: string | undefined;
  /**
   * ISO 8601 start of the audio this event covers, verbatim from the server
   * (e.g. `"2026-03-25T19:24:45.370+00:00"`). Transcript events only.
   */
  start?: string | undefined;
  /** Duration of the covered audio in **milliseconds**. Transcript events only. */
  durationMs?: number | undefined;
}

export interface IHooks {
  onReady?: () => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /**
   * Translated audio as a ready-to-play MediaStream. Attach it to an
   * `<audio>` element via `audio.srcObject = stream`. Not emitted when
   * `IKrispVTSDKConfig.disableInternalPlayback` is true.
   */
  onProcessedAudio?: (stream: MediaStream) => void;
  /**
   * Raw translated PCM16 chunk as it arrives from the server. Useful if you
   * want to do your own playback, mixing, or recording. Always emitted (even
   * when internal playback is enabled) so advanced consumers can tap into the
   * raw stream.
   *
   * `buffer` is a fresh `ArrayBuffer` you may consume / transfer.
   */
  onRawAudioChunk?: (buffer: ArrayBuffer, info: IRawAudioChunkInfo) => void;
  onError?: (error: IErrorPayload) => void;
  /**
   * Recognised speech in the source language, parsed and typed.
   * Requires `IStartConfig.transcript.interim` and/or `.final`.
   */
  onTranscript?: (event: IVtTextEvent) => void;
  /**
   * Translated text in the target language, parsed and typed.
   * Requires `IStartConfig.transcript.translate`. Fires after `onTranscript`
   * when a single frame carries both.
   */
  onTranslate?: (event: IVtTextEvent) => void;
  /**
   * Inbound WebSocket JSON after `JSON.parse` (excluding handled handshake / error frames).
   * Shape is server-defined; the SDK does not interpret transcript vs translate here.
   *
   * Fires for every such frame, before `onTranscript` / `onTranslate`.
   *
   * @deprecated Use `onTranscript` / `onTranslate` instead. Kept for backward
   * compatibility and for frames the SDK does not model yet; will be removed in a
   * future major version.
   */
  onMessage?: (payload: unknown) => void;
}
