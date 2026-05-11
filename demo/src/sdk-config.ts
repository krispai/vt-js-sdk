import { KrispVTSDK, type VtLanguageInfo, LogLevel } from "@krispai/krisp-vt-sdk";
import { elements } from "./elements";
import { showStatus } from "./ui";

export function getApiKey(): string {
  return elements.krispApiKey.value.trim();
}

export function getSdkConfig() {
  return {
    apiKey: getApiKey(),
    logLevel: LogLevel.DEBUG,
  };
}

export function setApiKeyControlsEnabled(enabled: boolean) {
  elements.krispApiKey.disabled = !enabled;
  elements.loadApiKeyBtn.disabled = !enabled;
}

function populateLanguageSelects(
  languages: VtLanguageInfo[],
  defaultFrom = "en-US",
  defaultTo = "ru-RU"
) {
  const savedFromLang = localStorage.getItem("fromLang") || defaultFrom;
  const savedToLang = localStorage.getItem("toLang") || defaultTo;

  elements.fromLang.innerHTML = "";
  elements.toLang.innerHTML = "";

  languages.forEach((lang) => {
    const fromOption = document.createElement("option");
    fromOption.value = lang.code;
    fromOption.textContent = lang.name;
    if (lang.code === savedFromLang) fromOption.selected = true;
    elements.fromLang.appendChild(fromOption);

    const toOption = document.createElement("option");
    toOption.value = lang.code;
    toOption.textContent = lang.name;
    if (lang.code === savedToLang) toOption.selected = true;
    elements.toLang.appendChild(toOption);
  });

  elements.fromLang.disabled = false;
  elements.toLang.disabled = false;
}

async function loadLanguages() {
  const tempSDK = new KrispVTSDK(getSdkConfig());
  const languages = await tempSDK.getLanguagesList();
  populateLanguageSelects(languages);
  console.log(`[APP] Loaded ${languages.length} languages from API`);
}

elements.loadApiKeyBtn.addEventListener("click", async () => {
  const apiKey = getApiKey();
  if (!apiKey) {
    showStatus("Please enter a Krisp API key", "error");
    return;
  }
  localStorage.setItem("krispApiKey", apiKey);
  showStatus("🔄 Loading languages...", "info");
  try {
    await loadLanguages();
    showStatus("✅ API key loaded and languages fetched", "success");
  } catch (error: any) {
    showStatus(
      `❌ Failed to load languages. Check your API key: ${error.message}`,
      "error"
    );
  }
});
