import { KrispVTSDK } from "@krispai/krisp-vt-sdk";
import { elements } from "./elements";
import { state } from "./state";
import {
  showStatus,
  updatePreviewStatus,
  updateKrispSDKStatus,
  showPreviewTranscriptArea,
  handlePreviewTranscriptMessage,
  clearPreviewTranscripts,
} from "./ui";
import {
  getApiKey,
  getSdkConfig,
  setApiKeyControlsEnabled,
} from "./sdk-config";
import { createMixedAudioStream } from "./audio-mixer";
import { cleanup } from "./cleanup";
import { vocabConfig } from "./vocab-config";

elements.previewStartBtn.addEventListener("click", async () => {
  if (!getApiKey()) {
    updatePreviewStatus("⚠️ Please enter a Krisp API key first");
    showStatus(
      "⚠️ Please enter and load your Krisp API key before starting",
      "warning"
    );
    return;
  }

  try {
    const fromLang = elements.fromLang.value;
    const toLang = elements.toLang.value;
    const voice = elements.voice.value;

    state.isPreviewModeActive = true;
    elements.previewStartBtn.disabled = true;
    setApiKeyControlsEnabled(false);

    updatePreviewStatus("🎤 Requesting microphone access...");
    state.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        sampleRate: 16000,
      },
      video: false,
    });
    updatePreviewStatus("✅ Microphone ready");

    state.krispSDK = new KrispVTSDK(getSdkConfig()).setHooks({
      onConnected: () => {
        updateKrispSDKStatus("connected");
        updatePreviewStatus("🔗 WebSocket connected to translation service");
      },
      onProcessedAudio: async (stream) => {
        console.log("[PREVIEW] Received translated audio");

        if (state.previewAudioElement) {
          state.previewAudioElement.pause();
          state.previewAudioElement.srcObject = null;
        }

        const originalPercent = elements.originalGain.value;
        const translatedPercent = elements.translatedGain.value;
        console.log(
          `[PREVIEW] Mixing: Original ${originalPercent}% + Translated ${translatedPercent}%`
        );

        const mixedStream = await createMixedAudioStream(
          state.microphoneStream!,
          stream
        );

        state.previewAudioElement = new Audio();
        state.previewAudioElement.srcObject = mixedStream ?? stream;
        state.previewAudioElement.autoplay = true;
        state.previewAudioElement.volume = 1.0;

        try {
          await state.previewAudioElement.play();
          updatePreviewStatus(
            `🎧 Active: ${fromLang} → ${toLang} (${voice} voice)`
          );
        } catch (error) {
          updatePreviewStatus("⚠️ Click anywhere to enable audio playback");
          console.log(
            "[PREVIEW] Autoplay blocked, waiting for user interaction:",
            error
          );

          const previewAudio = state.previewAudioElement;
          const enableAudio = async () => {
            try {
              await previewAudio.play();
              updatePreviewStatus(
                `🎧 Active: ${fromLang} → ${toLang} (${voice} voice)`
              );
              console.log("[PREVIEW] Audio enabled after user interaction");
              document.removeEventListener("click", enableAudio);
            } catch (err) {
              console.error("[PREVIEW] Failed to play audio:", err);
            }
          };

          document.addEventListener("click", enableAudio, { once: true });
        }
      },
      onError: (error) => {
        updatePreviewStatus(`❌ Error: ${error.message}`);
        updateKrispSDKStatus("error");
      },
      onMessage: (msg) => {
        console.log("[PREVIEW] Krisp SDK message:", msg);
        handlePreviewTranscriptMessage(msg);
      },
      onDisconnected: () => updateKrispSDKStatus("disconnected"),
    });

    updatePreviewStatus("⚙️ Creating session and connecting WebSocket...");
    await state.krispSDK.start({
      to: toLang,
      from: fromLang,
      voice: voice as "male" | "female",
      vocabulary: vocabConfig.vocabulary,
      dictionary: vocabConfig.dictionary,
      features: {
        background_voice_cancellation: elements.bvcToggle.checked,
      },
      transcript: {
        interim: elements.transcriptInterim.checked,
        final: elements.transcriptFinal.checked,
        translate: elements.transcriptTranslate.checked,
      },
    });

    showPreviewTranscriptArea(fromLang, toLang);

    updatePreviewStatus("🔄 Starting PCM16 audio capture...");
    await state.krispSDK.process(state.microphoneStream!);

    updatePreviewStatus(`🎤 Speak now to hear translation (streaming via WebSocket)`);
    elements.previewStopBtn.disabled = false;
  } catch (error: any) {
    updatePreviewStatus(`❌ Failed: ${error.message}`);
    state.isPreviewModeActive = false;
    elements.previewStartBtn.disabled = false;
    setApiKeyControlsEnabled(true);
    await cleanup();
  }
});

elements.previewStopBtn.addEventListener("click", async () => {
  updatePreviewStatus("⏹️ Stopping preview...");
  await cleanup();
  clearPreviewTranscripts();
  state.isPreviewModeActive = false;
  updatePreviewStatus("Ready to test translation");
  elements.previewStartBtn.disabled = false;
  elements.previewStopBtn.disabled = true;
  setApiKeyControlsEnabled(true);
});
