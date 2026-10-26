import type { IHooks, IStartConfig, ISDKStates, ICustomError, VtLanguageInfo, LogLevel, IKrispVTSDKConfig, VtAudioFormat, IRawAudioChunkInfo } from "./types";
import { ISDKStates as States, VtErrorType } from "./types";
import { WS_CONNECT_TIMEOUT_MS, VT_MESSAGES, VOCABULARY_WORD_MIN_LENGTH, VOCABULARY_WORD_MAX_LENGTH, VOCABULARY_WORD_PATTERN, CAPTURE_SAMPLE_RATE } from "./constants";
import { LoggingService } from "./logging";
import { ErrorHandlingService } from "./error-handling";
import { TranslationAPIService } from "./translation-api";
import { AudioOutputService } from "./audio-output";
import { AudioCaptureService } from "./audio-capture";
import { WebSocketTransportService } from "./websocket-transport";
import { floatToPcm16 } from "./pcm";

/**
 * Main Krisp VT SDK class – orchestrates all SDK functionality.
 *
 * Transport layer: raw WebSocket (PCM16 @ 16 kHz).
 */
/** Format constants emitted with onRawAudioChunk – match the VT backend wire format. */
const RAW_AUDIO_INFO: Readonly<Record<VtAudioFormat, IRawAudioChunkInfo>> =
  Object.freeze({
    pcm_s16le: Object.freeze({
      sampleRate: 16000,
      format: "pcm_s16le",
      channels: 1,
    } as const),
    opus: Object.freeze({
      sampleRate: 16000,
      format: "opus",
      channels: 1,
    } as const),
  });

const SUPPORTED_FORMATS: readonly VtAudioFormat[] = ["pcm_s16le", "opus"];

function toUplinkPcm16(
  pcm: ArrayBuffer | Int16Array | Float32Array | Uint8Array
): ArrayBuffer | null {
  if (pcm instanceof Float32Array) {
    return floatToPcm16(pcm).buffer as ArrayBuffer;
  }

  if (pcm instanceof Int16Array) {
    return pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
      ? (pcm.buffer as ArrayBuffer)
      : (pcm.buffer.slice(
          pcm.byteOffset,
          pcm.byteOffset + pcm.byteLength
        ) as ArrayBuffer);
  }

  if (pcm instanceof ArrayBuffer) {
    return pcm.byteLength % 2 === 0 ? pcm : null;
  }

  return null;
}

/**
 * Normalise a pushed Opus packet. Packets are opaque bytes, so the only
 * accepted forms are an `ArrayBuffer` or a `Uint8Array` view (copied when it
 * does not cover its whole backing buffer). PCM-shaped typed arrays are
 * rejected: they signal the caller forgot the session is in opus mode.
 */
function toUplinkOpus(
  packet: ArrayBuffer | Int16Array | Float32Array | Uint8Array
): ArrayBuffer | null {
  if (packet instanceof Uint8Array) {
    return packet.byteOffset === 0 &&
      packet.byteLength === packet.buffer.byteLength
      ? (packet.buffer as ArrayBuffer)
      : (packet.buffer.slice(
          packet.byteOffset,
          packet.byteOffset + packet.byteLength
        ) as ArrayBuffer);
  }

  if (packet instanceof ArrayBuffer) {
    return packet;
  }

  return null;
}

export class KrispVTSDK {
  private _state: ISDKStates;

  private _apiKey: string;
  private _disableInternalPlayback: boolean;
  private _hooks: IHooks;
  private _logger: LoggingService;
  private _errorHandler: ErrorHandlingService;
  private _translationAPI: TranslationAPIService;
  private _audioOutput: AudioOutputService;
  private _audioCapture: AudioCaptureService | null = null;
  private _wsTransport: WebSocketTransportService | null = null;
  private _inputMode: "stream" | "push" | null = null;
  private _inputErrorReported = false;
  private _format: VtAudioFormat = "pcm_s16le";

  constructor(config: IKrispVTSDKConfig) {
    this._state = States.INITIAL;
    this._apiKey = config.apiKey;
    this._disableInternalPlayback = config.disableInternalPlayback ?? false;
    this._hooks = {
      onReady: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onProcessedAudio: () => {},
      onRawAudioChunk: () => {},
      onError: () => {},
      onMessage: () => {},
      onTranscript: () => {},
      onTranslate: () => {},
    };

    this._logger = new LoggingService(config.logLevel);
    this._errorHandler = new ErrorHandlingService(this._hooks, this._logger);
    this._translationAPI = new TranslationAPIService(
      this._apiKey,
      this._logger,
      this._errorHandler
    );
    this._audioOutput = new AudioOutputService(
      this._hooks,
      this._logger,
      config.audioOutput
    );
  }

  /**
   * Set hook callbacks for SDK events. Chainable.
   */
  setHooks(hooks: Partial<IHooks>): this {
    Object.assign(this._hooks, hooks);
    this._errorHandler.setHooks(this._hooks);
    this._audioOutput.setHooks(this._hooks);
    this._translationAPI.setErrorHandler(this._errorHandler);
    return this;
  }

  /**
   * Set logging level.
   */
  setLogLevel(level: LogLevel): this {
    this._logger.setLogLevel(level);
    return this;
  }

  /**
   * Get current SDK state.
   */
  getState(): ISDKStates {
    return this._state;
  }

  /**
   * Get the list of supported languages for voice translation.
   */
  async getLanguagesList(): Promise<VtLanguageInfo[]> {
    return this._translationAPI.getLanguagesList();
  }

  /**
   * Initialize SDK and connect to the translation service.
   *
   * Opens a raw WebSocket to the Krisp VT endpoint with API key auth,
   * sends a ClientHello, and waits for the server's "ready" message.
   */
  public async start(config: IStartConfig): Promise<void> {
    if (this._state !== States.INITIAL && this._state !== States.ERROR) {
      this._logger.warn(`VT Session: Cannot start – SDK state is ${this._state}`);
      return;
    }

    // ── Validate audio format ──────────────────────────────────────────────
    const format = config.audio?.format ?? "pcm_s16le";
    if (!SUPPORTED_FORMATS.includes(format)) {
      const err = new Error(
        `${VT_MESSAGES.INVALID_FORMAT}, got "${String(config.audio?.format)}"`
      ) as ICustomError;
      err.code = VtErrorType.ValidationErrorClient;
      this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
      throw err;
    }
    this._format = format;

    // ── Validate sample rate ───────────────────────────────────────────────
    // The service accepts 16 kHz only, and the SDK's capture and playback
    // paths are built around it; reject anything else before connecting.
    const sampleRate = config.audio?.sample_rate ?? CAPTURE_SAMPLE_RATE;
    if (sampleRate !== CAPTURE_SAMPLE_RATE) {
      const err = new Error(
        `${VT_MESSAGES.INVALID_SAMPLE_RATE}, got ${String(config.audio?.sample_rate)}`
      ) as ICustomError;
      err.code = VtErrorType.ValidationErrorClient;
      this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
      throw err;
    }

    if (format === "opus" && !this._disableInternalPlayback) {
      this._logger.info(
        "VT Session: format is 'opus' – internal playback is disabled; consume packets via onRawAudioChunk"
      );
    }

    // ── Validate vocabulary ────────────────────────────────────────────────
    if (config.vocabulary?.length) {
      for (const word of config.vocabulary) {
        if (typeof word !== "string") {
          const err = new Error(
            `${VT_MESSAGES.INVALID_VOCABULARY_WORD}: expected string, got ${typeof word}`
          ) as ICustomError;
          err.code = VtErrorType.ValidationErrorClient;
          this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
          throw err;
        }
        const v = this._validateVocabularyWord(word);
        if (!v.valid) {
          const err = new Error(
            `${VT_MESSAGES.INVALID_VOCABULARY_WORD}: "${word}" – ${v.error}`
          ) as ICustomError;
          err.code = VtErrorType.ValidationErrorClient;
          this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
          throw err;
        }
      }
    }

    if (config.dictionary) {
      for (const [key, value] of Object.entries(config.dictionary)) {
        const kv = this._validateVocabularyWord(key);
        if (!kv.valid) {
          const err = new Error(
            `${VT_MESSAGES.INVALID_DICTIONARY_ENTRY}: key "${key}" – ${kv.error}`
          ) as ICustomError;
          err.code = VtErrorType.ValidationErrorClient;
          this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
          throw err;
        }
        if (typeof value !== "string") {
          const err = new Error(
            `${VT_MESSAGES.INVALID_DICTIONARY_ENTRY}: value for "${key}" must be string, got ${typeof value}`
          ) as ICustomError;
          err.code = VtErrorType.ValidationErrorClient;
          this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
          throw err;
        }
        const vv = this._validateVocabularyWord(value);
        if (!vv.valid) {
          const err = new Error(
            `${VT_MESSAGES.INVALID_DICTIONARY_ENTRY}: value "${value}" for key "${key}" – ${vv.error}`
          ) as ICustomError;
          err.code = VtErrorType.ValidationErrorClient;
          this._errorHandler.emitError(err, VtErrorType.ValidationErrorClient);
          throw err;
        }
      }
    }

    this._setState(States.READY);

    // ── Connect WebSocket directly (auth via query param, config via ClientHello) ──
    this._logger.debug("VT Session: Connecting WebSocket...");

    this._wsTransport = new WebSocketTransportService(
      this._hooks,
      this._logger,
      {
        onConnected: () => {
          this._setState(States.CONNECTED);
          this._hooks.onReady?.();
        },
        onDisconnected: () => {
          if (this._state === States.PROCESSING || this._state === States.CONNECTED) {
            this._logger.info("VT Session: WebSocket disconnected unexpectedly");
          }
        },
        onAudioChunk: (buffer: ArrayBuffer) => {
          // Always notify advanced consumers first, with a fresh copy so they
          // can transfer / detach the buffer without affecting playback.
          const rawCb = this._hooks.onRawAudioChunk;
          if (rawCb) {
            try {
              rawCb(buffer.slice(0), RAW_AUDIO_INFO[this._format]);
            } catch (err) {
              this._logger.warn("VT Session: onRawAudioChunk hook threw", err);
            }
          }
          if (this._internalPlaybackEnabled()) {
            this._audioOutput.addPCM16Chunk(buffer);
          }
        },
        onError: (error: Error, code: VtErrorType, context?: Record<string, any>) => {
          this._errorHandler.emitError(error, code, context);
        },
      }
    );

    const connectPromise = this._wsTransport.connect(this._apiKey, config);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${VT_MESSAGES.JOIN_TIMEOUT} after ${WS_CONNECT_TIMEOUT_MS / 1000} seconds`)),
        WS_CONNECT_TIMEOUT_MS
      )
    );

    try {
      await Promise.race([connectPromise, timeoutPromise]);
      this._logger.debug("VT Session: WebSocket connected and ready");
    } catch (e) {
      const error = e as ICustomError;
      this._logger.error(`${VT_MESSAGES.JOIN_FAILED}: ${error.message}`);
      this._setState(States.ERROR);
      this._errorHandler.emitError(error, VtErrorType.InternalErrorServer);
      throw error;
    }
  }

  /**
   * Start processing a MediaStream through the translation service.
   *
   * Captures audio from the stream, converts to PCM16 @ 16 kHz, and streams
   * it over the WebSocket.  Translated audio arrives as binary chunks and is
   * emitted as a MediaStream via the onProcessedAudio hook.
   */
  public async process(stream: MediaStream): Promise<void> {
    if (this._format === "opus") {
      // Internal capture produces PCM16 only; the SDK does not encode Opus.
      this._logger.warn(VT_MESSAGES.OPUS_PROCESS_UNSUPPORTED);
      const err = new Error(VT_MESSAGES.OPUS_PROCESS_UNSUPPORTED) as ICustomError;
      err.code = VtErrorType.InvalidSessionConfigurations;
      this._errorHandler.emitError(err, VtErrorType.InvalidSessionConfigurations);
      return;
    }

    if (this._state === States.INITIAL) {
      this._logger.warn(VT_MESSAGES.SESSION_NOT_STARTED);
      const err = new Error(VT_MESSAGES.SESSION_NOT_STARTED) as ICustomError;
      err.code = VtErrorType.SessionNotStarted;
      this._errorHandler.emitError(err, VtErrorType.SessionNotStarted);
      return;
    }

    if (this._state === States.PROCESSING) {
      if (this._inputMode === "push") {
        this._reportInputError(
          VT_MESSAGES.INPUT_MODE_CONFLICT,
          VtErrorType.InvalidSessionConfigurations
        );
        return;
      }
      this._logger.warn("VT Session: Already processing – swapping the input stream");
      await this._teardownCapture();
    } else if (this._state !== States.CONNECTED) {
      this._logger.warn(VT_MESSAGES.SESSION_NOT_STARTED);
      const err = new Error(VT_MESSAGES.SESSION_NOT_STARTED) as ICustomError;
      err.code = VtErrorType.SessionNotStarted;
      this._errorHandler.emitError(err, VtErrorType.SessionNotStarted);
      return;
    }

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      this._logger.error(VT_MESSAGES.NO_AUDIO_TRACK);
      const err = new Error(VT_MESSAGES.NO_AUDIO_TRACK) as ICustomError;
      err.code = VtErrorType.InvalidInputData;
      this._errorHandler.emitError(err, VtErrorType.InvalidInputData);
      throw err;
    }

    this._inputMode = "stream";
    this._setState(States.PROCESSING);
    this._logger.info("VT Session: Starting audio processing...");

    // Initialise output stream and emit it via onProcessedAudio.
    // Skip if the consumer opted out of internal playback (they are
    // doing their own playback via onRawAudioChunk).
    if (this._internalPlaybackEnabled()) {
      this._audioOutput.initOutputStream();
    }

    // Start capturing input audio and streaming it over the WebSocket
    this._audioCapture = new AudioCaptureService(this._logger, (buffer: ArrayBuffer) => {
      this._wsTransport?.sendAudio(buffer);
    });

    try {
      await this._audioCapture.start(stream);
    } catch (error) {
      this._audioCapture = null;
      this._inputMode = null;
      this._logger.error("VT Session: Failed to start audio capture", error);
      this._errorHandler.emitError(
        error as Error,
        VtErrorType.InternalErrorClient
      );
      throw error;
    }
  }

  /**
   * Push audio yourself instead of handing the SDK a MediaStream via
   * {@link process}. Audio must be **mono at 16 kHz**; for any other rate use
   * {@link process}, which converts for you.
   *
   * Accepted forms with the default `"pcm_s16le"` format:
   * - `ArrayBuffer` — PCM16 little-endian; byte length must be even
   * - `Int16Array` — PCM16; views with a non-zero `byteOffset` are handled
   * - `Float32Array` — normalised samples in [-1, 1]
   *
   * With `format: "opus"` each call carries **one encoded Opus packet** as an
   * `ArrayBuffer` or `Uint8Array`; PCM-shaped typed arrays are rejected.
   *
   * The first call after `start()` resolves moves the session to `PROCESSING` and,
   * unless `disableInternalPlayback` is set, emits the translated output stream via
   * `onProcessedAudio`.
   *
   * A session uses either `process()` or `sendAudio()`, never both; whichever is
   * used second is rejected and the session is left running.
   *
   * **Never throws** — it is called from inside audio callbacks. State and input
   * problems are reported once per session through `onError` and the chunk dropped.
   */
  public sendAudio(
    audio: ArrayBuffer | Int16Array | Float32Array | Uint8Array
  ): void {
    if (this._state !== States.CONNECTED && this._state !== States.PROCESSING) {
      this._reportInputError(
        VT_MESSAGES.SESSION_NOT_STARTED,
        VtErrorType.SessionNotStarted
      );
      return;
    }

    if (this._inputMode === "stream") {
      this._reportInputError(
        VT_MESSAGES.INPUT_MODE_CONFLICT,
        VtErrorType.InvalidSessionConfigurations
      );
      return;
    }

    const buffer =
      this._format === "opus" ? toUplinkOpus(audio) : toUplinkPcm16(audio);
    if (buffer === null) {
      this._reportInputError(
        this._format === "opus"
          ? VT_MESSAGES.INVALID_OPUS_INPUT
          : VT_MESSAGES.INVALID_PCM_INPUT,
        VtErrorType.InvalidInputData
      );
      return;
    }
    if (buffer.byteLength === 0) return;

    if (this._inputMode === null) {
      this._inputMode = "push";
      this._setState(States.PROCESSING);
      this._logger.info("VT Session: Starting audio processing (pushed audio)...");
      if (this._internalPlaybackEnabled()) {
        this._audioOutput.initOutputStream();
      }
    }

    this._wsTransport?.sendAudio(buffer);
  }

  /**
   * Stop processing and clean up all resources.
   */
  public async stop(): Promise<{ success: boolean }> {
    try {
      this._logger.info("VT Session: Stopping...");

      // Stop audio capture
      await this._teardownCapture();
      this._inputMode = null;
      this._inputErrorReported = false;

      // Close WebSocket
      if (this._wsTransport) {
        this._wsTransport.disconnect();
        this._wsTransport = null;
      }

      // Clean up audio output
      this._audioOutput.cleanup();

      this._setState(States.STOPPED);

      this._logger.info("VT Session: Stopped successfully");
      return { success: true };
    } catch (error) {
      this._logger.error(`${VT_MESSAGES.FAILED_TO_STOP}:`, error);
      this._setState(States.ERROR);
      this._errorHandler.emitError(error as Error, VtErrorType.InternalErrorClient, { error });
      throw error;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Internal playback decodes PCM16 only, so it is active unless the consumer
   * opted out or the session streams Opus.
   */
  private _internalPlaybackEnabled(): boolean {
    return !this._disableInternalPlayback && this._format !== "opus";
  }

  /**
   * Release the capture graph without touching the WebSocket, so the session
   * survives an input swap.
   */
  private async _teardownCapture(): Promise<void> {
    if (this._audioCapture) {
      await this._audioCapture.stop();
      this._audioCapture = null;
    }
  }

  private _reportInputError(message: string, code: VtErrorType): void {
    if (this._inputErrorReported) return;
    this._inputErrorReported = true;
    this._logger.warn(message);
    const err = new Error(message) as ICustomError;
    err.code = code;
    this._errorHandler.emitError(err, code);
  }

  private _validateVocabularyWord(word: string): { valid: boolean; error?: string } {
    const trimmed = word.trim();
    if (
      trimmed.length < VOCABULARY_WORD_MIN_LENGTH ||
      trimmed.length > VOCABULARY_WORD_MAX_LENGTH
    ) {
      return {
        valid: false,
        error: `Word must be ${VOCABULARY_WORD_MIN_LENGTH}–${VOCABULARY_WORD_MAX_LENGTH} characters`,
      };
    }
    if (!VOCABULARY_WORD_PATTERN.test(trimmed)) {
      return {
        valid: false,
        error: "Word must contain only letters, digits, or .!?&- (max 3 words, max 2 special chars)",
      };
    }
    return { valid: true };
  }

  private _setState(newState: ISDKStates): void {
    this._logger.setState(this._state, newState);
    this._state = newState;
  }
}
