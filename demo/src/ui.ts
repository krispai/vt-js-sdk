import type { IVtTextEvent } from "@krisp.ai/krisp-vt-sdk";
import { elements } from "./elements";


// ── Shared utterance-pair controller ─────────────────────────────────────────

function escapeUtteranceId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id;
}

function appendPendingPair(
  originalList: HTMLDivElement,
  translatedList: HTMLDivElement,
  utteranceId: string
) {
  const o = document.createElement("div");
  o.dataset.utteranceId = utteranceId;
  o.className = "transcript-entry transcript-pending";
  o.textContent = "\u2007";
  const t = document.createElement("div");
  t.dataset.utteranceId = utteranceId;
  t.className = "transcript-entry transcript-pending";
  t.textContent = "\u2007";
  originalList.appendChild(o);
  translatedList.appendChild(t);
}

function updateUtteranceCell(
  originalList: HTMLDivElement,
  translatedList: HTMLDivElement,
  side: "original" | "translated",
  utteranceId: string,
  text: string,
  isFinal: boolean
) {
  const col = side === "original" ? originalList : translatedList;
  const cell = col.querySelector<HTMLDivElement>(
    `[data-utterance-id="${escapeUtteranceId(utteranceId)}"]`
  );
  if (!cell) return;
  cell.textContent = text;
  cell.classList.remove("transcript-pending");
  cell.classList.toggle("transcript-final", isFinal);
  cell.classList.toggle("transcript-interim", !isFinal);
}

function createUtterancePairController(
  originalList: HTMLDivElement,
  translatedList: HTMLDivElement
) {
  const seen = new Set<string>();

  function ensurePair(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    appendPendingPair(originalList, translatedList, id);
  }

  return {
    reset() {
      seen.clear();
    },
    apply(
      side: "original" | "translated",
      event: IVtTextEvent,
      legacy: (type: "original" | "translated", text: string, isFinal: boolean) => void
    ) {
      const id = event.utteranceId?.trim() ?? "";

      if (id) {
        ensurePair(id);
        updateUtteranceCell(originalList, translatedList, side, id, event.text, event.final);
      } else {
        legacy(side, event.text, event.final);
      }

      originalList.scrollTop = originalList.scrollHeight;
      translatedList.scrollTop = translatedList.scrollHeight;
    },
  };
}

// ── Preview-embedded transcript panel ─────────────────────────────────────────

const previewTranscriptRows = createUtterancePairController(
  elements.previewOriginalTranscripts,
  elements.previewTranslatedTranscripts
);

export function showPreviewTranscriptArea(fromLang: string, toLang: string) {
  elements.previewOriginalLabel.textContent = `🎤 Original (${fromLang})`;
  elements.previewTranslatedLabel.textContent = `🌐 Translated (${toLang})`;
  elements.previewTranscriptArea.style.display = "block";
}

export function clearPreviewTranscripts() {
  elements.previewOriginalTranscripts.innerHTML = "";
  elements.previewTranslatedTranscripts.innerHTML = "";
  previewTranscriptRows.reset();
  elements.previewTranscriptArea.style.display = "none";
}

export function addPreviewTranscript(type: "original" | "translated", text: string, isFinal: boolean) {
  const container = type === "original"
    ? elements.previewOriginalTranscripts
    : elements.previewTranslatedTranscripts;

  if (!isFinal) {
    let interim = container.querySelector<HTMLDivElement>(".transcript-interim");
    if (!interim) {
      interim = document.createElement("div");
      interim.className = "transcript-entry transcript-interim";
      container.appendChild(interim);
    }
    interim.textContent = text;
  } else {
    container.querySelector(".transcript-interim")?.remove();
    const entry = document.createElement("div");
    entry.className = "transcript-entry transcript-final";
    entry.textContent = text;
    container.appendChild(entry);
  }

  container.scrollTop = container.scrollHeight;
}

export function handleTranscriptEvent(event: IVtTextEvent) {
  previewTranscriptRows.apply("original", event, addPreviewTranscript);
}

export function handleTranslateEvent(event: IVtTextEvent) {
  previewTranscriptRows.apply("translated", event, addPreviewTranscript);
}

elements.clearPreviewTranscriptsBtn.addEventListener("click", () => {
  elements.previewOriginalTranscripts.innerHTML = "";
  elements.previewTranslatedTranscripts.innerHTML = "";
  previewTranscriptRows.reset();
});

// ── Status helpers ─────────────────────────────────────────────────────────────

export function showStatus(message: string, type = "info") {
  elements.status.textContent = message;
  elements.status.className = `status status-${type}`;
}

export function updatePreviewStatus(message: string) {
  elements.previewStatus.textContent = message;
}

export function updateKrispSDKStatus(status: string) {
  const statusMap: Record<string, { class: string; text: string }> = {
    connected: { class: "status-connected", text: "🟢 Connected" },
    processing: { class: "status-processing", text: "🟡 Processing" },
    error: { class: "status-disconnected", text: "🔴 Error" },
    disconnected: { class: "status-disconnected", text: "⚪ Disconnected" },
  };
  const { class: className, text } =
    statusMap[status] || statusMap.disconnected;
  elements.sdkStatus.className = `status-indicator ${className}`;
  elements.sdkStatus.querySelector(".status-indicator-value")!.textContent = text;
}
