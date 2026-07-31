import { describe, expect, it } from "vitest";
import { parseTranscriptEvent, parseTranslateEvent } from "../src/message-parsing";

describe("parseTranscriptEvent", () => {
  it("parses the documented transcript frame", () => {
    // Verbatim from the Server Events section of the README.
    const event = parseTranscriptEvent({
      transcript: {
        text: "Hello, how are you?",
        final: true,
        start: "2026-03-25T19:24:45.370+00:00",
        duration: 436,
        utterance_id: "abc123",
      },
    });

    expect(event).toEqual({
      text: "Hello, how are you?",
      final: true,
      utteranceId: "abc123",
      language: undefined,
      start: "2026-03-25T19:24:45.370+00:00",
      durationMs: 436,
    });
  });

  it("reports an interim result as not final", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hel", final: false } })?.final
    ).toBe(false);
  });

  it("accepts the legacy is_final spelling", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hel", is_final: false } })?.final
    ).toBe(false);
  });

  it("treats an unmarked result as final", () => {
    expect(parseTranscriptEvent({ transcript: { text: "Hi" } })?.final).toBe(true);
  });

  it("passes language through once the server starts sending it", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hi", language: "en-US" } })
        ?.language
    ).toBe("en-US");
  });
});

describe("parseTranslateEvent", () => {
  it("parses the documented translate frame", () => {
    const event = parseTranslateEvent({
      translate: { text: "Hola, ¿cómo estás?", final: true, utterance_id: "abc123" },
    });

    expect(event).toEqual({
      text: "Hola, ¿cómo estás?",
      final: true,
      utteranceId: "abc123",
      language: undefined,
      start: undefined,
      durationMs: undefined,
    });
  });

  it("ignores a transcript-only frame", () => {
    expect(parseTranslateEvent({ transcript: { text: "Hi" } })).toBeNull();
  });
});

describe("malformed and hostile frames yield null, never a throw", () => {
  const cases: Array<[string, unknown]> = [
    ["no transcript key", {}],
    ["transcript is a string", { transcript: "hello" }],
    ["transcript is null", { transcript: null }],
    ["transcript is an array", { transcript: [] }],
    ["transcript is a number", { transcript: 42 }],
    ["text missing", { transcript: { final: true } }],
    ["text is empty", { transcript: { text: "" } }],
    ["text is whitespace only", { transcript: { text: "   " } }],
    ["text is not a string", { transcript: { text: 42 } }],
  ];

  for (const [name, frame] of cases) {
    it(name, () => {
      expect(() =>
        parseTranscriptEvent(frame as Record<string, unknown>)
      ).not.toThrow();
      expect(parseTranscriptEvent(frame as Record<string, unknown>)).toBeNull();
    });
  }
});

describe("field-level type coercion is refused, not guessed", () => {
  it("drops a non-numeric duration rather than coercing it", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hi", duration: "436" } })
        ?.durationMs
    ).toBeUndefined();
  });

  it("drops a NaN duration", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hi", duration: NaN } })
        ?.durationMs
    ).toBeUndefined();
  });

  it("drops a non-string utterance_id", () => {
    expect(
      parseTranscriptEvent({ transcript: { text: "Hi", utterance_id: 42 } })
        ?.utteranceId
    ).toBeUndefined();
  });
});

describe("a single frame carrying both blocks", () => {
  it("yields two independent events", () => {
    const frame = {
      transcript: { text: "Hello", final: true, utterance_id: "u1" },
      translate: { text: "Hola", final: true, utterance_id: "u1" },
    };
    expect(parseTranscriptEvent(frame)?.text).toBe("Hello");
    expect(parseTranslateEvent(frame)?.text).toBe("Hola");
  });
});
