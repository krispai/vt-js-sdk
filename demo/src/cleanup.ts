import { state } from "./state";
import { updateKrispSDKStatus, clearPreviewTranscripts } from "./ui";

export async function cleanup() {
  try {
    state.isPreviewModeActive = false;

    if (state.previewAudioElement) {
      state.previewAudioElement.pause();
      state.previewAudioElement.srcObject = null;
      state.previewAudioElement = null;
    }

    if (state.audioContext) {
      try {
        if (state.originalGainNode) state.originalGainNode.disconnect();
        if (state.translatedGainNode) state.translatedGainNode.disconnect();
        if (state.mixerDestination) state.mixerDestination.disconnect();
        await state.audioContext.close();
      } catch (error) {
        console.warn("[APP] Audio context cleanup error:", error);
      }
      state.audioContext = null;
      state.originalGainNode = null;
      state.translatedGainNode = null;
      state.mixerDestination = null;
    }

    if (state.krispSDK) {
      await state.krispSDK.stop();
      state.krispSDK = null;
    }

    if (state.microphoneStream) {
      state.microphoneStream.getTracks().forEach((track) => track.stop());
      state.microphoneStream = null;
    }

    updateKrispSDKStatus("disconnected");
    clearPreviewTranscripts();
  } catch (error) {
    console.error("[APP] Cleanup error:", error);
  }
}
