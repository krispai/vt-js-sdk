export interface IElements {
  krispApiKey: HTMLInputElement;
  loadApiKeyBtn: HTMLButtonElement;
  fromLang: HTMLSelectElement;
  toLang: HTMLSelectElement;
  voice: HTMLSelectElement;
  originalGain: HTMLInputElement;
  translatedGain: HTMLInputElement;
  originalGainValue: HTMLSpanElement;
  translatedGainValue: HTMLSpanElement;
  previewStartBtn: HTMLButtonElement;
  previewStopBtn: HTMLButtonElement;
  previewStatus: HTMLDivElement;
  status: HTMLDivElement;
  sdkStatus: HTMLDivElement;
  // Preview-embedded transcripts
  previewTranscriptArea: HTMLDivElement;
  previewOriginalTranscripts: HTMLDivElement;
  previewTranslatedTranscripts: HTMLDivElement;
  previewOriginalLabel: HTMLDivElement;
  previewTranslatedLabel: HTMLDivElement;
  clearPreviewTranscriptsBtn: HTMLButtonElement;
  // Feature toggles
  bvcToggle: HTMLInputElement;
  // Transcript subscription
  transcriptInterim: HTMLInputElement;
  transcriptFinal: HTMLInputElement;
  transcriptTranslate: HTMLInputElement;
}

export const elements: IElements = {
  krispApiKey: document.getElementById("krispApiKey") as HTMLInputElement,
  loadApiKeyBtn: document.getElementById("loadApiKeyBtn") as HTMLButtonElement,
  fromLang: document.getElementById("fromLang") as HTMLSelectElement,
  toLang: document.getElementById("toLang") as HTMLSelectElement,
  voice: document.getElementById("voice") as HTMLSelectElement,
  originalGain: document.getElementById("originalGain") as HTMLInputElement,
  translatedGain: document.getElementById("translatedGain") as HTMLInputElement,
  originalGainValue: document.getElementById("originalGainValue") as HTMLSpanElement,
  translatedGainValue: document.getElementById("translatedGainValue") as HTMLSpanElement,
  previewStartBtn: document.getElementById("previewStartBtn") as HTMLButtonElement,
  previewStopBtn: document.getElementById("previewStopBtn") as HTMLButtonElement,
  previewStatus: document.getElementById("previewStatus") as HTMLDivElement,
  status: document.getElementById("status") as HTMLDivElement,
  sdkStatus: document.getElementById("sdkStatus") as HTMLDivElement,
  previewTranscriptArea: document.getElementById("previewTranscriptArea") as HTMLDivElement,
  previewOriginalTranscripts: document.getElementById("previewOriginalTranscripts") as HTMLDivElement,
  previewTranslatedTranscripts: document.getElementById("previewTranslatedTranscripts") as HTMLDivElement,
  previewOriginalLabel: document.getElementById("previewOriginalLabel") as HTMLDivElement,
  previewTranslatedLabel: document.getElementById("previewTranslatedLabel") as HTMLDivElement,
  clearPreviewTranscriptsBtn: document.getElementById("clearPreviewTranscriptsBtn") as HTMLButtonElement,
  bvcToggle: document.getElementById("bvcToggle") as HTMLInputElement,
  transcriptInterim: document.getElementById("transcriptInterim") as HTMLInputElement,
  transcriptFinal: document.getElementById("transcriptFinal") as HTMLInputElement,
  transcriptTranslate: document.getElementById("transcriptTranslate") as HTMLInputElement,
};
