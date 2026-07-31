import { describe, expect, it } from "vitest";
import { floatToPcm16 } from "../src/pcm";

describe("floatToPcm16", () => {
  it("maps the full float range onto the full int16 range", () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, -16384]);
  });

  it("clamps rather than wrapping", () => {
    const out = floatToPcm16(new Float32Array([2, -2, 1000, -1000]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });

  it("turns NaN into silence rather than noise", () => {
    expect(floatToPcm16(new Float32Array([NaN]))[0]).toBe(0);
  });

  it("preserves length", () => {
    expect(floatToPcm16(new Float32Array(1280)).length).toBe(1280);
  });

  it("returns an empty array for empty input", () => {
    expect(floatToPcm16(new Float32Array(0)).length).toBe(0);
  });

  it("round-trips a sine to within a couple of quantisation steps", () => {
    // Not exact by construction: positives scale by 32767 and negatives by 32768,
    // so decoding everything by /32768 leaves up to ~1.5 LSB of asymmetry plus
    // half an LSB of rounding.
    const input = Float32Array.from({ length: 256 }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / 16000)
    );
    const out = floatToPcm16(input);

    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(out[i]! / 32768 - input[i]!)).toBeLessThan(2 / 32768);
    }
  });
});
