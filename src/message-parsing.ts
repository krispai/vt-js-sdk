import type { IVtTextEvent } from "./types";

/**
 * Defensive parsing of the inbound `transcript` / `translate` frames.
 *
 * Everything here is pure and total: a malformed, partial or hostile frame yields
 * `null`, never a throw. The transport calls these from inside `ws.onmessage`,
 * where an exception would abort message dispatch.
 *
 * Wire shapes (see the Server Events section of the README):
 *   { "transcript": { text, final, start, duration, utterance_id } }
 *   { "translate":  { text, final, utterance_id } }
 */

/** Narrow to a plain object bag, or null. Arrays and null are not bags. */
function asBag(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string with at least one non-whitespace character, else undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A finite number, else undefined. Rejects NaN, Infinity and numeric strings. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read the finality flag, tolerating the legacy `is_final` spelling.
 * Anything other than an explicit `false` on either key means final — an unmarked
 * result is a completed one.
 */
function readFinal(bag: Record<string, unknown>): boolean {
  return bag["final"] !== false && bag["is_final"] !== false;
}

/** Shared field extraction for both event kinds. */
function readEvent(bag: Record<string, unknown>, text: string): IVtTextEvent {
  return {
    text,
    final: readFinal(bag),
    utteranceId: asText(bag["utterance_id"]),
    language: asText(bag["language"]),
    start: asText(bag["start"]),
    durationMs: asFiniteNumber(bag["duration"]),
  };
}

/**
 * Extract the `transcript` block of a frame.
 * Returns null when the frame has no transcript block, or the block carries no
 * usable text.
 */
export function parseTranscriptEvent(
  msg: Record<string, unknown>
): IVtTextEvent | null {
  const bag = asBag(msg["transcript"]);
  if (!bag) return null;
  const text = asText(bag["text"]);
  if (text === undefined) return null;
  return readEvent(bag, text);
}

/** Extract the `translate` block of a frame. Same contract as parseTranscriptEvent. */
export function parseTranslateEvent(
  msg: Record<string, unknown>
): IVtTextEvent | null {
  const bag = asBag(msg["translate"]);
  if (!bag) return null;
  const text = asText(bag["text"]);
  if (text === undefined) return null;
  return readEvent(bag, text);
}
