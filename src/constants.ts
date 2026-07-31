/**
 * Krisp REST API endpoint for fetching supported languages
 */
export const LANGUAGES_URL =
  "https://api.developers.krisp.ai/v2/sdk/voice-translation/languages";

/**
 * WebSocket base URL for the Krisp VT streaming service.
 * The SDK appends the session path returned by the REST API when the path is relative.
 */
export const WS_BASE_URL = "wss://streaming.krisp.ai";

/**
 * WebSocket connect timeout (milliseconds).
 * Covers the time from opening the socket to receiving the server "ready" message.
 */
export const WS_CONNECT_TIMEOUT_MS = 20000;

/**
 * SDK version
 */
export const SDK_VERSION = "1.1.1";

/**
 * Uplink sample rate, in Hz. The SDK converts every audio input — captured or
 * pushed — to mono PCM16 at this rate before it reaches the WebSocket, and
 * declares it in the ClientHello.
 */
export const CAPTURE_SAMPLE_RATE = 16000;

/**
 * Target duration of one uplink audio chunk, in milliseconds. Sole control over
 * how often the SDK sends on the WebSocket while capturing.
 */
export const CAPTURE_CHUNK_MS = 80;

/**
 * Vocabulary validation constraints
 */
export const VOCABULARY_WORD_MIN_LENGTH = 1;
export const VOCABULARY_WORD_MAX_LENGTH = 120;
// Max 3 words, max 2 special chars (digits or .!?&-), only Unicode letters/digits/.!?&- allowed
export const VOCABULARY_WORD_PATTERN = /^(?=([^\d.!?&-]*[\d.!?&-]){0,2}[^\d.!?&-]*$)[\p{L}\d.!?&-]+(\s[\p{L}\d.!?&-]+){0,2}$/u;

/**
 * VT Session log/error message templates
 */
export const VT_MESSAGES = {
  // Languages endpoint errors
  LANGUAGES_FAILED: "VT Session: Failed to fetch languages",
  LANGUAGES_FAILED_NETWORK: "VT Session: Failed to fetch languages, network error",
  LANGUAGES_INVALID_RESPONSE: "VT Session: Failed to fetch languages, invalid response",

  // WebSocket connection errors
  JOIN_FAILED: "VT Session: Failed to connect WebSocket",
  JOIN_TIMEOUT: "VT Session: WebSocket connect timeout",
  WS_CONNECTION_ERROR: "VT Session: WebSocket connection error",

  // Session errors
  SESSION_NOT_STARTED: "VT Session: Cannot process before session is ready",
  INVALID_CONFIGURATIONS: "VT Session: Invalid session configurations",

  // Input errors
  NO_AUDIO_TRACK: "VT Session: No audio track found in input stream",
  INVALID_PCM_INPUT: "VT Session: sendAudio expects mono PCM16 or Float32 audio",
  INPUT_MODE_CONFLICT:
    "VT Session: a session uses either process() or sendAudio(), not both",

  // Audio capture
  AUDIO_WORKLET_UNAVAILABLE:
    "VT Session: AudioWorklet unavailable – falling back to ScriptProcessorNode",
  UNSUPPORTED_CAPTURE_RATE:
    "VT Session: browser would not provide a 16 kHz capture AudioContext",

  // General
  FAILED_TO_STOP: "VT Session: Failed to stop",
  AUDIO_STREAM_ERROR: "VT Session: Error emitting translated audio stream",

  // Validation errors
  INVALID_VOCABULARY_WORD: "VT Session: Invalid vocabulary word",
  INVALID_DICTIONARY_ENTRY: "VT Session: Invalid dictionary entry",
} as const;
