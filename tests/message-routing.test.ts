import { afterEach, describe, expect, it, vi } from "vitest";
import { connectTransport } from "./helpers";
import type { IVtTextEvent } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TRANSCRIPT = {
  transcript: { text: "Hello", final: true, utterance_id: "u1" },
};
const TRANSLATE = { translate: { text: "Hola", final: true, utterance_id: "u1" } };

describe("typed hooks fire alongside onMessage", () => {
  it("routes a transcript frame to onTranscript and onMessage", async () => {
    const onTranscript = vi.fn();
    const onTranslate = vi.fn();
    const onMessage = vi.fn();
    const { socket } = await connectTransport({ onTranscript, onTranslate, onMessage });

    socket.emitText(TRANSCRIPT);

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript.mock.calls[0]![0]).toMatchObject({
      text: "Hello",
      final: true,
      utteranceId: "u1",
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("routes a translate frame to onTranslate and onMessage", async () => {
    const onTranscript = vi.fn();
    const onTranslate = vi.fn();
    const onMessage = vi.fn();
    const { socket } = await connectTransport({ onTranscript, onTranslate, onMessage });

    socket.emitText(TRANSLATE);

    expect(onTranslate).toHaveBeenCalledOnce();
    expect(onTranslate.mock.calls[0]![0]).toMatchObject({ text: "Hola" });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("still delivers frames the SDK does not model to onMessage alone", async () => {
    const onTranscript = vi.fn();
    const onTranslate = vi.fn();
    const onMessage = vi.fn();
    const { socket } = await connectTransport({ onTranscript, onTranslate, onMessage });

    socket.emitText({ some_future_event: { value: 1 } });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("keeps handshake and error frames out of every consumer hook", async () => {
    const onTranscript = vi.fn();
    const onTranslate = vi.fn();
    const onMessage = vi.fn();
    const { socket } = await connectTransport({ onTranscript, onTranslate, onMessage });

    socket.emitText({ type: "ready" });
    socket.emitText({ error: { code: 400, reason: "bad", description: "nope" } });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("fires onMessage before the typed hooks", async () => {
    const order: string[] = [];
    const { socket } = await connectTransport({
      onMessage: () => void order.push("onMessage"),
      onTranscript: () => void order.push("onTranscript"),
      onTranslate: () => void order.push("onTranslate"),
    });

    socket.emitText({ ...TRANSCRIPT, ...TRANSLATE });

    expect(order).toEqual(["onMessage", "onTranscript", "onTranslate"]);
  });
});

describe("a throwing consumer hook cannot break dispatch", () => {
  it("still reaches onTranscript when onMessage throws", async () => {
    const onTranscript = vi.fn();
    const { socket } = await connectTransport({
      onMessage: () => {
        throw new Error("consumer blew up");
      },
      onTranscript,
    });

    expect(() => socket.emitText(TRANSCRIPT)).not.toThrow();
    expect(onTranscript).toHaveBeenCalledOnce();
  });

  it("still reaches onTranslate when onTranscript throws", async () => {
    const onTranslate = vi.fn();
    const { socket } = await connectTransport({
      onTranscript: () => {
        throw new Error("consumer blew up");
      },
      onTranslate,
    });

    expect(() => socket.emitText({ ...TRANSCRIPT, ...TRANSLATE })).not.toThrow();
    expect(onTranslate).toHaveBeenCalledOnce();
  });

  it("survives a malformed text frame", async () => {
    const onMessage = vi.fn();
    const { socket } = await connectTransport({ onMessage });

    expect(() => socket.emitText("{")).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("delivers a partial frame to onMessage but not to the typed hooks", async () => {
    const onMessage = vi.fn();
    const onTranscript = vi.fn();
    const { socket } = await connectTransport({ onMessage, onTranscript });

    socket.emitText({ transcript: {} });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe("binary frames", () => {
  it("are forwarded as translated audio, not routed to the text hooks", async () => {
    const onMessage = vi.fn();
    const { socket, audioChunks } = await connectTransport({ onMessage });

    socket.emitBinary(16);

    expect(audioChunks).toHaveLength(1);
    expect(audioChunks[0]!.byteLength).toBe(16);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("hooks registered late still fire (transport level)", () => {
  it("honours a hook added to the hooks object after connect", async () => {
    const { socket, hooks } = await connectTransport();
    const late = vi.fn<(event: IVtTextEvent) => void>();

    hooks.onTranscript = late;
    socket.emitText(TRANSCRIPT);

    expect(late).toHaveBeenCalledOnce();
  });
});
