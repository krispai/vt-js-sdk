import { elements } from "./elements";
import { state } from "./state";

export async function createMixedAudioStream(
  originalStream: MediaStream,
  translatedStream: MediaStream
): Promise<MediaStream | null> {
  try {
    if (state.audioContext) {
      try {
        await state.audioContext.close();
      } catch (e) {
        console.warn("[APP] Error closing previous audio context:", e);
      }
    }

    state.audioContext = new AudioContext({
      sampleRate: 16000,
      latencyHint: "interactive",
    });

    if (state.audioContext.state === "suspended") {
      try {
        await state.audioContext.resume();
        console.log("[APP] Mixed audio context resumed");
      } catch (resumeError) {
        console.warn("[APP] Failed to resume mixed audio context:", resumeError);
      }
    }

    const originalSource =
      state.audioContext.createMediaStreamSource(originalStream);
    const translatedSource =
      state.audioContext.createMediaStreamSource(translatedStream);

    state.originalGainNode = state.audioContext.createGain();
    state.translatedGainNode = state.audioContext.createGain();

    const originalGainPercent = parseInt(elements.originalGain.value);
    const translatedGainPercent = parseInt(elements.translatedGain.value);
    state.originalGainNode.gain.value = originalGainPercent / 100;
    state.translatedGainNode.gain.value = translatedGainPercent / 100;

    console.log(
      `[APP] Mix ratios: Original=${originalGainPercent}%, Translated=${translatedGainPercent}%`
    );

    originalSource.connect(state.originalGainNode);
    translatedSource.connect(state.translatedGainNode);

    state.mixerDestination = state.audioContext.createMediaStreamDestination();

    state.originalGainNode.connect(state.mixerDestination);
    state.translatedGainNode.connect(state.mixerDestination);

    console.log("[APP] Mixed stream created successfully");
    return state.mixerDestination.stream;
  } catch (error) {
    console.error("[APP] Error creating mixed audio stream:", error);
    return null;
  }
}

// Gain slider event listeners
elements.originalGain.addEventListener("input", () => {
  const value = elements.originalGain.value;
  elements.originalGainValue.textContent = `${value}%`;
  localStorage.setItem("originalGain", value);

  const gainValue = parseInt(value) / 100;

  if (state.originalGainNode) {
    state.originalGainNode.gain.value = gainValue;
    console.log(`[APP] Updated original gain to ${value}% (${gainValue})`);
  }
});

elements.translatedGain.addEventListener("input", () => {
  const value = elements.translatedGain.value;
  elements.translatedGainValue.textContent = `${value}%`;
  localStorage.setItem("translatedGain", value);

  const gainValue = parseInt(value) / 100;

  if (state.translatedGainNode) {
    state.translatedGainNode.gain.value = gainValue;
    console.log(`[APP] Updated translated gain to ${value}% (${gainValue})`);
  }
});
