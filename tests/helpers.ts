import { vi } from "vitest";
import { WebSocketTransportService } from "../src/websocket-transport";
import type { IHooks, ILogger, IStartConfig } from "../src/types";

// Hard-coded rather than imported from ../src/constants: importing would make the
// assertions tautological, since the expectation would move with the constant.
export const PROD_LANGUAGES_URL =
  "https://api.developers.krisp.ai/v2/sdk/voice-translation/languages";
export const PROD_WS_BASE = "wss://streaming.krisp.ai";
export const API_KEY = "test-api-key";

export const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function stubFetch() {
  const spy = vi.fn(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * A WebSocket stand-in that can actually deliver server frames.
 *
 * `vi.stubGlobal("WebSocket", FakeWebSocket)`, run the code under test, then drive
 * the socket through `FakeWebSocket.last`. The transport installs its handlers
 * synchronously inside `connect()`, so `last` is populated before `connect()`'s
 * promise is awaited.
 *
 * `static OPEN` matters: `WebSocketTransportService.sendAudio` guards on
 * `readyState === WebSocket.OPEN`, and without the static that comparison is
 * against `undefined` and every send is silently dropped.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  static lastUrl = "";
  static last: FakeWebSocket | null = null;

  binaryType = "";
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;

  /** Everything handed to send(), in order. The ClientHello is always [0]. */
  readonly sent: unknown[] = [];

  constructor(url: string) {
    FakeWebSocket.lastUrl = url;
    FakeWebSocket.last = this;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }

  // ── Test drivers ───────────────────────────────────────────────────────────

  /** Open the socket, which makes the transport send its ClientHello. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /**
   * Deliver a server TEXT frame. Objects are JSON-stringified; strings pass
   * through raw so malformed-payload cases can be exercised.
   */
  emitText(payload: unknown): void {
    this.onmessage?.({
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }

  /** Deliver a server BINARY frame of `bytes` zeroed bytes. */
  emitBinary(bytes = 8): void {
    this.onmessage?.({ data: new ArrayBuffer(bytes) });
  }

  /** Deliver the handshake frame so connect() resolves. */
  emitReady(): void {
    this.emitText({ type: "ready" });
  }

  /** The ClientHello, parsed. Call after open(). */
  clientHello(): Record<string, any> {
    return JSON.parse(this.sent[0] as string) as Record<string, any>;
  }

  static reset(): void {
    FakeWebSocket.last = null;
    FakeWebSocket.lastUrl = "";
  }
}

/**
 * Stand up a transport against a FakeWebSocket, driven to the ready state.
 * Returns the transport, the live socket, and the hooks object it was given
 * *by reference* — mutate that object to simulate a late `setHooks`.
 */
export async function connectTransport(
  hooks: IHooks = {},
  config: Partial<IStartConfig> = {}
): Promise<{
  transport: WebSocketTransportService;
  socket: FakeWebSocket;
  hooks: IHooks;
  audioChunks: ArrayBuffer[];
}> {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();

  const audioChunks: ArrayBuffer[] = [];

  const transport = new WebSocketTransportService(hooks, silentLogger, {
    onConnected: () => {},
    onDisconnected: () => {},
    onAudioChunk: (buffer: ArrayBuffer) => {
      audioChunks.push(buffer);
    },
    onError: () => {},
  });

  const pending = transport.connect(
    API_KEY,
    { from: "en-US", to: "es-ES", ...config } as IStartConfig
  );

  const socket = FakeWebSocket.last!;
  socket.open();
  socket.emitReady();
  await pending;

  return { transport, socket, hooks, audioChunks };
}
