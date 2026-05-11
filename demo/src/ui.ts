import { elements } from "./elements";

// ── Demo-only: map raw `onMessage` payloads to transcript columns ─────────────

type TranscriptLine = { text: string; isFinal: boolean; utteranceId?: string };
type TranscriptParts = { original?: TranscriptLine; translated?: TranscriptLine };

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFinalFlag(obj: Record<string, unknown>): boolean {
  const v = obj["final"] ?? obj["is_final"];
  return v !== false;
}

function parseTranscriptPayload(msg: Record<string, unknown>): TranscriptParts {
  const out: TranscriptParts = {};

  if (msg["transcript"] && typeof msg["transcript"] === "object") {
    const t = msg["transcript"] as Record<string, unknown>;
    const text = t["text"] as string;
    if (nonEmptyString(text)) {
      const uid = t["utterance_id"];
      out.original = {
        text,
        isFinal: isFinalFlag(t),
        utteranceId: typeof uid === "string" ? uid : undefined,
      };
    }
  }

  if (msg["translate"] && typeof msg["translate"] === "object") {
    const tr = msg["translate"] as Record<string, unknown>;
    const text = tr["text"] as string;
    if (nonEmptyString(text)) {
      const uid = tr["utterance_id"];
      out.translated = {
        text,
        isFinal: isFinalFlag(tr),
        utteranceId: typeof uid === "string" ? uid : undefined,
      };
    }
  }

  if (!out.original && !out.translated) {
    const isFinal = isFinalFlag(msg);
    const oText = (msg["source_text"] ?? msg["original_text"]) as unknown;
    const trText = (msg["target_text"] ?? msg["translated_text"] ?? msg["translation"]) as unknown;
    if (nonEmptyString(oText)) out.original = { text: oText, isFinal };
    if (nonEmptyString(trText)) out.translated = { text: trText, isFinal };
  }

  return out;
}

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
      parts: TranscriptParts,
      legacy: (type: "original" | "translated", text: string, isFinal: boolean) => void
    ) {
      const o = parts.original;
      const t = parts.translated;
      const oId = o?.utteranceId?.trim() ?? "";
      const tId = t?.utteranceId?.trim() ?? "";

      if (oId || tId) {
        if (oId && tId && oId !== tId) {
          if (o) {
            ensurePair(oId);
            updateUtteranceCell(originalList, translatedList, "original", oId, o.text, o.isFinal);
          }
          if (t) {
            ensurePair(tId);
            updateUtteranceCell(originalList, translatedList, "translated", tId, t.text, t.isFinal);
          }
        } else {
          const id = oId || tId;
          ensurePair(id);
          if (o) updateUtteranceCell(originalList, translatedList, "original", id, o.text, o.isFinal);
          if (t) updateUtteranceCell(originalList, translatedList, "translated", id, t.text, t.isFinal);
        }
      } else {
        if (o) legacy("original", o.text, o.isFinal);
        if (t) legacy("translated", t.text, t.isFinal);
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

export function handlePreviewTranscriptMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  previewTranscriptRows.apply(parseTranscriptPayload(payload as Record<string, unknown>), addPreviewTranscript);
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
