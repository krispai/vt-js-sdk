/**
 * Krisp Voice Translation SDK
 * Public API entry point
 */

export { KrispVTSDK } from "./KrispVTSDK";

export { LogLevel, VtErrorType, VtEventType } from "./types";

export type {
  ISDKStates,
  IStartConfig,
  IVtTranscriptSubscribeConfig,
  IVtFeatures,
  ICustomError,
  IErrorPayload,
  IHooks,
  IRawAudioChunkInfo,
  IAudioOutputConfig,
  VtLanguageInfo,
  IKrispVTSDKConfig,
} from "./types";

export {
  LANGUAGES_URL,
  WS_BASE_URL,
  WS_CONNECT_TIMEOUT_MS,
  SDK_VERSION,
  VOCABULARY_WORD_MIN_LENGTH,
  VOCABULARY_WORD_MAX_LENGTH,
  VOCABULARY_WORD_PATTERN,
  VT_MESSAGES,
} from "./constants";
