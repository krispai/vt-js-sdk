import { elements } from "./elements";

window.addEventListener("load", async () => {
  const savedApiKey = localStorage.getItem("krispApiKey");
  if (savedApiKey) {
    elements.krispApiKey.value = savedApiKey;
  }

  const savedGender = localStorage.getItem("voice");
  if (savedGender) elements.voice.value = savedGender;

  const savedOriginalGain = localStorage.getItem("originalGain");
  if (savedOriginalGain) {
    elements.originalGain.value = savedOriginalGain;
    elements.originalGainValue.textContent = `${savedOriginalGain}%`;
  }

  const savedTranslatedGain = localStorage.getItem("translatedGain");
  if (savedTranslatedGain) {
    elements.translatedGain.value = savedTranslatedGain;
    elements.translatedGainValue.textContent = `${savedTranslatedGain}%`;
  }
});

elements.fromLang.addEventListener("change", () => {
  localStorage.setItem("fromLang", elements.fromLang.value);
});

elements.toLang.addEventListener("change", () => {
  localStorage.setItem("toLang", elements.toLang.value);
});

elements.voice.addEventListener("change", () => {
  localStorage.setItem("voice", elements.voice.value);
});
