import { KrispVTSDK, type VtAudioFormat } from "@krisp.ai/krisp-vt-sdk";
import { elements } from "./elements";
import { state } from "./state";
import {
  showStatus,
  updatePreviewStatus,
  updateKrispSDKStatus,
  showPreviewTranscriptArea,
  handleTranscriptEvent,
  handleTranslateEvent,
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
import {
  createOpusDownlink,
  startOpusUplink,
  type IOpusDownlink,
} from "./opus-io";

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
    const audioFormat = elements.audioFormat.value as VtAudioFormat;
    const isOpus = audioFormat === "opus";

    state.isPreviewModeActive = true;
    elements.previewStartBtn.disabled = true;
    setApiKeyControlsEnabled(false);

    updatePreviewStatus("🎤 Requesting microphone access...");
    state.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: false,
        autoGainControl: true,
        sampleRate: 16000,
      },
      video: false,
    });
    updatePreviewStatus("✅ Microphone ready");

    // Reset and reveal the raw-chunk stats line. Updated below in onRawAudioChunk.
    let rawAudioChunkCount = 0;
    let rawAudioByteCount = 0;
    let accumulatedSeconds = 0;
    elements.rawAudioStats.style.display = "flex";
    elements.rawAudioStatsValue.textContent = "0 chunks · 0 KB · 0.0 s";

    // In Opus mode the SDK only relays packets: decoding and playback are ours.
    let opusDownlink: IOpusDownlink | null = null;
    if (isOpus) {
      opusDownlink = await createOpusDownlink((error) =>
        updatePreviewStatus(`❌ Opus decoder error: ${error.message}`)
      );
      state.opusStop = () => opusDownlink!.stop();
    }

    // Translated audio → mixed with the microphone → speaker. Fed by the SDK's
    // onProcessedAudio in PCM mode, and by our Opus decoder in Opus mode.
    const playTranslated = async (stream: MediaStream) => {
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
          `🎧 Active: ${fromLang} → ${toLang} (${voice} voice, ${audioFormat})`
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
              `🎧 Active: ${fromLang} → ${toLang} (${voice} voice, ${audioFormat})`
            );
            console.log("[PREVIEW] Audio enabled after user interaction");
            document.removeEventListener("click", enableAudio);
          } catch (err) {
            console.error("[PREVIEW] Failed to play audio:", err);
          }
        };

        document.addEventListener("click", enableAudio, { once: true });
      }
    };

    state.krispSDK = new KrispVTSDK(getSdkConfig()).setHooks({
      onConnected: () => {
        updateKrispSDKStatus("connected");
        updatePreviewStatus("🔗 WebSocket connected to translation service");
      },
      // In PCM mode the SDK still drives playback via onProcessedAudio and this
      // hook is purely observational (diagnostics, recording, or a custom
      // pipeline together with `disableInternalPlayback: true`). In Opus mode it
      // is the only downlink: each chunk is one Opus packet for our decoder.
      onRawAudioChunk: (buffer, info) => {
        rawAudioChunkCount += 1;
        rawAudioByteCount += buffer.byteLength;
        if (info.format === "opus") opusDownlink?.feed(buffer);

        // PCM16 = 2 bytes/sample; an Opus packet is a fixed 20 ms of audio.
        const seconds =
          info.format === "opus" ? 0.02 : buffer.byteLength / 2 / info.sampleRate;
        accumulatedSeconds += seconds;
        if (rawAudioChunkCount === 1) {
          console.log(
            `[PREVIEW] First translated audio chunk: ${buffer.byteLength} bytes ` +
              `(${seconds.toFixed(3)}s @ ${info.sampleRate}Hz ${info.format})`
          );
        }
        elements.rawAudioStatsValue.textContent =
          `${rawAudioChunkCount} chunks · ` +
          `${(rawAudioByteCount / 1024).toFixed(1)} KB · ` +
          `${accumulatedSeconds.toFixed(1)} s · ${info.format}`;
      },
      onProcessedAudio: playTranslated,
      onError: (error) => {
        updatePreviewStatus(`❌ Error: ${error.message}`);
        updateKrispSDKStatus("error");
      },
      onTranscript: handleTranscriptEvent,
      onTranslate: handleTranslateEvent,
      onDisconnected: () => updateKrispSDKStatus("disconnected"),
    });

    updatePreviewStatus("⚙️ Creating session and connecting WebSocket...");
    await state.krispSDK.start({
      to: toLang,
      from: fromLang,
      voice: voice as "male" | "female",
      audio: { format: audioFormat, sample_rate: 16000 },
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

    if (isOpus) {
      // The SDK has no Opus codec: process() is rejected, and sendAudio() takes
      // one encoded packet per call. Play the translation through our decoder.
      updatePreviewStatus("🔄 Starting Opus audio capture (WebCodecs)...");
      const sdk = state.krispSDK;
      const stopUplink = await startOpusUplink(
        state.microphoneStream!,
        (packet) => sdk.sendAudio(packet),
        (error) => updatePreviewStatus(`❌ Opus encoder error: ${error.message}`)
      );
      const stopDownlink = state.opusStop;
      state.opusStop = async () => {
        await stopUplink();
        await stopDownlink?.();
      };
      await playTranslated(opusDownlink!.stream);
    } else {
      updatePreviewStatus("🔄 Starting PCM16 audio capture...");
      await state.krispSDK.process(state.microphoneStream!);
    }

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
  elements.rawAudioStats.style.display = "none";
  state.isPreviewModeActive = false;
  updatePreviewStatus("Ready to test translation");
  elements.previewStartBtn.disabled = false;
  elements.previewStopBtn.disabled = true;
  setApiKeyControlsEnabled(true);
});
