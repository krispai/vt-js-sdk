/**
 * Uplink audio conversion.
 *
 * Pure — no Web Audio, no DOM, no globals. Every audio input path funnels
 * through here: the capture AudioWorklet, its ScriptProcessorNode fallback, and
 * PCM pushed via `sendAudio`.
 */

/**
 * Float32 samples in [-1, 1] → PCM16 little-endian.
 *
 * Out-of-range values are clamped rather than allowed to wrap. The asymmetric
 * scaling (32768 negative, 32767 positive) maps the full float range onto the
 * full int16 range without clipping -1.0.
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}
