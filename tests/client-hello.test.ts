import { afterEach, describe, expect, it, vi } from "vitest";
import { connectTransport } from "./helpers";
import { CAPTURE_SAMPLE_RATE } from "../src/constants";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a session and return the parsed ClientHello `config` block. */
async function helloConfig(
  config: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  const { socket } = await connectTransport({}, config as never);
  return socket.clientHello()["config"];
}

describe("ClientHello: metadata", () => {
  it("forwards metadata when start() was given some", async () => {
    const cfg = await helloConfig({ metadata: { callId: "abc-123", tier: 2 } });
    expect(cfg["metadata"]).toEqual({ callId: "abc-123", tier: 2 });
  });

  it("omits metadata when start() was not given any", async () => {
    const cfg = await helloConfig();
    expect(cfg).not.toHaveProperty("metadata");
  });

  it("omits metadata when it is an empty object", async () => {
    // IStartConfig.metadata documents "Omitted from ClientHello when not set",
    // and an empty object is not something the caller meant to send.
    const cfg = await helloConfig({ metadata: {} });
    expect(cfg).not.toHaveProperty("metadata");
  });
});

describe("ClientHello: audio block", () => {
  it("declares mono PCM16 at the uplink sample rate", async () => {
    const cfg = await helloConfig();
    expect(cfg["audio"]).toEqual({
      format: "pcm_s16le",
      sample_rate: CAPTURE_SAMPLE_RATE,
    });
  });

  it("maps from/to onto source_language/target_language", async () => {
    const cfg = await helloConfig();
    expect(cfg["source_language"]).toBe("en-US");
    expect(cfg["target_language"]).toBe("es-ES");
  });

  it("defaults voice to male", async () => {
    expect((await helloConfig())["voice"]).toBe("male");
  });
});

describe("ClientHello: transcript subscription merge", () => {
  it("enables interim, final and translate when transcript is omitted", async () => {
    expect((await helloConfig())["transcript"]).toEqual({
      interim: true,
      final: true,
      translate: true,
    });
  });

  it("leaves every flag off for an empty transcript object", async () => {
    expect((await helloConfig({ transcript: {} }))["transcript"]).toEqual({
      interim: false,
      final: false,
      translate: false,
    });
  });

  it("treats a partial transcript object as opt-in, not opt-out", async () => {
    // Subtle and easy to regress: the merge base is all-false, so naming one
    // flag does NOT leave the others at their omitted-case defaults.
    expect(
      (await helloConfig({ transcript: { interim: true } }))["transcript"]
    ).toEqual({ interim: true, final: false, translate: false });
  });
});

describe("ClientHello: optional blocks", () => {
  it("omits vocabulary when empty and forwards it when present", async () => {
    expect(await helloConfig({ vocabulary: [] })).not.toHaveProperty(
      "vocabulary"
    );
    expect((await helloConfig({ vocabulary: ["Krisp"] }))["vocabulary"]).toEqual(
      ["Krisp"]
    );
  });

  it("reshapes dictionary into source/target pairs", async () => {
    const cfg = await helloConfig({ dictionary: { hello: "hola" } });
    expect(cfg["translation_dictionary"]).toEqual([
      { source: "hello", target: "hola" },
    ]);
  });

  it("omits features when empty and forwards it when present", async () => {
    expect(await helloConfig({ features: {} })).not.toHaveProperty("features");
    expect(
      (await helloConfig({ features: { background_voice_cancellation: true } }))[
        "features"
      ]
    ).toEqual({ background_voice_cancellation: true });
  });
});
