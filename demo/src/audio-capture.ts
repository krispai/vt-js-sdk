/**
 * Demo-side audio capture helper.
 *
 * Taps a MediaStream, resamples to 16 kHz via linear interpolation,
 * converts Float32 → PCM16 (signed 16-bit little-endian), and fires
 * onChunk with each ArrayBuffer ready to pass to sdk.sendAudio().
 *
 * Returns a stop() function to tear down the Web Audio graph.
 */
export function startAudioCapture(
  stream: MediaStream,
  onChunk: (buffer: ArrayBuffer) => void
): () => void {
  const targetRate = 16000;
  const audioCtx = new AudioContext();
  const nativeRate = audioCtx.sampleRate;
  const resampleRatio = nativeRate / targetRate;

  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);

    const outLen = Math.floor(input.length / resampleRatio);
    const float32 = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * resampleRatio;
      const idx = Math.floor(src);
      const frac = src - idx;
      const next = Math.min(idx + 1, input.length - 1);
      float32[i] = input[idx]! * (1 - frac) + input[next]! * frac;
    }

    const int16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]!));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    onChunk(int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  return () => {
    try { processor.disconnect(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    try { audioCtx.close(); } catch (_) {}
  };
}
