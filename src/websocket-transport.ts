import type { IHooks, ILogger, IStartConfig } from "./types";
import { VtErrorType } from "./types";
import { WS_BASE_URL, VT_MESSAGES } from "./constants";

export interface IWebSocketTransportCallbacks {
  onConnected: () => void;
  onDisconnected: () => void;
  onAudioChunk: (buffer: ArrayBuffer) => void;
  onError: (error: Error, code: VtErrorType, context?: Record<string, any>) => void;
}

/**
 * Raw WebSocket transport service for PCM16 audio streaming.
 *
 * Mirrors the rt-inference-gateway VT demo:
 *   1. Opens  wss://<host>/vt?authorization=Api-Key <apiKey>
 *   2. Sends  ClientHello JSON  (config: { audio, source_language, … })
 *   3. Waits for server "ready" message
 *   4. Streams binary PCM16 audio in both directions
 */
export class WebSocketTransportService {
  private _ws: WebSocket | null = null;
  private _resolveConnect: ((value: void) => void) | null = null;
  private _rejectConnect: ((reason?: unknown) => void) | null = null;
  private _connectSettled: boolean = false;

  constructor(
    private hooks: IHooks,
    private logger: ILogger,
    private callbacks: IWebSocketTransportCallbacks
  ) {}

  /**
   * Open the WebSocket, send ClientHello, and wait for the server "ready" message.
   *
   * @param apiKey     Krisp API key – sent as `Api-Key <key>` in the authorization param.
   * @param config     Translation config forwarded as the ClientHello body.
   */
  connect(apiKey: string, config: IStartConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;
      this._connectSettled = false;

      try {
        const wsUrl = this._buildWsUrl(apiKey);
        this.logger.debug("VT Session: Connecting WebSocket:", wsUrl);

        this._ws = new WebSocket(wsUrl);
        this._ws.binaryType = "arraybuffer";

        this._ws.onopen = () => {
          this.logger.debug("VT Session: WebSocket open – sending ClientHello");
          const hello = this._buildClientHello(config);
          this._ws!.send(JSON.stringify(hello));
          this.logger.debug("VT Session: ClientHello sent", hello);
          // Wait for server "ready" before resolving
        };

        this._ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data === "string") {
            this._handleTextMessage(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            this.callbacks.onAudioChunk(event.data);
          }
        };

        this._ws.onclose = (event: CloseEvent) => {
          this.logger.debug("VT Session: WebSocket closed", {
            code: event.code,
            reason: event.reason,
          });
          this.callbacks.onDisconnected();
          this.hooks.onDisconnected?.();
        };

        this._ws.onerror = () => {
          const err = new Error(VT_MESSAGES.WS_CONNECTION_ERROR);
          this._settleConnect(null, err);
          this.callbacks.onError(err, VtErrorType.NetworkError);
        };
      } catch (e) {
        this._settleConnect(null, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Send a binary PCM16 audio chunk over the WebSocket.
   */
  sendAudio(buffer: ArrayBuffer): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(buffer);
    }
  }

  /**
   * Close the WebSocket connection.
   */
  disconnect(): void {
    if (this._ws) {
      try {
        this._ws.close();
      } catch (_) {
        // Ignore errors on close
      }
      this._ws = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Build the WebSocket URL.
   * Pattern: `${WS_BASE_URL}/vt?authorization=Api-Key <apiKey>`
   */
  private _buildWsUrl(apiKey: string): string {
    const base = WS_BASE_URL.replace(/\/+$/, "");
    const auth = encodeURIComponent(`Api-Key ${apiKey}`);
    return `${base}/vt?authorization=${auth}`;
  }

  /** Build the ClientHello JSON payload from the start() config. */
  private _buildClientHello(config: IStartConfig): object {
    const transcriptOff = { interim: false, final: false, translate: false };
    const transcriptOn = { interim: true, final: true, translate: true };
    const transcript = {
      ...transcriptOff,
      ...(config.transcript ?? transcriptOn),
    };
    const cfg: Record<string, unknown> = {
      audio: { format: "pcm_s16le", sample_rate: 16000 },
      source_language: config.from,
      target_language: config.to,
      voice: config.voice ?? "male",
      transcript,
    };

    if (config.vocabulary?.length) {
      cfg["vocabulary"] = config.vocabulary;
    }

    if (config.dictionary && Object.keys(config.dictionary).length > 0) {
      cfg["translation_dictionary"] = Object.entries(config.dictionary).map(
        ([source, target]) => ({ source, target })
      );
    }

    if (config.features && Object.keys(config.features).length > 0) {
      cfg["features"] = config.features;
    }

    return { config: cfg };
  }

  /** Route inbound JSON text messages. */
  private _handleTextMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.logger.warn("VT Session: Received non-JSON text message:", data);
      return;
    }

    this.logger.debug("VT Session: WebSocket message ←", msg);

    // ── Ready signal ───────────────────────────────────────────────────────────
    if (msg["type"] === "ready") {
      this.logger.info("VT Session: WebSocket ready");
      this._settleConnect(undefined, null);
      this.callbacks.onConnected();
      this.hooks.onConnected?.();
      return;
    }

    // ── Server error: { "error": { "code": 400, "reason": "…", "description": "…" } }
    if (msg["error"] && typeof msg["error"] === "object") {
      const serverErr = msg["error"] as Record<string, unknown>;
      const errMsg =
        (serverErr["description"] as string | undefined) ??
        (serverErr["reason"] as string | undefined) ??
        "WebSocket server error";
      const httpCode = typeof serverErr["code"] === "number" ? (serverErr["code"] as number) : undefined;
      this.logger.error("VT Session: WebSocket server error:", serverErr);
      const err = new Error(errMsg);
      this._settleConnect(null, err);
      this.callbacks.onError(err, this._httpCodeToVtError(httpCode), { serverError: serverErr });
      return;
    }

    // ── All other JSON → pass through unchanged (generic payload for the app) ─
    this.hooks.onMessage?.(msg as unknown);
  }

  /** Map an HTTP-style error code from the server to a VtErrorType. */
  private _httpCodeToVtError(code: number | undefined): VtErrorType {
    switch (code) {
      case 400: return VtErrorType.ValidationErrorServer;
      case 401:
      case 402: return VtErrorType.InvalidAuthToken;
      case 429: return VtErrorType.NetworkError;
      case 500:
      default:  return VtErrorType.InternalErrorServer;
    }
  }

  /** Settle the connect() promise exactly once. */
  private _settleConnect(_value: void | undefined | null, error: Error | unknown | null): void {
    if (this._connectSettled) return;
    this._connectSettled = true;
    if (error) {
      this._rejectConnect?.(error);
    } else {
      this._resolveConnect?.();
    }
    this._resolveConnect = null;
    this._rejectConnect = null;
  }
}
