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

export interface IKrispVTSDKConfig {
  apiKey: string;
  logLevel?: LogLevel;
  /** Overrides the REST API base URL (default: https://api.developers.krisp.ai) */
  baseUrl?: string;
  /** Overrides the WebSocket base URL (default: wss://streaming.krisp.ai) */
  wsBaseUrl?: string;
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

export interface IHooks {
  onReady?: () => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onProcessedAudio?: (stream: MediaStream) => void;
  onError?: (error: IErrorPayload) => void;
  /**
   * Inbound WebSocket JSON after `JSON.parse` (excluding handled handshake / error frames).
   * Shape is server-defined; the SDK does not interpret transcript vs translate here.
   */
  onMessage?: (payload: unknown) => void;
}
