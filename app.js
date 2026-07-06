const stateKey = "brain-pdf-bank-v1";
const dbName = "brain-pdf-bank-files";
const fileStore = "files";
const generatedNoteLayoutVersion = "20260624-continuous-paragraph-v2";
const analysisQualityVersion = "20260706-score-explanation-v2";

let state = loadState();
let pendingFiles = [];
let pendingTextPdf = null;
let textTimer = 0;
let openUrls = [];
let autoSyncRunning = false;
let exportMode = false;
let exportBusy = false;
const selectedExportIds = new Set();
const adhdAnalysisCache = new Map();
const pdfTextCache = new Map();

const sync = {
  base: resolveApiBase(),
  status: "checking",
};

const noteInput = document.getElementById("brain-note");
const fileInput = document.getElementById("brain-files");
const saveButton = document.getElementById("brain-save");
const pendingList = document.getElementById("brain-pending");
const vaultList = document.getElementById("brain-vault");
const syncStatus = document.getElementById("brain-sync-status");
const dropzone = document.querySelector("[data-role='dropzone']");
const bankSummary = document.getElementById("brain-summary");
const exportStartButton = document.getElementById("brain-export-start");
const exportActions = document.getElementById("brain-export-actions");
const exportAllButton = document.getElementById("brain-export-all");
const exportDownloadButton = document.getElementById("brain-export-download");
const exportCancelButton = document.getElementById("brain-export-cancel");
const exportCount = document.getElementById("brain-export-count");
const overallLifeScore = document.getElementById("overall-life-score");
const overallScore = document.getElementById("overall-autism-score");
const overallAdhdScore = document.getElementById("overall-adhd-score");
const autismReferenceScores = [
  { score: 96, weight: 3, label: "autism evaluation" },
  { score: 34, weight: 0.5, label: "adhd letter" },
];
const adhdReferenceScores = [
  { score: 96, weight: 3, label: "adhd letter" },
  { score: 26, weight: 0.5, label: "autism evaluation" },
];
const notePdfLayout = Object.freeze({
  width: 612,
  height: 792,
  margin: 40,
  fontSize: 10,
  leading: 14,
});
const notePreviewLayout = Object.freeze({
  width: 612,
  height: 792,
  margin: 40,
  fontSize: 11.5,
  leading: 16,
});
const traitHighlightStyle = Object.freeze({
  autism: { canvas: "#8f3d4b", pdf: "0.56 0.24 0.29 rg" },
  adhd: { canvas: "#214f8f", pdf: "0.13 0.31 0.56 rg" },
  text: { canvas: "#1e2724", pdf: "0.12 0.15 0.14 rg" },
});

noteInput?.addEventListener("input", () => scheduleTextPdf());
fileInput?.addEventListener("change", () => {
  stageFiles([...fileInput.files]);
  fileInput.value = "";
});
saveButton?.addEventListener("click", () => savePending());
exportStartButton?.addEventListener("click", () => setExportMode(true));
exportAllButton?.addEventListener("click", () => toggleAllExportNotes());
exportDownloadButton?.addEventListener("click", () => downloadSelectedNotes());
exportCancelButton?.addEventListener("click", () => setExportMode(false));

dropzone?.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("drag-active");
});
dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("drag-active"));
dropzone?.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("drag-active");
  stageFiles([...event.dataTransfer.files]);
});
dropzone?.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) stageFiles(files);
});

renderSyncStatus();
renderPending();
renderOverallLifeScore();
renderOverallScore();
renderOverallAdhdScore();
renderBankSummary();
renderExportToolbar();
renderVault();
void initSync();

function resolveApiBase() {
  const configured = window.BRAIN_API_BASE;
  if (configured) return String(configured).replace(/\/+$/, "");
  const host = window.location.hostname;
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return window.location.origin;
  if (host.endsWith(".up.railway.app")) return window.location.origin;
  return "https://brain-aolabs-io-production.up.railway.app";
}

async function initSync() {
  if (!sync.base) {
    markSyncLocal();
    return;
  }
  try {
    const response = await fetch(`${sync.base}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`health ${response.status}`);
    await response.json();
    sync.status = "connected";
    renderSyncStatus();
    await refreshSyncFiles();
    await autoSyncLocalRecords();
  } catch {
    markSyncLocal();
  }
}

function markSyncLocal() {
  sync.status = "local";
  renderSyncStatus();
}

function renderSyncStatus() {
  if (!syncStatus) return;
  if (sync.status === "connected" && autoSyncRunning) {
    syncStatus.textContent = "sync connected - syncing device entries";
  } else if (sync.status === "connected") {
    syncStatus.textContent = "sync connected - entries are shared";
  } else if (sync.status === "checking") {
    syncStatus.textContent = "checking sync";
  } else {
    syncStatus.textContent = "sync not connected - saved on this device";
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(stateKey) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistState() {
  const localOnly = state.filter((item) => item.source !== "sync");
  localStorage.setItem(stateKey, JSON.stringify(localOnly.slice(0, 500)));
}

function scheduleTextPdf() {
  window.clearTimeout(textTimer);
  textTimer = window.setTimeout(convertTextToPendingPdf, 140);
}

function convertTextToPendingPdf() {
  const text = noteInput?.value || "";
  const sourceText = textPdfSource(text);
  if (!sourceText) {
    pendingTextPdf = null;
    renderPending();
    return;
  }
  const createdAt = new Date().toISOString();
  const name = `brain-text-${stampForName(createdAt)}.pdf`;
  const autism = analyzeAutismText(sourceText);
  const adhd = analyzeAdhdText(sourceText);
  const lifeLeverage = analyzeLifeLeverageText(sourceText);
  const highlights = { autism: autism.highlightText, adhd: adhd.highlightText };
  const result = createTextPdf(sourceText, createdAt, highlights);
  const previewDataUrl = createTextPreviewDataUrl(sourceText, createdAt, highlights);
  pendingTextPdf = {
    id: `text-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    mime: "application/pdf",
    size: result.blob.size,
    createdAt,
    sourceCreatedAt: createdAt,
    kind: "generated pdf",
    pages: result.pages,
    previewDataUrl,
    autismScore: autism.score,
    autismScoreExplanation: autism.explanation,
    autismHighlightText: autism.highlightText,
    autismHighlightExplanation: autism.highlightExplanation,
    autismScoreSource: autism.scoreSource || "heuristic",
    autismScoreModel: autism.scoreModel || "browser heuristic",
    autismScoreConfidence: autism.scoreConfidence || "low",
    autismScoreWarning: autism.scoreWarning || "preview only; saved score is re-analyzed when sync is connected",
    autismTextChars: autism.textChars || sourceText.length,
    adhdScore: adhd.score,
    adhdScoreExplanation: adhd.explanation,
    adhdHighlightText: adhd.highlightText,
    adhdHighlightExplanation: adhd.highlightExplanation,
    adhdScoreSource: adhd.scoreSource || "heuristic",
    adhdScoreModel: adhd.scoreModel || "browser heuristic",
    adhdScoreConfidence: adhd.scoreConfidence || "low",
    adhdScoreWarning: adhd.scoreWarning || "preview only; saved score is re-analyzed when sync is connected",
    adhdTextChars: adhd.textChars || sourceText.length,
    lifeLeverageScore: lifeLeverage.score,
    lifeLeverageExplanation: lifeLeverage.explanation,
    lifeLeverageHighlightText: lifeLeverage.highlightText,
    lifeLeverageHighlightExplanation: lifeLeverage.highlightExplanation,
    lifeLeverageScoreSource: lifeLeverage.scoreSource || "heuristic",
    lifeLeverageScoreModel: lifeLeverage.scoreModel || "browser heuristic",
    lifeLeverageScoreConfidence: lifeLeverage.scoreConfidence || "low",
    lifeLeverageScoreWarning: lifeLeverage.scoreWarning || "preview only; saved score is re-analyzed when sync is connected",
    lifeLeverageTextChars: lifeLeverage.textChars || sourceText.length,
    generatedNoteLayoutVersion,
    analysisQualityVersion,
    sourceText,
    blob: result.blob,
  };
  renderPending();
}

function stageFiles(files) {
  pendingFiles = [...pendingFiles, ...files].slice(-24);
  renderPending();
}

async function savePending() {
  const textFile = pendingTextPdf;
  const files = [...pendingFiles];
  if (!textFile && !files.length) return;
  setSaveBusy(true, "analyzing");
  const nextRecords = [];
  try {
    if (textFile) {
      nextRecords.push(await saveFileLike(await withAiAnalysis(textFile, textFile.sourceText || "")));
      pendingTextPdf = null;
      if (noteInput) noteInput.value = "";
    }
    for (const file of files) {
      const readableText = await readableUploadText(file);
      const analysis = await analyzeRecordText({
        name: file.name || "uploaded file",
        mime: file.type || "application/octet-stream",
        kind: file.type?.startsWith("image/") ? "image" : "file",
        text: readableText,
      });
      nextRecords.push(await saveFileLike({
        id: `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || "uploaded file",
        mime: file.type || "application/octet-stream",
        size: file.size || 0,
        createdAt: new Date().toISOString(),
        sourceCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : "",
        kind: file.type?.startsWith("image/") ? "image" : "file",
        ...analysisRecordFields(analysis, readableText.length || 0),
        blob: file,
      }));
    }
    pendingFiles = [];
    state = sortRecords([...nextRecords, ...state.filter((item) => !nextRecords.some((next) => next.id === item.id))]);
    persistState();
  } finally {
    setSaveBusy(false);
    renderPending();
    renderVault();
  }
}

function setSaveBusy(isBusy, label = "") {
  if (!saveButton) return;
  saveButton.disabled = isBusy;
  saveButton.textContent = isBusy ? label : "save to vault";
}

async function withAiAnalysis(file, text) {
  const analysis = await analyzeRecordText({
    name: file.name,
    mime: file.mime,
    kind: file.kind,
    text,
  });
  const analyzed = {
    ...file,
    ...analysisRecordFields(analysis, textPdfSource(text || "").length || 0, file),
  };
  if ((file.kind || "").toLowerCase() === "generated pdf" && textPdfSource(text)) {
    return rebuildGeneratedPdf(analyzed, text);
  }
  return analyzed;
}

function rebuildGeneratedPdf(file, text) {
  const sourceText = textPdfSource(text);
  const createdAt = file.sourceCreatedAt || file.createdAt || new Date().toISOString();
  const highlights = { autism: file.autismHighlightText, adhd: file.adhdHighlightText };
  const result = createTextPdf(sourceText, createdAt, highlights);
  return {
    ...file,
    size: result.blob.size,
    pages: result.pages,
    previewDataUrl: createTextPreviewDataUrl(sourceText, createdAt, highlights),
    sourceText,
    generatedNoteLayoutVersion,
    analysisQualityVersion,
    blob: result.blob,
  };
}

async function saveFileLike(file) {
  if (sync.status === "connected") {
    try {
      return await uploadToSync(file);
    } catch {
      markSyncLocal();
    }
  }
  await putBlob(file.id, file.blob);
  return fileRecordFromPending(file, file.kind || "file", "browser");
}

async function uploadToSync(file) {
  const dataUrl = await blobToDataUrl(file.blob);
  const response = await postJson(`${sync.base}/api/files`, {
    name: file.name,
    mime: file.mime,
    dataUrl,
    size: file.size,
    kind: file.kind || "file",
    pages: file.pages || 0,
    sourceCreatedAt: file.sourceCreatedAt || "",
    createdAt: file.createdAt || "",
    previewDataUrl: file.previewDataUrl || "",
    autismScore: autismScoreForRecord(file),
    autismScoreExplanation: autismExplanationForRecord(file),
    autismHighlightText: autismHighlightTextForRecord(file),
    autismHighlightExplanation: autismHighlightExplanationForRecord(file),
    autismScoreSource: autismScoreSourceForRecord(file),
    autismScoreModel: autismScoreModelForRecord(file),
    autismScoreConfidence: autismScoreConfidenceForRecord(file),
    autismScoreWarning: autismScoreWarningForRecord(file),
    autismTextChars: autismTextCharsForRecord(file),
    adhdScore: adhdScoreForRecord(file),
    adhdScoreExplanation: adhdExplanationForRecord(file),
    adhdHighlightText: adhdHighlightTextForRecord(file),
    adhdHighlightExplanation: adhdHighlightExplanationForRecord(file),
    adhdScoreSource: adhdScoreSourceForRecord(file),
    adhdScoreModel: adhdScoreModelForRecord(file),
    adhdScoreConfidence: adhdScoreConfidenceForRecord(file),
    adhdScoreWarning: adhdScoreWarningForRecord(file),
    adhdTextChars: adhdTextCharsForRecord(file),
    lifeLeverageScore: lifeLeverageScoreForRecord(file),
    lifeLeverageExplanation: lifeLeverageExplanationForRecord(file),
    lifeLeverageHighlightText: lifeLeverageHighlightTextForRecord(file),
    lifeLeverageHighlightExplanation: lifeLeverageHighlightExplanationForRecord(file),
    lifeLeverageScoreSource: lifeLeverageScoreSourceForRecord(file),
    lifeLeverageScoreModel: lifeLeverageScoreModelForRecord(file),
    lifeLeverageScoreConfidence: lifeLeverageScoreConfidenceForRecord(file),
    lifeLeverageScoreWarning: lifeLeverageScoreWarningForRecord(file),
    lifeLeverageTextChars: lifeLeverageTextCharsForRecord(file),
    sourceText: textPdfSource(file.sourceText || ""),
    generatedNoteLayoutVersion: file.generatedNoteLayoutVersion || "",
    analysisQualityVersion: file.analysisQualityVersion || "",
  });
  return normalizeSyncFile(response.file);
}

async function rebuildSyncGeneratedNote(file, rebuilt) {
  const dataUrl = await blobToDataUrl(rebuilt.blob);
  const response = await postJson(`${sync.base}/api/files/${encodeURIComponent(file.id)}/rebuild`, {
    dataUrl,
    size: rebuilt.size,
    pages: rebuilt.pages || 0,
    previewDataUrl: rebuilt.previewDataUrl || "",
    sourceText: textPdfSource(rebuilt.sourceText || ""),
    generatedNoteLayoutVersion,
    analysisQualityVersion,
    autismScore: autismScoreForRecord(rebuilt),
    autismScoreExplanation: autismExplanationForRecord(rebuilt),
    autismHighlightText: autismHighlightTextForRecord(rebuilt),
    autismHighlightExplanation: autismHighlightExplanationForRecord(rebuilt),
    autismScoreSource: autismScoreSourceForRecord(rebuilt),
    autismScoreModel: autismScoreModelForRecord(rebuilt),
    autismScoreConfidence: autismScoreConfidenceForRecord(rebuilt),
    autismScoreWarning: autismScoreWarningForRecord(rebuilt),
    autismTextChars: autismTextCharsForRecord(rebuilt),
    adhdScore: adhdScoreForRecord(rebuilt),
    adhdScoreExplanation: adhdExplanationForRecord(rebuilt),
    adhdHighlightText: adhdHighlightTextForRecord(rebuilt),
    adhdHighlightExplanation: adhdHighlightExplanationForRecord(rebuilt),
    adhdScoreSource: adhdScoreSourceForRecord(rebuilt),
    adhdScoreModel: adhdScoreModelForRecord(rebuilt),
    adhdScoreConfidence: adhdScoreConfidenceForRecord(rebuilt),
    adhdScoreWarning: adhdScoreWarningForRecord(rebuilt),
    adhdTextChars: adhdTextCharsForRecord(rebuilt),
    lifeLeverageScore: lifeLeverageScoreForRecord(rebuilt),
    lifeLeverageExplanation: lifeLeverageExplanationForRecord(rebuilt),
    lifeLeverageHighlightText: lifeLeverageHighlightTextForRecord(rebuilt),
    lifeLeverageHighlightExplanation: lifeLeverageHighlightExplanationForRecord(rebuilt),
    lifeLeverageScoreSource: lifeLeverageScoreSourceForRecord(rebuilt),
    lifeLeverageScoreModel: lifeLeverageScoreModelForRecord(rebuilt),
    lifeLeverageScoreConfidence: lifeLeverageScoreConfidenceForRecord(rebuilt),
    lifeLeverageScoreWarning: lifeLeverageScoreWarningForRecord(rebuilt),
    lifeLeverageTextChars: lifeLeverageTextCharsForRecord(rebuilt),
  });
  return normalizeSyncFile(response.file);
}

function fileRecordFromPending(file, kind, source) {
  return {
    id: file.id,
    type: "file",
    name: file.name,
    mime: file.mime,
    size: file.size,
    createdAt: file.createdAt,
    sourceCreatedAt: file.sourceCreatedAt,
    kind,
    source,
    pages: file.pages || 0,
    previewDataUrl: file.previewDataUrl || "",
    autismScore: autismScoreForRecord(file),
    autismScoreExplanation: autismExplanationForRecord(file),
    autismHighlightText: autismHighlightTextForRecord(file),
    autismHighlightExplanation: autismHighlightExplanationForRecord(file),
    autismScoreSource: autismScoreSourceForRecord(file),
    autismScoreModel: autismScoreModelForRecord(file),
    autismScoreConfidence: autismScoreConfidenceForRecord(file),
    autismScoreWarning: autismScoreWarningForRecord(file),
    autismTextChars: autismTextCharsForRecord(file),
    adhdScore: adhdScoreForRecord(file),
    adhdScoreExplanation: adhdExplanationForRecord(file),
    adhdHighlightText: adhdHighlightTextForRecord(file),
    adhdHighlightExplanation: adhdHighlightExplanationForRecord(file),
    adhdScoreSource: adhdScoreSourceForRecord(file),
    adhdScoreModel: adhdScoreModelForRecord(file),
    adhdScoreConfidence: adhdScoreConfidenceForRecord(file),
    adhdScoreWarning: adhdScoreWarningForRecord(file),
    adhdTextChars: adhdTextCharsForRecord(file),
    lifeLeverageScore: lifeLeverageScoreForRecord(file),
    lifeLeverageExplanation: lifeLeverageExplanationForRecord(file),
    lifeLeverageHighlightText: lifeLeverageHighlightTextForRecord(file),
    lifeLeverageHighlightExplanation: lifeLeverageHighlightExplanationForRecord(file),
    lifeLeverageScoreSource: lifeLeverageScoreSourceForRecord(file),
    lifeLeverageScoreModel: lifeLeverageScoreModelForRecord(file),
    lifeLeverageScoreConfidence: lifeLeverageScoreConfidenceForRecord(file),
    lifeLeverageScoreWarning: lifeLeverageScoreWarningForRecord(file),
    lifeLeverageTextChars: lifeLeverageTextCharsForRecord(file),
    sourceText: textPdfSource(file.sourceText || ""),
    generatedNoteLayoutVersion: file.generatedNoteLayoutVersion || "",
    analysisQualityVersion: file.analysisQualityVersion || "",
  };
}

function renderPending() {
  if (!pendingList) return;
  pendingList.replaceChildren();
  if (pendingTextPdf) {
    pendingList.append(
      chip(`${pendingTextPdf.name} - ${pendingTextPdf.pages} pages`),
      pendingAction("open generated pdf", () => openBlob(pendingTextPdf.blob, pendingTextPdf.name))
    );
  }
  pendingFiles.slice(0, 8).forEach((file) => {
    pendingList.append(chip(`${file.name || "file"} - ${formatBytes(file.size || 0)}`));
  });
}

function chip(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function pendingAction(text, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pending-action";
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

async function renderVault() {
  if (!vaultList) return;
  renderOverallLifeScore();
  renderOverallScore();
  renderOverallAdhdScore();
  renderBankSummary();
  syncExportSelection();
  renderExportToolbar();
  revokeOpenUrls();
  vaultList.replaceChildren();
  if (!state.length) {
    const empty = document.createElement("p");
    empty.className = "vault-empty";
    empty.textContent = "No generated notes yet.";
    vaultList.append(empty);
    return;
  }
  for (const item of sortRecords(state)) {
    vaultList.append(await createVaultItem(item));
  }
}

function renderOverallLifeScore() {
  if (!overallLifeScore) return;
  const result = bankLifeLeverageScore();
  overallLifeScore.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "overall disney score";
  const value = document.createElement("strong");
  value.textContent = `${result.score}/100`;
  const detail = document.createElement("em");
  detail.textContent = result.detail;
  overallLifeScore.append(label, value, detail);
}

function renderOverallScore() {
  if (!overallScore) return;
  const result = bankAutismScore();
  overallScore.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "overall autism score";
  const value = document.createElement("strong");
  value.textContent = `${result.score}/100`;
  const detail = document.createElement("em");
  detail.textContent = result.detail;
  overallScore.append(label, value, detail);
}

function renderOverallAdhdScore() {
  if (!overallAdhdScore) return;
  const result = bankAdhdScore();
  overallAdhdScore.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "overall adhd score";
  const value = document.createElement("strong");
  value.textContent = `${result.score}/100`;
  const detail = document.createElement("em");
  detail.textContent = result.detail;
  overallAdhdScore.append(label, value, detail);
}

function bankLifeLeverageScore() {
  const generated = state
    .filter((item) => (item.kind || "").toLowerCase() === "generated pdf")
    .map((item) => ({
      score: lifeLeverageScoreForRecord(item),
      weight: generatedScoreWeight(item),
      createdAt: Date.parse(item.createdAt || 0) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  if (!generated.length) return { score: 1, detail: "no saved thoughts yet" };
  const recent = [...generated].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(8, generated.length));
  const weighted = recent.reduce(
    (acc, item) => {
      acc.total += item.score * item.weight;
      acc.weight += item.weight;
      return acc;
    },
    { total: 0, weight: 0 }
  );
  const score = clampAutismScore(weighted.total / Math.max(1, weighted.weight));
  const highNotes = generated.filter((item) => item.score >= 70).length;
  const lowNotes = generated.filter((item) => item.score <= 35).length;
  const detail = highNotes
    ? `${highNotes} Disney-goal note${highNotes === 1 ? "" : "s"}; ${lowNotes} lower-return thought${lowNotes === 1 ? "" : "s"}`
    : lowNotes
      ? `${lowNotes} lower-return thought${lowNotes === 1 ? "" : "s"} visible`
      : "recent notes are mostly middle Disney/career signal";
  return { score, detail };
}

function bankAutismScore() {
  const generated = state
    .filter((item) => (item.kind || "").toLowerCase() === "generated pdf")
    .map((item) => ({
      score: autismScoreForRecord(item),
      weight: generatedScoreWeight(item),
      label: "saved note",
    }))
    .filter((item) => Number.isFinite(item.score));
  const evidence = [...autismReferenceScores, ...generated].filter((item) => item.score > 0);
  if (!evidence.length) return { score: 1, detail: "no readable evidence yet" };

  const strongest = [...evidence].sort((a, b) => b.score - a.score).slice(0, Math.min(5, evidence.length));
  const weighted = strongest.reduce(
    (acc, item) => {
      acc.total += item.score * item.weight;
      acc.weight += item.weight;
      return acc;
    },
    { total: 0, weight: 0 }
  );
  const score = Math.max(1, Math.min(100, Math.round(weighted.total / Math.max(1, weighted.weight))));
  const highNotes = generated.filter((item) => item.score >= 80).length;
  const detail = highNotes
    ? `strongest evidence: autism evaluation + ${highNotes} high-signal saved note${highNotes === 1 ? "" : "s"}`
    : "strongest evidence: autism evaluation";
  return { score, detail };
}

function bankAdhdScore() {
  const generated = state
    .filter((item) => (item.kind || "").toLowerCase() === "generated pdf")
    .map((item) => ({
      score: item.adhdScore !== undefined && item.adhdScore !== null && item.adhdScore !== ""
        ? adhdScoreForRecord(item)
        : NaN,
      weight: generatedScoreWeight(item),
      label: "saved note",
    }))
    .filter((item) => Number.isFinite(item.score));
  const evidence = [...adhdReferenceScores, ...generated].filter((item) => item.score > 0);
  if (!evidence.length) return { score: 1, detail: "no readable evidence yet" };

  const strongest = [...evidence].sort((a, b) => b.score - a.score).slice(0, Math.min(5, evidence.length));
  const weighted = strongest.reduce(
    (acc, item) => {
      acc.total += item.score * item.weight;
      acc.weight += item.weight;
      return acc;
    },
    { total: 0, weight: 0 }
  );
  const score = Math.max(1, Math.min(100, Math.round(weighted.total / Math.max(1, weighted.weight))));
  const highNotes = generated.filter((item) => item.score >= 80).length;
  const detail = highNotes
    ? `strongest evidence: ADHD letter + ${highNotes} high-signal saved note${highNotes === 1 ? "" : "s"}`
    : "strongest evidence: ADHD letter";
  return { score, detail };
}

function renderBankSummary() {
  if (!bankSummary) return;
  const summary = buildBankSummary();
  bankSummary.replaceChildren();
  const main = document.createElement("p");
  main.className = "summary-main";
  main.textContent = summary.main;
  bankSummary.append(main);
}

function buildBankSummary() {
  const notes = sortRecords(state.filter(isGeneratedPdf));
  if (!notes.length) {
    return {
      main: sync.status === "checking"
        ? "Saved notes will appear after sync loads."
        : "Paste a thought, save it, and the bank will keep it here.",
    };
  }

  const ranked = rankedBankSummaryThreads(notes);
  const primary = selectBankSummaryPrimary(ranked);
  if (!primary) {
    return {
      main: "The saved bank is still too thin to read clearly. Add more notes and the summary will start from the strongest through-line, not a topic list.",
    };
  }
  const details = primary.details.slice(0, 3);
  const support = ranked.filter((item) => item.key !== primary.key && item.score >= Math.max(18, primary.score * 0.28));
  const sentences = [
    bankSummaryLead(primary, details),
    bankSummarySupport(primary, support),
    bankSummaryFriction(primary, support),
  ].filter(Boolean);

  return {
    main: (sentences.length
      ? sentences.join(" ")
      : "The saved bank is strongest when it turns raw thoughts into a clearer next action instead of spreading attention across every possible topic."
    ).replace(/\s+/g, " ").trim(),
  };
}

function bankSummaryThreads() {
  return [
    {
      key: "careerResearch",
      details: [
        ["Moana/ocean soft-robotics ideas", /\bmoana|ocean|wave|soft robotics|soft robotic\b/gi],
        ["overhang and inverse-sheet simulation", /\boverhang|inverse sheet|sheet|simulat(?:e|or|ion)\b/gi],
        ["Sarrus/X-cell/pneumatic/magnetic-valve mechanisms", /\bsarrus|x[- ]?cell|pneumatic|magnetic valve|actuator|linkage|mechanism\b/gi],
        ["octopus and tentacle mechanics", /\boctop(?:us|i)|tentacle\b/gi],
        ["paper math and advisor explanations", /\bpaper|figure|manuscript|math|citation|advisor|how it works\b/gi],
        ["Disney/Imagineering R&D path", /\bdisney|imagineer(?:ing)?|wdi|r&d|research scientist|scientist engineer\b/gi],
      ],
      lead(details) {
        const useful = details.filter((item) => item !== "Disney/Imagineering R&D path").slice(0, 3);
        const specific = summaryFocusSentence(useful);
        return `Your notes are centered on turning PhD soft-robotics work into a serious Disney/Imagineering R&D path.${specific}`;
      },
    },
    {
      key: "externalBrain",
      details: [
        ["PDF notes and exports", /\bpdf|export|download|text file|generated note\b/gi],
        ["sync and saved files", /\bsync|shared|upload|vault|bank|saved\b/gi],
        ["table, recipe, and formatting rules", /\btable|column|row|recipe|food|cheese|format|formatted|line break|justif(?:y|ied)\b/gi],
        ["source checks and live verification", /\bsource of truth|source|verify|verified|current|live|deploy\b/gi],
        ["AO Labs, Spec, Progress, and Codex workflows", /\baolabs|spec|progress|codex|app|site|website|workflow\b/gi],
      ],
      lead(details) {
        const specific = summaryFocusSentence(details);
        return `Your notes are centered on making saved material usable instead of vague.${specific}`;
      },
    },
    {
      key: "friction",
      details: [
        ["task-starting pressure", /\btask|start|starting|getting started|activation energy|stuck|lost momentum\b/gi],
        ["interest-driven focus", /\bfocus|attention|interesting|boring|hyperfocus|one thing\b/gi],
        ["exact rules and stable paths", /\bexact|rule|standard|specific|same|stable|consistent|predictable|certainty|know for a fact\b/gi],
        ["vague instructions turning into frustration", /\bfrustrat|vague|unclear|stupid|dumb|annoy\b/gi],
        ["memory, time, and overwhelm", /\bmemory|time|deadline|organize|plan|priority|overwhelm|too much|stress|panic\b/gi],
      ],
      lead(details) {
        const specific = summaryFocusSentence(details);
        return `Your notes are centered on reducing the ambiguity that makes starting and continuing work harder.${specific}`;
      },
    },
    {
      key: "lifeMotivation",
      details: [
        ["money and career pressure", /\bmoney|rich|income|salary|cash|finance|career|job|work\b/gi],
        ["car motivation", /\bcar|a3|audi|mini|drive|driving\b/gi],
        ["comfort, happiness, and safety", /\bhappiness|happy|comfort|comfortable|nice life|safe|safety\b/gi],
        ["relationship and social certainty", /\bsocial|relationship|conversation|reply|understood|unheard|invalidated|lily|instagram\b/gi],
        ["body and spatial mapping", /\bbody|spatial|space|corner|mapping\b/gi],
      ],
      lead(details) {
        const specific = summaryFocusSentence(details);
        return `Your notes are centered on using future-life motivation to keep the bigger research and career path emotionally real.${specific}`;
      },
    },
  ];
}

function rankedBankSummaryThreads(notes) {
  return bankSummaryThreads()
    .map((thread) => {
      const detailScores = thread.details.map(([label, pattern]) => {
        const count = notes.reduce((total, item, index) => {
          const text = summaryTextForRecord(item);
          const matches = matchStats(text, new RegExp(pattern.source, "gi")).count;
          if (!matches) return total;
          const recency = index < 8 ? 1.2 : 1;
          const leverage = Math.max(0.55, lifeLeverageScoreForRecord(item) / 100);
          return total + Math.min(6, matches) * recency * (0.75 + leverage);
        }, 0);
        return { label, count };
      }).filter((item) => item.count > 0);
      const score = detailScores.reduce((total, item) => total + item.count, 0);
      return {
        ...thread,
        score,
        details: detailScores
          .sort((a, b) => b.count - a.count)
          .map((item) => item.label),
      };
    })
    .filter((thread) => thread.score > 0)
    .sort((a, b) => b.score - a.score);
}

function selectBankSummaryPrimary(ranked) {
  const top = ranked[0];
  const career = ranked.find((item) => item.key === "careerResearch");
  if (career && top && (career.score >= top.score * 0.38 || career.score >= 34)) {
    return career;
  }
  return top;
}

function bankSummaryLead(primary, details) {
  return primary.lead(details);
}

function summaryDetailJoin(items) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] || "";
  return clean.join("; ");
}

function summaryFocusSentence(items) {
  const clean = items.filter(Boolean);
  if (!clean.length) return "";
  if (clean.length === 1) return ` Right now this mostly shows up as ${clean[0]}.`;
  if (clean.length === 2) return ` Right now this mostly shows up through ${clean[0]} and ${clean[1]}.`;
  return ` Right now this mostly shows up through ${clean[0]}, ${clean[1]}, and ${clean[2]}.`;
}

function bankSummarySupport(primary, support) {
  const career = support.find((item) => item.key === "careerResearch");
  const externalBrain = support.find((item) => item.key === "externalBrain");
  const life = support.find((item) => item.key === "lifeMotivation");
  const hasCareer = Boolean(career);
  const hasExternalBrain = Boolean(externalBrain);
  const hasLife = Boolean(life);
  if (primary.key === "careerResearch") {
    if (hasExternalBrain && hasLife) {
      return "The PDF/app/table/formatting work is there to preserve the notes, source checks, and formatting standards around that path, not to become its own equal branch. Money, car, comfort, and relationship safety show up as motivation and stability around it, not as the center.";
    }
    if (hasExternalBrain) return "The PDF/app/table/formatting work is there to preserve the notes, source checks, and formatting standards around that path, not to become its own equal branch.";
    if (hasLife) return "Money, car, comfort, and relationship safety are motivation and stability around that path, not the center.";
  }
  if (primary.key === "externalBrain") {
    return hasCareer
      ? `The systems matter most when they point back to ${summaryDetailJoin(career.details.slice(0, 2))} and the Disney/Imagineering path.`
      : "Saved material matters when it becomes easier to act on, not when it becomes another category collection.";
  }
  if (primary.key === "friction") {
    if (hasCareer) return `The friction matters because it blocks ${summaryDetailJoin(career.details.slice(0, 2))} and the career work underneath it.`;
    return "The next cleanup target should be the ambiguity that blocks action first, not every concern equally.";
  }
  if (primary.key === "lifeMotivation") {
    return hasCareer
      ? `The money, car, comfort, and safety material matters most when it feeds ${summaryDetailJoin(career.details.slice(0, 2))} and the Disney/Imagineering direction.`
      : "Real motivation should be separated from side thoughts that only add noise.";
  }
  return "";
}

function bankSummaryFriction(primary, support) {
  const friction = primary.key === "friction" ? primary : support.find((item) => item.key === "friction");
  if (!friction?.details?.length) return "";
  const details = friction.details.slice(0, 2);
  if (!details.length) return "";
  if (primary.key === "friction") return "That pressure should set the next cleanup target instead of becoming another long list.";
  return bankSummaryFrictionSentence(details);
}

function bankSummaryFrictionSentence(details) {
  const text = details.join(" ");
  const exact = /exact rules|stable paths/.test(text);
  const memory = /memory|time|overwhelm/.test(text);
  const vague = /vague instructions|frustration/.test(text);
  const focus = /task-starting|interest-driven/.test(text);
  if (exact && memory) return "The pressure underneath is that unclear rules plus memory and time load make the next path harder to trust before the work feels concrete.";
  if (exact && vague) return "The pressure underneath is that vague instructions make exact rules and stable paths feel necessary.";
  if (exact) return "The pressure underneath is needing exact rules before a path feels safe enough to follow.";
  if (memory) return "The pressure underneath is memory, time, and overwhelm making the next step harder to hold.";
  if (focus) return "The pressure underneath is task-starting and interest-driven focus shaping what becomes doable.";
  return "The pressure underneath is ambiguity making the next path harder to trust.";
}

function summaryTextForRecord(item) {
  return textPdfSource([
    item?.sourceText,
    item?.lifeLeverageExplanation,
    item?.lifeLeverageHighlightText,
    item?.lifeLeverageHighlightExplanation,
    item?.autismScoreExplanation,
    item?.autismHighlightText,
    item?.autismHighlightExplanation,
    item?.adhdScoreExplanation,
    item?.adhdHighlightText,
    item?.adhdHighlightExplanation,
    item?.name,
  ].filter(Boolean).join(" "));
}

function generatedScoreWeight(item) {
  const pages = Number(item.pages || 0);
  const size = Number(item.size || 0);
  if (pages >= 2 || size >= 3500) return 1.25;
  return 1;
}

async function createVaultItem(item) {
  const row = document.createElement("article");
  row.className = "vault-item";
  const exportable = isExportableNote(item);
  const exportKey = exportRecordKey(item);
  if (exportMode && exportable) {
    row.classList.add("export-selectable");
    if (selectedExportIds.has(exportKey)) row.classList.add("is-selected");
  } else if (exportMode) {
    row.classList.add("export-unavailable");
  }

  if (exportMode && exportable) {
    const pick = document.createElement("label");
    pick.className = "export-pick";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedExportIds.has(exportKey);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedExportIds.add(exportKey);
        row.classList.add("is-selected");
      } else {
        selectedExportIds.delete(exportKey);
        row.classList.remove("is-selected");
      }
      renderExportToolbar();
    });
    const pickText = document.createElement("span");
    pickText.textContent = "select";
    pick.append(checkbox, pickText);
    row.append(pick);
  }

  const thumb = document.createElement("div");
  thumb.className = "vault-thumb";
  if (item.source === "sync" && item.hasPreview) {
    const img = document.createElement("img");
    img.src = syncFileUrl(item.id, "preview");
    img.alt = "";
    thumb.append(img);
  } else if (item.previewDataUrl) {
    const img = document.createElement("img");
    img.src = item.previewDataUrl;
    img.alt = "";
    thumb.append(img);
  } else if (item.kind === "image") {
    const blob = item.source === "sync" ? null : await getBlob(item.id);
    if (blob) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(blob);
      openUrls.push(url);
      img.src = url;
      img.alt = "";
      thumb.append(img);
    } else if (item.source === "sync") {
      const img = document.createElement("img");
      img.src = syncFileUrl(item.id, "view");
      img.alt = "";
      thumb.append(img);
    } else {
      thumb.textContent = "img";
    }
  } else {
    thumb.textContent = item.kind === "generated pdf" ? "pdf" : extensionLabel(item.name);
  }

  const main = document.createElement("div");
  main.className = "vault-main";
  const title = document.createElement("p");
  title.className = "vault-title";
  title.textContent = item.name || "saved file";
  const itemSeed = item.id || item.name || item.createdAt || "";
  const cardSourceText = await cardSourceTextForRecord(item);
  const adhd = await adhdAnalysisForRecord(item);
  const leverage = lifeLeverageAnalysisForRecord(item);
  const signal = autismHighlightForRecord(item);
  const score = document.createElement("p");
  score.className = "autism-score";
  score.textContent = `autism score ${autismScoreForRecord(item)}/100`;
  const scoreWhy = document.createElement("p");
  scoreWhy.className = "autism-score-why";
  const autismExplanation = autismExplanationForRecord(item);
  const autismCardOptions = {
    highlightText: signal.text,
    highlightExplanation: signal.explanation,
    sourceText: cardSourceText,
    score: autismScoreForRecord(item),
    trait: "autism",
    seedText: itemSeed,
  };
  scoreWhy.title = autismExplanation;
  const signalWhy = document.createElement("p");
  signalWhy.className = "autism-signal";
  if (signal.text) {
    const strong = document.createElement("strong");
    strong.textContent = `"${signal.text}"`;
    signalWhy.append(strong);
    if (signal.explanation) signalWhy.append(document.createTextNode(` ${cardSignalExplanation(signal.explanation)}`));
    signalWhy.title = [signal.text, signal.explanation].filter(Boolean).join(" ");
  }
  const adhdScore = document.createElement("p");
  adhdScore.className = "adhd-score";
  adhdScore.textContent = `adhd score ${adhd.score}/100`;
  const adhdWhy = document.createElement("p");
  adhdWhy.className = "adhd-score-why";
  const adhdExplanation = adhd.explanation;
  const adhdCardOptions = {
    highlightText: adhd.highlightText,
    highlightExplanation: adhd.highlightExplanation,
    sourceText: cardSourceText,
    score: adhd.score,
    trait: "adhd",
    seedText: itemSeed,
  };
  const pairedAnalysis = pairedCardAnalysisText(
    cardAnalysisExplanation(autismExplanation, autismCardOptions),
    cardAnalysisExplanation(adhdExplanation, adhdCardOptions),
    autismCardOptions,
    adhdCardOptions
  );
  scoreWhy.textContent = pairedAnalysis.autism;
  adhdWhy.textContent = pairedAnalysis.adhd;
  adhdWhy.title = adhdExplanation;
  const adhdSignalWhy = document.createElement("p");
  adhdSignalWhy.className = "autism-signal adhd-signal";
  if (adhd.highlightText) {
    const strong = document.createElement("strong");
    strong.textContent = `"${adhd.highlightText}"`;
    adhdSignalWhy.append(strong);
    if (adhd.highlightExplanation) adhdSignalWhy.append(document.createTextNode(` ${cardSignalExplanation(adhd.highlightExplanation)}`));
    adhdSignalWhy.title = [adhd.highlightText, adhd.highlightExplanation].filter(Boolean).join(" ");
  }
  const lifeScore = document.createElement("p");
  lifeScore.className = "life-score";
  lifeScore.textContent = `disney score ${leverage.score}/100`;
  const lifeSignalWhy = document.createElement("p");
  lifeSignalWhy.className = "autism-signal life-signal";
  if (leverage.highlightText) {
    const strong = document.createElement("strong");
    strong.textContent = `"${leverage.highlightText}"`;
    lifeSignalWhy.append(strong);
    if (leverage.highlightExplanation) lifeSignalWhy.append(document.createTextNode(` ${cardSignalExplanation(leverage.highlightExplanation)}`));
    lifeSignalWhy.title = [leverage.highlightText, leverage.highlightExplanation].filter(Boolean).join(" ");
  }
  const lifeWhy = document.createElement("p");
  lifeWhy.className = "life-score-why";
  const lifeExplanation = lifeLeverageCardAnalysis(leverage.explanation, {
    score: leverage.score,
    highlightText: leverage.highlightText,
    highlightExplanation: leverage.highlightExplanation,
    sourceText: cardSourceText,
    seedText: itemSeed,
  });
  lifeWhy.textContent = lifeExplanation;
  lifeWhy.title = leverage.explanation;
  const meta = document.createElement("p");
  meta.className = "vault-meta";
  meta.textContent = [
    item.source === "sync" ? "synced" : "device",
    item.kind || "file",
    item.pages ? `${item.pages} pages` : "",
    formatBytes(item.size || 0),
    displayDate(item.createdAt),
    leverage.scoreSource === "heuristic" ? "disney fallback" : "",
    autismScoreSourceForRecord(item) === "heuristic" ? "fallback score" : "",
    adhd.scoreSource === "heuristic" ? "adhd fallback" : "",
  ].filter(Boolean).join(" - ");
  main.append(title, score);
  if (signal.text) main.append(signalWhy);
  const appendedWhy = new Set();
  const appendScoreWhy = (element) => {
    const key = comparableAnalysisText(element.textContent);
    if (!key || appendedWhy.has(key)) return;
    appendedWhy.add(key);
    main.append(element);
  };
  if (!signal.text) {
    appendScoreWhy(scoreWhy);
  } else {
    appendScoreBasis(signalWhy, autismCardOptions);
  }
  main.append(adhdScore);
  if (adhd.highlightText) {
    appendScoreBasis(adhdSignalWhy, adhdCardOptions);
    main.append(adhdSignalWhy);
  } else {
    appendScoreWhy(adhdWhy);
  }
  main.append(lifeScore);
  if (leverage.highlightText) {
    appendScoreBasis(lifeSignalWhy, {
      score: leverage.score,
      trait: "disney",
      sourceText: cardSourceText,
      highlightText: leverage.highlightText,
      highlightExplanation: leverage.highlightExplanation,
      seedText: itemSeed,
    });
    main.append(lifeSignalWhy);
  } else {
    appendScoreWhy(lifeWhy);
  }
  main.append(meta);

  const actions = document.createElement("div");
  actions.className = "vault-actions";
  actions.append(
    actionButton("open", () => openRecord(item)),
    actionButton("download", () => downloadRecord(item)),
    actionButton("delete", () => deleteRecord(item), "danger")
  );

  row.append(thumb, main, actions);
  renderOverallLifeScore();
  renderOverallAdhdScore();
  return row;
}

function actionButton(text, action, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass;
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

function isExportableNote(item) {
  return isGeneratedPdf(item);
}

function exportRecordKey(item) {
  return String(item?.id || `${item?.name || "note"}-${item?.createdAt || ""}`);
}

function exportableNotes() {
  return state.filter(isExportableNote);
}

function syncExportSelection() {
  const available = new Set(exportableNotes().map(exportRecordKey));
  for (const key of [...selectedExportIds]) {
    if (!available.has(key)) selectedExportIds.delete(key);
  }
  if (!available.size && exportMode) exportMode = false;
}

function setExportMode(enabled) {
  exportMode = Boolean(enabled && exportableNotes().length);
  if (!exportMode) selectedExportIds.clear();
  renderExportToolbar();
  void renderVault();
}

function renderExportToolbar() {
  const notes = exportableNotes();
  const total = notes.length;
  const selected = notes.filter((item) => selectedExportIds.has(exportRecordKey(item))).length;
  if (exportStartButton) {
    exportStartButton.hidden = exportMode;
    exportStartButton.disabled = !total || exportBusy;
  }
  if (exportActions) exportActions.hidden = !exportMode;
  if (exportAllButton) {
    exportAllButton.disabled = !total || exportBusy;
    exportAllButton.textContent = selected && selected === total ? "clear" : "select all";
  }
  if (exportDownloadButton) {
    exportDownloadButton.disabled = !selected || exportBusy;
    exportDownloadButton.textContent = exportBusy ? "building file" : "download selected";
  }
  if (exportCancelButton) exportCancelButton.disabled = exportBusy;
  if (exportCount) {
    exportCount.textContent = total
      ? `${selected} selected`
      : "no notes";
  }
}

function toggleAllExportNotes() {
  const notes = exportableNotes();
  const allSelected = notes.length && notes.every((item) => selectedExportIds.has(exportRecordKey(item)));
  if (allSelected) {
    selectedExportIds.clear();
  } else {
    notes.forEach((item) => selectedExportIds.add(exportRecordKey(item)));
  }
  renderExportToolbar();
  void renderVault();
}

async function downloadSelectedNotes() {
  if (exportBusy) return;
  const selected = exportableNotes()
    .filter((item) => selectedExportIds.has(exportRecordKey(item)))
    .sort((a, b) => exportDateMs(a) - exportDateMs(b));
  if (!selected.length) return;
  exportBusy = true;
  renderExportToolbar();
  try {
    const blocks = [];
    for (const item of selected) {
      const note = await exportNoteTextForRecord(item);
      if (!note) continue;
      blocks.push(`${formatExportDate(item.sourceCreatedAt || item.createdAt)}: ${note}`);
    }
    if (!blocks.length) return;
    const text = `${blocks.join("\n")}\n`;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `brain-notes-${exportFileStamp(new Date())}.txt`);
    setExportMode(false);
  } finally {
    exportBusy = false;
    renderExportToolbar();
  }
}

async function exportNoteTextForRecord(item) {
  const source = item?.sourceText || await cardSourceTextForRecord(item);
  return textPdfSource(stripGeneratedAnalysisLeak(source)).replace(/\s+/g, " ").trim();
}

function exportDateMs(item) {
  const date = new Date(item?.sourceCreatedAt || item?.createdAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatExportDate(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "2-digit",
      month: "numeric",
      day: "numeric",
    }).format(safeDate);
  } catch {
    return safeDate.toLocaleDateString("en-US", { year: "2-digit", month: "numeric", day: "numeric" });
  }
}

function exportFileStamp(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, "0");
  return `${safeDate.getFullYear()}${pad(safeDate.getMonth() + 1)}${pad(safeDate.getDate())}`;
}

function appendScoreBasis(target, options = {}) {
  const basis = scoreBasisSentence(options);
  if (!basis) return;
  const existing = comparableAnalysisText(target.textContent);
  const key = comparableAnalysisText(basis);
  if (!key || existing.includes(key) || anchorSimilarity(existing, key) > 0.6) return;
  target.append(document.createTextNode(` ${basis}`));
}

async function openRecord(item) {
  if (item.source === "sync" && sync.status === "connected") {
    window.open(syncFileUrl(item.id, "view"), "_blank", "noopener");
    return;
  }
  const blob = await getBlob(item.id);
  if (blob) openBlob(blob, item.name);
}

async function downloadRecord(item) {
  if (item.source === "sync" && sync.status === "connected") {
    window.location.href = syncFileUrl(item.id, "download");
    return;
  }
  const blob = await getBlob(item.id);
  if (blob) downloadBlob(blob, item.name);
}

async function deleteRecord(item) {
  if (item.source === "sync" && sync.status === "connected") {
    const ok = await deleteSyncFile(item.id).catch(() => false);
    if (!ok) return;
  } else {
    await deleteBlob(item.id);
  }
  state = state.filter((record) => record.id !== item.id);
  persistState();
  renderVault();
}

async function autoSyncLocalRecords() {
  if (autoSyncRunning || sync.status !== "connected") return;
  const localRecords = state.filter((item) => item.source !== "sync");
  if (!localRecords.length) return;
  autoSyncRunning = true;
  renderSyncStatus();
  try {
    for (const item of localRecords) {
      if (sync.status !== "connected") break;
      const blob = await getBlob(item.id);
      if (!blob) continue;
      try {
        const synced = await uploadToSync({
          ...item,
          kind: item.kind || "file",
          mime: item.mime || blob.type || "application/octet-stream",
          size: item.size || blob.size || 0,
          blob,
        });
        await deleteBlob(item.id);
        state = sortRecords([synced, ...state.filter((record) => record.id !== item.id)]);
        persistState();
      } catch {
        markSyncLocal();
        break;
      }
    }
  } finally {
    autoSyncRunning = false;
    renderSyncStatus();
    renderVault();
  }
}

async function refreshSyncFiles() {
  const response = await fetch(`${sync.base}/api/files`, { cache: "no-store" });
  if (!response.ok) throw new Error(`files ${response.status}`);
  const json = await response.json();
  const synced = Array.isArray(json.files) ? json.files.map(normalizeSyncFile) : [];
  const localOnly = state.filter((item) => item.source !== "sync");
  state = sortRecords([...synced, ...localOnly]);
  persistState();
  renderVault();
  void rebuildOutdatedGeneratedNotes();
}

function normalizeSyncFile(file) {
  const normalized = {
    id: file.id,
    type: "file",
    name: file.name,
    mime: file.mime,
    size: file.size || 0,
    createdAt: file.createdAt,
    sourceCreatedAt: file.sourceCreatedAt || "",
    kind: file.kind || "file",
    pages: file.pages || 0,
    hasPreview: Boolean(file.hasPreview),
    previewMime: file.previewMime || "",
    autismScore: autismScoreForRecord(file),
    autismScoreExplanation: autismExplanationForRecord(file),
    autismHighlightText: autismHighlightTextForRecord(file),
    autismHighlightExplanation: autismHighlightExplanationForRecord(file),
    autismScoreSource: autismScoreSourceForRecord(file),
    autismScoreModel: autismScoreModelForRecord(file),
    autismScoreConfidence: autismScoreConfidenceForRecord(file),
    autismScoreWarning: autismScoreWarningForRecord(file),
    autismTextChars: autismTextCharsForRecord(file),
    sourceText: textPdfSource(file.sourceText || ""),
    generatedNoteLayoutVersion: file.generatedNoteLayoutVersion || "",
    analysisQualityVersion: file.analysisQualityVersion || "",
    lifeLeverageHighlightStored: Boolean(file.lifeLeverageHighlightText && file.lifeLeverageHighlightExplanation),
    source: "sync",
  };
  const needsPdfAdhdAnalysis = isGeneratedPdf(normalized)
    && !file.adhdScoreExplanation
    && !file.adhdHighlightText
    && !file.sourceText;
  if (!needsPdfAdhdAnalysis) {
    Object.assign(normalized, {
      adhdScore: adhdScoreForRecord(file),
      adhdScoreExplanation: adhdExplanationForRecord(file),
      adhdHighlightText: adhdHighlightTextForRecord(file),
      adhdHighlightExplanation: adhdHighlightExplanationForRecord(file),
      adhdScoreSource: adhdScoreSourceForRecord(file),
      adhdScoreModel: adhdScoreModelForRecord(file),
      adhdScoreConfidence: adhdScoreConfidenceForRecord(file),
      adhdScoreWarning: adhdScoreWarningForRecord(file),
      adhdTextChars: adhdTextCharsForRecord(file),
    });
  }
  Object.assign(normalized, {
    lifeLeverageScore: lifeLeverageScoreForRecord(file),
    lifeLeverageExplanation: lifeLeverageExplanationForRecord(file),
    lifeLeverageHighlightText: lifeLeverageHighlightTextForRecord(file),
    lifeLeverageHighlightExplanation: lifeLeverageHighlightExplanationForRecord(file),
    lifeLeverageScoreSource: lifeLeverageScoreSourceForRecord(file),
    lifeLeverageScoreModel: lifeLeverageScoreModelForRecord(file),
    lifeLeverageScoreConfidence: lifeLeverageScoreConfidenceForRecord(file),
    lifeLeverageScoreWarning: lifeLeverageScoreWarningForRecord(file),
    lifeLeverageTextChars: lifeLeverageTextCharsForRecord(file),
  });
  return normalized;
}

async function rebuildOutdatedGeneratedNotes() {
  if (sync.status !== "connected") return;
  const outdated = state.filter((item) => item.source === "sync"
    && isGeneratedPdf(item)
    && item.mime === "application/pdf"
    && (
      item.generatedNoteLayoutVersion !== generatedNoteLayoutVersion
      || item.analysisQualityVersion !== analysisQualityVersion
      || item.autismScoreSource !== "ai"
      || item.adhdScoreSource !== "ai"
      || item.lifeLeverageScoreSource !== "ai"
      || hasStoredScoreAnalysisIssue(item)
      || item.lifeLeverageScore === undefined
      || item.lifeLeverageScore === null
      || item.lifeLeverageScore === ""
      || item.lifeLeverageHighlightStored === false
      || !item.lifeLeverageHighlightText
      || !item.lifeLeverageHighlightExplanation
    ));
  if (!outdated.length) return;
  for (const item of outdated) {
    if (sync.status !== "connected") break;
    const sourceText = textPdfSource(item.sourceText || await pdfTextForRecord(item));
    if (!sourceText) continue;
    let updated = item;
    if (
      item.analysisQualityVersion !== analysisQualityVersion
      || item.autismScoreSource !== "ai"
      || item.adhdScoreSource !== "ai"
      || item.lifeLeverageScoreSource !== "ai"
      || hasStoredScoreAnalysisIssue(item)
      || item.lifeLeverageScore === undefined
      || item.lifeLeverageScore === null
      || item.lifeLeverageScore === ""
      || item.lifeLeverageHighlightStored === false
      || !item.lifeLeverageHighlightText
      || !item.lifeLeverageHighlightExplanation
    ) {
      try {
        const analysis = await analyzeRecordText({
          name: item.name,
          mime: item.mime,
          kind: item.kind,
          text: sourceText,
        });
        if (
          analysis?.autism?.scoreSource !== "ai"
          || analysis?.adhd?.scoreSource !== "ai"
          || analysis?.lifeLeverage?.scoreSource !== "ai"
        ) {
          continue;
        }
        updated = {
          ...item,
          ...analysisRecordFields(analysis, sourceText.length, { ...item, sourceText }),
        };
      } catch {
        continue;
      }
    }
    const rebuilt = rebuildGeneratedPdf({ ...updated, generatedNoteLayoutVersion }, sourceText);
    try {
      const synced = await rebuildSyncGeneratedNote(item, rebuilt);
      state = sortRecords([synced, ...state.filter((record) => record.id !== item.id)]);
      persistState();
      renderVault();
    } catch {
      break;
    }
  }
}

function hasStoredScoreAnalysisIssue(item) {
  const fields = [
    item.autismScoreExplanation,
    item.adhdScoreExplanation,
    item.lifeLeverageExplanation,
    item.autismHighlightExplanation,
    item.adhdHighlightExplanation,
    item.lifeLeverageHighlightExplanation,
  ].filter(Boolean).map((value) => String(value || "").replace(/\s+/g, " ").trim());
  const text = fields.join(" ");
  if (!text.trim()) return true;
  return fields.some((value) => /^\s*[,;:]/.test(value))
    || fields.some((value) => /^(?:io|pdf)\b/i.test(value))
    || /\b(?:The rest of the note adds|The note also mentions|bolded signal|score basis|AI analysis|selected line)\b/i.test(text)
    || /\b(?:Score \d|DSM core|raw \d|capped at|hits?:|hit count|hits count)\b/i.test(text)
    || /\b(?:I read|I score|I treat|I keep it above zero|I stop|I would not call it 0)\b/i.test(text)
    || /\b(?:The Disney score is|The Disney score stays|The Disney score is built around)\b/i.test(text)
    || /\b(?:The useful part is|The most useful part is|The useful pattern is|The strongest useful pattern is|The strongest useful thread is|The strongest value is|The clearest value is|The clearest useful pattern is)\b/i.test(text)
    || /\b(?:It stays (?:very )?(?:low|below|low-to-mid|well below|mid-low|modest|moderate|mid|lower)|The score (?:is|stays|gets|sits)|score (?:stays|comes|lands)|It scores very high|It earns a middle)\b/i.test(text)
    || /\b(?:This entry has limited|low baseline|fallback|not proof of no)\b/i.test(text);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `request ${response.status}`);
  return json;
}

async function deleteSyncFile(id) {
  const response = await fetch(`${sync.base}/api/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return response.ok;
}

function syncFileUrl(id, mode) {
  return `${sync.base}/api/files/${encodeURIComponent(id)}/${mode}`;
}

function createTextPdf(text, createdAt, highlightText = "") {
  const { width, height, margin, fontSize, leading } = notePdfLayout;
  const highlights = normalizeTraitHighlights(highlightText);
  const lineWidth = width - margin * 2;
  const lines = [
    pdfLine(`Created: ${formatPdfTimestamp(createdAt)}`),
    blankPdfLine(),
    ...formattedPdfLines(text, { lineWidth, fontSize, measureText: pdfTextWidth, highlights }),
  ];
  const maxLines = Math.floor((height - margin * 2) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines));
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  const kids = [];
  pages.forEach((pageLines) => {
    const pageObj = objects.length + 1;
    const contentObj = objects.length + 2;
    kids.push(`${pageObj} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`);
    objects.push(streamForPage(pageLines, { margin, height, lineWidth, fontSize, leading }));
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  const pdf = buildPdf(objects);
  return { blob: new Blob([pdf], { type: "application/pdf" }), pages: pages.length };
}

function createTextPreviewDataUrl(text, createdAt, highlightText = "") {
  const { width, height, margin, fontSize, leading } = notePreviewLayout;
  const highlights = normalizeTraitHighlights(highlightText);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1e2724";
  context.textBaseline = "top";
  const lineWidth = canvas.width - margin * 2;
  const measureText = (value, bold = false) => {
    context.font = `${bold ? "700" : "400"} ${fontSize}px Arial, sans-serif`;
    return context.measureText(value).width;
  };
  const lines = [
    pdfLine(`Created: ${formatPdfTimestamp(createdAt)}`),
    blankPdfLine(),
    ...formattedPdfLines(text, { lineWidth, fontSize, measureText, highlights }),
  ];
  const maxPreviewLines = Math.floor((height - margin * 2) / leading);
  lines.slice(0, maxPreviewLines).forEach((line, index) => {
    drawPreviewLine(context, line, { margin, y: margin + index * leading, lineWidth, fontSize });
  });
  return canvas.toDataURL("image/png");
}

function streamForPage(lines, options) {
  const { margin, height, lineWidth, fontSize, leading } = options;
  const commands = [
    "BT",
    `/F1 ${fontSize} Tf`,
    `${leading} TL`,
    `${margin} ${height - margin} Td`,
    ...lines.flatMap((line) => pdfLineCommands(line, { fontSize, lineWidth })),
    "ET",
  ].join("\n");
  return `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
}

function pdfLineCommands(line, options) {
  if (!line || line.blank) return ["T*"];
  const commands = [];
  const indentWidth = pdfTextWidth(line.indent || "", false, options.fontSize);
  let activeBold = false;
  let activeKind = "text";
  commands.push(`/F1 ${options.fontSize} Tf`);
  commands.push(traitHighlightStyle.text.pdf);
  commands.push("0 Tw");
  if (line.indent) commands.push(`(${escapePdfString(line.indent)}) Tj`);
  const wordSpacing = pdfWordSpacing(line, Math.max(0, options.lineWidth - indentWidth), options.fontSize);
  if (wordSpacing > 0) commands.push(`${formatPdfNumber(wordSpacing)} Tw`);
  for (const segment of line.segments) {
    if (!segment.text) continue;
    const nextKind = segment.kind || "text";
    if (nextKind !== activeKind) {
      activeKind = nextKind;
      commands.push((traitHighlightStyle[activeKind] || traitHighlightStyle.text).pdf);
    }
    if (Boolean(segment.bold) !== activeBold) {
      activeBold = Boolean(segment.bold);
      commands.push(`/${activeBold ? "F2" : "F1"} ${options.fontSize} Tf`);
    }
    commands.push(`(${escapePdfString(segment.text)}) Tj`);
  }
  commands.push("0 Tw");
  if (activeKind !== "text") commands.push(traitHighlightStyle.text.pdf);
  commands.push("T*");
  return commands;
}

function drawPreviewLine(context, line, options) {
  if (!line || line.blank) return;
  let x = options.margin + measureCanvasText(context, line.indent || "", false, options.fontSize);
  const y = options.y;
  const availableWidth = Math.max(0, options.lineWidth - measureCanvasText(context, line.indent || "", false, options.fontSize));
  const wordSpacing = canvasWordSpacing(context, line, availableWidth, options.fontSize);
  if (line.indent) {
    context.font = `400 ${options.fontSize}px Arial, sans-serif`;
    context.fillText(line.indent, options.margin, y);
  }
  for (const segment of line.segments) {
    if (!segment.text) continue;
    context.font = `${segment.bold ? "700" : "400"} ${options.fontSize}px Arial, sans-serif`;
    context.fillStyle = (traitHighlightStyle[segment.kind || "text"] || traitHighlightStyle.text).canvas;
    x = drawPreviewTextSegment(context, segment.text, x, y, wordSpacing);
  }
}

function drawPreviewTextSegment(context, text, x, y, wordSpacing) {
  for (const part of String(text || "").split(/( )/g).filter((value) => value !== "")) {
    if (part === " ") {
      x += context.measureText(part).width + wordSpacing;
    } else {
      context.fillText(part, x, y);
      x += context.measureText(part).width;
    }
  }
  return x;
}

function measureCanvasText(context, value, bold, fontSize) {
  context.font = `${bold ? "700" : "400"} ${fontSize}px Arial, sans-serif`;
  return context.measureText(value).width;
}

function buildPdf(objects) {
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

function textPdfSource(value) {
  return normalizeForPdf(value)
    .replace(/[ \t]*\n+[ \t]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "")
    .trim();
}

function formattedPdfLines(value, options) {
  const source = textPdfSource(value);
  if (!source.trim()) return [blankPdfLine()];
  const boldRanges = traitFlavorRanges(source, options.highlights || {});
  const lines = [];
  let sourceOffset = 0;
  source.split("\n").forEach((rawLine) => {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const lineStart = sourceOffset;
    sourceOffset += rawLine.length + 1;
    if (!line.trim()) {
      lines.push(blankPdfLine());
      return;
    }
    const indent = line.match(/^[ ]*/)?.[0] || "";
    const content = line.slice(indent.length);
    const contentStart = lineStart + indent.length;
    const contentSegments = sourceRangeSegments(source, contentStart, contentStart + content.length, boldRanges);
    const continuationIndent = indent ? `${indent}  ` : "";
    const firstWidth = Math.max(120, options.lineWidth - options.measureText(indent, false, options.fontSize));
    const restWidth = Math.max(120, options.lineWidth - options.measureText(continuationIndent, false, options.fontSize));
    const wrapped = wrapRichTextSegments(contentSegments, { ...options, firstWidth, restWidth });
    wrapped.forEach((part, index) => {
      const lineIndent = index > 0 ? continuationIndent : indent;
      lines.push(pdfLineFromSegments(part.segments, {
        indent: lineIndent,
        justify: shouldJustifyPdfLine(content, part, index, wrapped.length),
      }));
    });
  });
  return lines.length ? lines : [blankPdfLine()];
}

function wrapRichText(text, options) {
  return wrapRichTextSegments(autismFlavorSegments(text), options);
}

function wrapRichTextSegments(segments, options) {
  const tokens = tokenizePdfSegments(segments);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  let maxWidth = options.firstWidth;
  for (const token of tokens) {
    if (!token.text) continue;
    const isSpace = /^\s+$/.test(token.text);
    const width = options.measureText(token.text, token.bold, options.fontSize);
    if (isSpace && !current.length) continue;
    if (current.length && currentWidth + width > maxWidth && !isSpace) {
      trimPdfLineTokens(current);
      lines.push({ segments: mergeAdjacentPdfSegments(current), width: currentWidth });
      current = [];
      currentWidth = 0;
      maxWidth = options.restWidth;
    }
    if (isSpace && !current.length) continue;
    current.push(token);
    currentWidth += width;
  }
  trimPdfLineTokens(current);
  if (current.length) lines.push({ segments: mergeAdjacentPdfSegments(current), width: currentWidth });
  return lines.length ? lines : [{ segments: [], width: 0 }];
}

function trimPdfLineTokens(tokens) {
  while (tokens.length && /^\s+$/.test(tokens[tokens.length - 1].text)) tokens.pop();
}

function pdfLine(text) {
  return pdfLineFromSegments([{ text: String(text || ""), bold: false }], { indent: "", justify: false });
}

function blankPdfLine() {
  return { blank: true, indent: "", segments: [], justify: false };
}

function pdfLineFromSegments(segments, options = {}) {
  return {
    blank: false,
    indent: options.indent || "",
    segments: mergeAdjacentPdfSegments(segments),
    justify: Boolean(options.justify),
  };
}

function shouldJustifyPdfLine(sourceLine, wrappedLine, index, total) {
  if (index >= total - 1) return false;
  if (/^\s*(?:[-*]|\d+[.)])\s+/.test(sourceLine)) return false;
  const text = wrappedLine.segments.map((segment) => segment.text).join("");
  return text.trim().split(/\s+/).length >= 5 && countPdfSpaces(wrappedLine.segments) >= 3;
}

function pdfWordSpacing(line, availableWidth, fontSize) {
  if (!line.justify) return 0;
  const spaces = countPdfSpaces(line.segments);
  if (spaces < 3) return 0;
  const used = line.segments.reduce((sum, segment) => sum + pdfTextWidth(segment.text, segment.bold, fontSize), 0);
  const extra = availableWidth - used;
  if (extra <= 0 || extra / spaces > 5.5) return 0;
  return extra / spaces;
}

function canvasWordSpacing(context, line, availableWidth, fontSize) {
  if (!line.justify) return 0;
  const spaces = countPdfSpaces(line.segments);
  if (spaces < 3) return 0;
  const used = line.segments.reduce((sum, segment) => sum + measureCanvasText(context, segment.text, segment.bold, fontSize), 0);
  const extra = availableWidth - used;
  if (extra <= 0 || extra / spaces > 9) return 0;
  return extra / spaces;
}

function countPdfSpaces(segments) {
  return segments.reduce((sum, segment) => sum + (segment.text.match(/ /g) || []).length, 0);
}

function tokenizePdfSegments(segments) {
  const tokens = [];
  for (const segment of segments) {
    for (const part of String(segment.text || "").split(/(\s+)/).filter(Boolean)) {
      tokens.push({ text: part, bold: segment.bold, kind: segment.kind || "text" });
    }
  }
  return tokens;
}

function mergeAdjacentPdfSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.bold === segment.bold && (previous.kind || "text") === (segment.kind || "text")) {
      previous.text += segment.text;
    } else {
      merged.push({ text: segment.text, bold: Boolean(segment.bold), kind: segment.kind || "text" });
    }
  }
  return merged;
}

function autismFlavorSegments(text) {
  const source = String(text || "");
  const ranges = autismFlavorRanges(source);
  return sourceRangeSegments(source, 0, source.length, ranges);
}

function sourceRangeSegments(source, start, end, ranges) {
  const slice = String(source || "").slice(start, end);
  if (!ranges.length) return [{ text: slice, bold: false, kind: "text" }];
  const segments = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    const rangeStart = Math.max(start, range.start);
    const rangeEnd = Math.min(end, range.end);
    if (rangeStart > cursor) segments.push({ text: source.slice(cursor, rangeStart), bold: false, kind: "text" });
    segments.push({ text: source.slice(rangeStart, rangeEnd), bold: true, kind: range.kind || "autism" });
    cursor = rangeEnd;
  }
  if (cursor < end) segments.push({ text: source.slice(cursor, end), bold: false, kind: "text" });
  return segments;
}

function normalizeTraitHighlights(input) {
  if (typeof input === "string") return { autism: input, adhd: "" };
  return {
    autism: String(input?.autism || ""),
    adhd: String(input?.adhd || ""),
  };
}

function traitFlavorRanges(text, highlights) {
  const normalized = normalizeTraitHighlights(highlights);
  const ranges = [];
  for (const range of autismFlavorRanges(text, normalized.autism)) {
    if (range && range.end > range.start && !rangeOverlapsAny(range, ranges)) {
      ranges.push({ ...range, kind: "autism" });
    }
  }
  let adhdAdded = false;
  for (const range of adhdFlavorRanges(text, normalized.adhd)) {
    if (range && range.end > range.start && !rangeOverlapsAny(range, ranges)) {
      ranges.push({ ...range, kind: "adhd" });
      adhdAdded = true;
      break;
    }
  }
  if (!adhdAdded && normalized.adhd) {
    const alternate = alternateAdhdRangeAvoiding(text, ranges);
    if (alternate) ranges.push({ ...alternate, kind: "adhd" });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function rangeOverlapsAny(candidate, ranges) {
  return ranges.some((range) => candidate.start < range.end && candidate.end > range.start);
}

function alternateAdhdRangeAvoiding(text, blockedRanges) {
  const source = String(text || "");
  const candidates = [];
  const pattern = /[^,.;:!?\n]+/g;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[0] || "";
    const trimmed = raw.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 4) continue;
    const range = clauseRangeForPhrase(source, trimmed, match.index, 18);
    if (!range) continue;
    if (rangeOverlapsAny(range, blockedRanges)) continue;
    candidates.push({
      ...range,
      score: fallbackAdhdClauseScore(source.slice(range.start, range.end)),
    });
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start))[0];
}

function autismFlavorRanges(text, highlightText = "") {
  const preferred = preferredHighlightRange(text, highlightText);
  if (preferred) return [preferred];
  const candidates = [];
  const patterns = [
    { pattern: /\b(?:i\s+)?need to know what'?s going to happen\b/gi, weight: 140, exact: true },
    { pattern: /\b(?:need to know|what'?s going to happen|know for a fact|if-then|certainty|uncertainty|predictable|predictability|proof|make sure)\b/gi, weight: 108 },
    { pattern: /\b(?:overwhelm|overwhelmed|overwhelming|panic|shutdown|meltdown|spiral|body stops feeling alert|body feel(?:s)? unsafe)\b/gi, weight: 106 },
    { pattern: /\b(?:sensory|metal box|fluorescent|sound|noise|comfort|comfortable|safe|safety|body|bumpy|smooth|quiet|texture|light|smell)\b/gi, weight: 104 },
    { pattern: /\b(?:routine|routines|transition|transitions|switching|same|stable|change|changes|back and forth|commitment|commit)\b/gi, weight: 100 },
    { pattern: /\b(?:masking|mask|camouflage|appear normal|fit in|hide|compensate)\b/gi, weight: 98 },
    { pattern: /\b(?:social cues|eye contact|text back|respond|relationship|conversation|tone|misread|blunt|block me|love me|social)\b/gi, weight: 96 },
    { pattern: /\b(?:special interest|fixed preference|focused interest|fixated|exact|details|rules|patterns|categories|system)\b/gi, weight: 94 },
    { pattern: /\b(?:autism|autistic|asd|diagnosis|diagnostic evaluation)\b/gi, weight: 78 },
  ];
  for (const { pattern, weight, exact } of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const range = exact
        ? { start: match.index, end: match.index + match[0].length }
        : expandAutismFlavorRange(text, match.index, match.index + match[0].length);
      candidates.push({
        ...range,
        score: weight + Math.min(18, range.end - range.start) + Math.min(8, match[0].length),
      });
    }
  }
  if (!candidates.length) {
    const fallback = fallbackAutismFlavorRange(text);
    return fallback ? [fallback] : [];
  }
  const best = candidates.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start))[0];
  return [{ start: best.start, end: best.end }];
}

function adhdFlavorRanges(text, highlightText = "") {
  const preferred = preferredHighlightRange(text, highlightText);
  if (preferred) return [preferred];
  const candidates = [];
  const patterns = [
    { pattern: /\b(?:i\s+)?(?:can'?t|cant|cannot) concentrate unless [^,.;:!?]{0,80}?(?:interesting|lock onto|locks on)\b[^,.;:!?]*/gi, weight: 150, exact: false },
    { pattern: /\b(?:i\s+)?(?:can'?t|cant|cannot) focus unless [^,.;:!?]{0,80}?(?:interesting|urgent|lock onto|locks on)\b[^,.;:!?]*/gi, weight: 148, exact: false },
    { pattern: /\b(?:can't concentrate|cant concentrate|attention gets pulled|hard to focus|focus for hours|only focus if|interesting enough)\b/gi, weight: 132, exact: true },
    { pattern: /\b(?:attention|focus|focusing|distract(?:ed|ible|ion)?|sustained attention|too boring|boring|zoning out|concentrate|one simple thing to focus on|one thing|stay on)\b/gi, weight: 108 },
    { pattern: /\b(?:executive function(?:ing)?|procrastinat(?:e|ing|ion)|follow through|finish(?:ing)? (?:the )?task|starting? (?:the )?task|can't start|cant start|cannot start|task(?:s)?|too many steps|setup steps|make myself|get started|getting started|stuck (?:on|with) (?:the )?task|mental load|warm[- ]?up period|ramp(?:ing)? up|activation energy|getting into|start friction|task friction|lost momentum|motivation)\b/gi, weight: 112 },
    { pattern: /\b(?:forget(?:ting|s|ful)?|lose|lost|misplace|time(?: blindness)?|deadline|late|appointment|calendar|schedule|organize(?:d|ing|ation)?|planning|priority|prioritize)\b/gi, weight: 104 },
    { pattern: /\b(?:impuls(?:e|ive|ivity)|interrupt|blurting?|can't wait|cant wait|impulse spend(?:ing)?|spend(?:ing)? impulsively|impulse buy(?:ing)?|buy(?:ing)? impulsively|switch tabs|jump(?:ing)? between|act first)\b/gi, weight: 100 },
    { pattern: /\b(?:restless|fidget(?:ing)?|squirm|on the go|driven by a motor|can't sit|cant sit|pace|pacing|body wants to move)\b/gi, weight: 96 },
    { pattern: /\b(?:overwhelm(?:ed|ing)?|frustrat(?:ed|ion|ing)?|irritab(?:le|ility)|angry|annoy(?:ed|ing)?|stress(?:ed|ful)?|emotional|mood|panic|too much)\b/gi, weight: 94 },
    { pattern: /\b(?:hyperfocus|deep focus|intense focus|fixat(?:e|ed|ion)|can focus for hours|one thing for hours|locked in)\b/gi, weight: 98 },
    { pattern: /\b(?:adhd|attention[- ]deficit|hyperactivity disorder|inattention|hyperactive|impulsive)\b/gi, weight: 76 },
  ];
  for (const { pattern, weight, exact } of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const range = exact
        ? { start: match.index, end: match.index + match[0].length }
        : expandAdhdFlavorRange(text, match.index, match.index + match[0].length);
      candidates.push({
        ...range,
        score: weight + Math.min(18, range.end - range.start) + Math.min(8, match[0].length),
      });
    }
  }
  if (!candidates.length) {
    const fallback = fallbackAdhdFlavorRange(text);
    return fallback ? [fallback] : [];
  }
  const best = candidates.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start))[0];
  return [{ start: best.start, end: best.end }];
}

function fallbackAdhdFlavorRange(text) {
  const source = String(text || "");
  const clauses = source
    .split(/[,.;:!?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).filter(Boolean).length >= 4);
  if (!clauses.length) return null;
  const scored = clauses.map((clause) => ({
    clause,
    score: fallbackAdhdClauseScore(clause),
  })).sort((a, b) => b.score - a.score || b.clause.length - a.clause.length);
  return clauseRangeForPhrase(source, scored[0].clause, 0, 18);
}

function fallbackAdhdClauseScore(clause) {
  const text = clause.toLowerCase();
  let score = Math.min(16, clause.length / 6);
  if (/\bfocus|attention|task|start|finish|time|forget|organize|priority|boring|interesting enough|warm[- ]?up|ramp|activation energy|getting into|setup steps|getting started|task friction|lost momentum|motivation\b/.test(text)) score += 14;
  if (/\bfrustrat|overwhelm|hard|stuck|too much|can't|cant|cannot\b/.test(text)) score += 8;
  if (/\bi\b|\bme\b|\bmy\b/.test(text)) score += 4;
  if (/\bneed|want|only|simple|exactly|make sure\b/.test(text)) score += 3;
  return score;
}

function preferredHighlightRange(text, highlightText) {
  const source = String(text || "");
  const phrase = textPdfSource(highlightText || "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (phrase.split(/\s+/).filter(Boolean).length < 2) return null;
  const pattern = new RegExp(phrase.split(/\s+/).map(escapeRegex).join("\\s+"), "i");
  const match = pattern.exec(source);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fallbackAutismFlavorRange(text) {
  const source = String(text || "");
  const clauses = source
    .split(/[,.;:!?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).filter(Boolean).length >= 4);
  if (!clauses.length) {
    const fallback = source.match(/\S+(?:\s+\S+){0,7}/);
    return fallback ? { start: fallback.index, end: fallback.index + fallback[0].length } : null;
  }
  const scored = clauses.map((clause) => ({
    clause,
    score: fallbackClauseScore(clause),
  })).sort((a, b) => b.score - a.score || b.clause.length - a.clause.length);
  return clauseRangeForPhrase(source, scored[0].clause, 0, 16);
}

function fallbackClauseScore(clause) {
  const text = clause.toLowerCase();
  let score = Math.min(20, clause.length / 5);
  if (/\bi\b|\bme\b|\bmy\b/.test(text)) score += 8;
  if (/\bneed|hard|always|never|only|exact|feel|body|think|know|cannot|can't\b/.test(text)) score += 6;
  if (/\bwork|career|relationship|people|focus|plan|safe|comfort\b/.test(text)) score += 4;
  return score;
}

function expandAutismFlavorRange(text, start, end) {
  const leftBoundary = Math.max(0, text.slice(0, start).search(/[^,.;:!?]*$/));
  const rightMatch = text.slice(end).match(/^[^,.;:!?]*/);
  const rawStart = leftBoundary;
  const rawEnd = end + (rightMatch ? rightMatch[0].length : 0);
  return trimRangeToWords(text, rawStart, rawEnd, start, end, 16);
}

function expandAdhdFlavorRange(text, start, end) {
  const leftBoundary = Math.max(0, text.slice(0, start).search(/[^,.;:!?]*$/));
  const rightMatch = text.slice(end).match(/^[^,.;:!?]*/);
  const rawStart = leftBoundary;
  const rawEnd = end + (rightMatch ? rightMatch[0].length : 0);
  return trimRangeToWords(text, rawStart, rawEnd, start, end, 18);
}

function trimRangeToWords(text, start, end, focusStart, focusEnd, maxWords) {
  const source = String(text || "");
  const clippedStart = Math.max(0, Math.min(start, source.length));
  const clippedEnd = Math.max(clippedStart, Math.min(end, source.length));
  const raw = source.slice(clippedStart, clippedEnd).trim();
  if (!raw) return { start: focusStart, end: focusEnd };
  const focusRawStart = Math.max(0, focusStart - clippedStart);
  const focusRawEnd = Math.max(focusRawStart, focusEnd - clippedStart);
  const phrase = completePhraseAroundFocus(raw, focusRawStart, focusRawEnd, maxWords);
  const phraseIndex = source.indexOf(phrase, clippedStart);
  if (phrase && phraseIndex >= 0) return { start: phraseIndex, end: phraseIndex + phrase.length };
  return { start: focusStart, end: focusEnd };
}

function clauseRangeForPhrase(source, phrase, fromIndex = 0, maxWords = 18) {
  const clean = completeHighlightPhrase(phrase, maxWords);
  if (!clean) return null;
  const start = String(source || "").indexOf(clean, Math.max(0, fromIndex));
  return start >= 0 ? { start, end: start + clean.length } : null;
}

function completePhraseAroundFocus(raw, focusStart, focusEnd, maxWords = 18) {
  const source = String(raw || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const focusMid = Math.max(0, Math.min(source.length, Math.floor((focusStart + focusEnd) / 2)));
  const candidates = completePhraseCandidates(source)
    .filter((candidate) => candidate.start <= focusMid && candidate.end >= focusMid)
    .sort((a, b) => phraseFitScore(b.text, maxWords) - phraseFitScore(a.text, maxWords));
  const best = candidates[0]?.text || source;
  return completeHighlightPhrase(best, maxWords);
}

function completePhraseCandidates(source) {
  const text = String(source || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const splits = [];
  const pattern = /\s+(?:because|but|so|and then|and i|and it|when|whereas|which)\s+/gi;
  let match;
  while ((match = pattern.exec(text))) {
    splits.push(match.index);
    splits.push(match.index + match[0].length);
  }
  const paren = text.indexOf("(");
  if (paren > 0) {
    splits.push(paren);
    splits.push(paren + 1);
  }
  const points = [...new Set([0, ...splits, text.length])].sort((a, b) => a - b);
  const candidates = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const value = text.slice(start, end).trim();
    if (value.split(/\s+/).filter(Boolean).length >= 3) {
      const leadingSpaces = text.slice(start).search(/\S/);
      const actualStart = leadingSpaces >= 0 ? start + leadingSpaces : start;
      candidates.push({ start: actualStart, end: end, text: value });
    }
  }
  candidates.push({ start: 0, end: text.length, text });
  return candidates;
}

function phraseFitScore(value, maxWords) {
  const words = String(value || "").split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (words >= 4) score += 20;
  if (words <= maxWords) score += 20;
  if (!isDanglingHighlight(value)) score += 12;
  if (words >= 5 && words <= Math.max(8, maxWords)) score += 8;
  return score - Math.abs(words - Math.min(maxWords, 10));
}

function completeHighlightPhrase(value, maxWords = 18) {
  const clean = stripHighlightLeadIn(textPdfSource(value || "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\*\*/g, "")
    .trim());
  if (!clean) return "";
  const candidate = bestCompleteHighlightSegment(clean, maxWords);
  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords && !isDanglingHighlight(candidate)) return candidate;
  const clipped = clippedCompleteWords(words, maxWords);
  return clipped.join(" ");
}

function bestCompleteHighlightSegment(value, maxWords) {
  const candidates = completePhraseCandidates(value)
    .map((candidate) => candidate.text.trim())
    .filter((candidate) => candidate.split(/\s+/).filter(Boolean).length >= 3);
  if (candidates.length <= 1) return value;
  return candidates
    .sort((a, b) => completeHighlightSegmentScore(b, maxWords) - completeHighlightSegmentScore(a, maxWords))[0];
}

function completeHighlightSegmentScore(value, maxWords) {
  const text = textPdfSource(value || "").toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = phraseFitScore(text, maxWords);
  if (/\b(?:focus|attention|concentrat|interesting|boring|task|start|finish|time|forget|organize|priority|frustrat|overwhelm|restless|fidget|impuls|hyperfocus|warm[- ]?up|ramp|getting into|stuck)\b/.test(text)) score += 18;
  if (/\b(?:predict|certainty|uncertain|know|safe|comfort|sensory|same|switch|routine|social|mask|exact|rule|pattern|body|standard|goal|confus|not know|don't know|never-ending|infinite)\b/.test(text)) score += 12;
  if (/\b(?:disney|imagineer|r&d|research|career|money|rich|car|a3|soft robotics|robotics|prototype|mechanism|paper|phd|portfolio|goal|system|workflow)\b/.test(text)) score += 16;
  if (isWeakHighlight(text)) score -= 45;
  if (words > maxWords) score -= 20;
  return score;
}

function clippedCompleteWords(words, maxWords) {
  const output = words.slice(0, Math.max(1, maxWords));
  while (output.length < words.length && isDanglingHighlight(output.join(" "))) {
    output.push(words[output.length]);
  }
  while (output.length > 1 && isDanglingHighlight(output.join(" "))) {
    output.pop();
  }
  return output;
}

function stripHighlightLeadIn(value) {
  return String(value || "")
    .replace(/^(?:and|but|so)\s+/i, "")
    .trim();
}

function isWeakHighlight(value) {
  const text = textPdfSource(value || "").toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (!text || words.length < 5) return true;
  if (isDanglingHighlight(text)) return true;
  if (/^(?:about|the thing|thing|stuff|while|when|because|like|ok so)\b/.test(text)) return true;
  if (/^(?:about that every day|that every day|about it|that part|the thing|this thing|that thing|while driving|kind of frustrating because i don't know|this uncertainty is making me kind|i was telling me how this is the same thing)\b/.test(text)) return true;
  if (/\.\.\.|…/.test(text)) return true;
  if (/\b(?:i do a lot of prompting for codex and chatgpt|does a lot of prompting for codex and chatgpt|i mean theres silly and then theres hi hitler|thinking about research for the day|playing violin for the day|sparkling water is like the same|relationships are fucking learning all the time|the main strain is starting not the topics themselves|same with da ua|thing that does something and then the giant thing)\b/.test(text)) return true;
  const pronouns = words.filter((word) => /^(?:i|me|my|it|that|this|they|them|he|she|we|you|something|thing|stuff)$/i.test(word)).length;
  return pronouns / words.length > 0.45;
}

function isDanglingHighlight(value) {
  const text = textPdfSource(value || "").toLowerCase();
  return /\b(?:kind of|sort of|a lot of|one of|because of)$/.test(text)
    || /[,;:]$/.test(text)
    || /\b(?:that|that's|to|i|i'm|im|cant|can't|cannot|because|like|of|for|with|while|when|if|the|a|an|and|or|but|so|as|be|more|less)$/.test(text)
    || /\b(?:that's|that is)\s+kind$/.test(text);
}

function pdfTextWidth(text, bold = false, fontSize = 10.5) {
  let units = 0;
  for (const char of String(text || "")) units += pdfCharWidth(char);
  return (units / 1000) * fontSize * (bold ? 1.035 : 1);
}

function pdfCharWidth(char) {
  if (char === " ") return 278;
  if ("il.,:;'|!()[]".includes(char)) return 278;
  if ("mwMW".includes(char)) return char === "W" ? 944 : 833;
  if ("ABCDEFGHKNOPQRSTUVXYZ".includes(char)) return 667;
  if ("0123456789".includes(char)) return 556;
  if ("-_/".includes(char)) return 333;
  if (/[A-Z]/.test(char)) return 610;
  if (/[a-z]/.test(char)) return 500;
  return 500;
}

function formatPdfNumber(value) {
  return Number(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPdfTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleString([], { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
}

function normalizeForPdf(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2022\u2023\u2043\u25E6]/g, "-")
    .replace(/\*\*/g, "")
    .replace(/\t/g, "    ")
    .replace(/\u2026/g, "...")
    .replace(/[^\n\t\x20-\x7E]/g, " ");
}

function escapePdfString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function openBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  openUrls.push(url);
  const win = window.open(url, "_blank", "noopener");
  if (!win) downloadBlob(blob, name);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  openUrls.push(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "brain-file";
  document.body.append(link);
  link.click();
  link.remove();
}

function revokeOpenUrls() {
  openUrls.forEach((url) => URL.revokeObjectURL(url));
  openUrls = [];
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function readableUploadText(file) {
  if (file.type?.startsWith("text/") || /\.(txt|md|csv|json|pdf)$/i.test(file.name || "")) {
    return (await file.text().catch(() => "")).slice(0, 60000);
  }
  return "";
}

async function analyzeRecordText({ name, mime, kind, text }) {
  const readable = textPdfSource(text || "");
  const fallbackBasis = readable || `${name || ""} ${kind || ""} ${mime || ""}`;
  const fallback = {
    autism: analyzeAutismText(fallbackBasis),
    adhd: analyzeAdhdText(fallbackBasis),
    lifeLeverage: analyzeLifeLeverageText(fallbackBasis),
  };
  if (sync.status !== "connected" || !sync.base) {
    return fallbackAnalysis(fallback, "sync not connected");
  }
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await postJson(`${sync.base}/api/analyze`, {
        name: name || "",
        kind: kind || "",
        mime: mime || "",
        text: readable,
        fallbackScore: fallback.autism.score,
        fallbackAdhdScore: fallback.adhd.score,
        fallbackLifeLeverageScore: fallback.lifeLeverage.score,
      });
      return normalizeRemoteAnalysis(response.analysis, fallback);
    } catch (error) {
      lastError = error?.message || "AI analysis unavailable";
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
    }
  }
  return fallbackAnalysis(fallback, lastError || "AI analysis unavailable");
}

function normalizeRemoteAnalysis(analysis, fallback) {
  const autism = normalizeRemoteTraitAnalysis({
    score: analysis?.score,
    explanation: analysis?.explanation || analysis?.analysis,
    highlightText: analysis?.highlightText,
    highlightExplanation: analysis?.highlightExplanation,
    model: analysis?.model,
    textChars: analysis?.textChars,
  }, fallback.autism, "AI autism analysis returned no explanation");
  const hasAdhdAnalysis = analysis?.adhdScore || analysis?.adhdExplanation || analysis?.adhdAnalysis || analysis?.adhdHighlightText;
  const adhd = hasAdhdAnalysis
    ? normalizeRemoteTraitAnalysis({
      score: analysis?.adhdScore,
      explanation: analysis?.adhdExplanation || analysis?.adhdAnalysis,
      highlightText: analysis?.adhdHighlightText,
      highlightExplanation: analysis?.adhdHighlightExplanation,
      model: analysis?.model,
      textChars: analysis?.textChars,
    }, fallback.adhd, "AI ADHD analysis returned no explanation")
    : fallbackTraitAnalysis(fallback.adhd, "AI ADHD analysis unavailable");
  const hasLifeLeverageAnalysis = analysis?.lifeLeverageScore || analysis?.lifeLeverageExplanation || analysis?.lifeLeverageAnalysis || analysis?.lifeLeverageHighlightText;
  const lifeLeverage = hasLifeLeverageAnalysis
    ? normalizeRemoteScoreAnalysis({
      score: analysis?.lifeLeverageScore,
      explanation: analysis?.lifeLeverageExplanation || analysis?.lifeLeverageAnalysis,
      highlightText: analysis?.lifeLeverageHighlightText,
      highlightExplanation: analysis?.lifeLeverageHighlightExplanation,
      model: analysis?.model,
      textChars: analysis?.textChars,
    }, fallback.lifeLeverage, "AI Disney score analysis returned no explanation")
    : fallbackTraitAnalysis(fallback.lifeLeverage, "AI Disney score analysis unavailable");
  return { autism, adhd, lifeLeverage };
}

function normalizeRemoteTraitAnalysis(analysis, fallback, warning) {
  const score = clampAutismScore(analysis?.score ?? fallback?.score);
  const explanation = String(analysis?.explanation || "").replace(/\s+/g, " ").trim();
  if (!explanation) return fallbackTraitAnalysis(fallback, warning);
  return {
    score: Math.max(1, score),
    explanation: explanation.slice(0, 900),
    highlightText: normalizeHighlightText(analysis?.highlightText || fallback?.highlightText || ""),
    highlightExplanation: normalizeHighlightExplanation(analysis?.highlightExplanation || fallback?.highlightExplanation || ""),
    scoreSource: "ai",
    scoreModel: String(analysis?.model || "OpenAI").slice(0, 80),
    scoreConfidence: "medium",
    scoreWarning: "",
    textChars: Math.max(0, Number(analysis?.textChars || 0)),
  };
}

function normalizeRemoteScoreAnalysis(analysis, fallback, warning) {
  const score = clampAutismScore(analysis?.score ?? fallback?.score);
  const explanation = String(analysis?.explanation || "").replace(/\s+/g, " ").trim();
  if (!explanation) return fallbackTraitAnalysis(fallback, warning);
  return {
    score,
    explanation: explanation.slice(0, 900),
    highlightText: normalizeHighlightText(analysis?.highlightText || fallback?.highlightText || ""),
    highlightExplanation: normalizeHighlightExplanation(analysis?.highlightExplanation || fallback?.highlightExplanation || ""),
    scoreSource: "ai",
    scoreModel: String(analysis?.model || "OpenAI").slice(0, 80),
    scoreConfidence: "medium",
    scoreWarning: "",
    textChars: Math.max(0, Number(analysis?.textChars || 0)),
  };
}

function fallbackAnalysis(fallback, warning) {
  if (fallback?.autism || fallback?.adhd) {
    return {
      autism: fallbackTraitAnalysis(fallback.autism, warning),
      adhd: fallbackTraitAnalysis(fallback.adhd, warning),
      lifeLeverage: fallbackTraitAnalysis(fallback.lifeLeverage, warning),
    };
  }
  return fallbackTraitAnalysis(fallback, warning);
}

function fallbackTraitAnalysis(fallback, warning) {
  return {
    ...fallback,
    scoreSource: "heuristic",
    scoreModel: "browser heuristic",
    scoreConfidence: "low",
    scoreWarning: warning || "AI analysis unavailable",
    textChars: Math.max(0, Number(fallback?.textChars || 0)),
  };
}

function analysisRecordFields(analysis, textChars = 0, file = {}) {
  const basis = `${file?.name || ""} ${file?.kind || ""} ${file?.mime || ""} ${file?.sourceText || ""}`;
  const autism = analysis?.autism || analysis || analyzeAutismText(basis);
  const adhd = analysis?.adhd || analyzeAdhdText(basis);
  const lifeLeverage = analysis?.lifeLeverage || analyzeLifeLeverageText(basis);
  return {
    autismScore: clampAutismScore(autism?.score),
    autismScoreExplanation: normalizeAnalysisExplanation(autism?.explanation),
    autismHighlightText: normalizeHighlightText(autism?.highlightText || ""),
    autismHighlightExplanation: normalizeHighlightExplanation(autism?.highlightExplanation || ""),
    autismScoreSource: autism?.scoreSource || "heuristic",
    autismScoreModel: autism?.scoreModel || "browser heuristic",
    autismScoreConfidence: autism?.scoreConfidence || "low",
    autismScoreWarning: autism?.scoreWarning || "",
    autismTextChars: Math.max(0, Number(autism?.textChars || textChars || 0)),
    adhdScore: clampAutismScore(adhd?.score),
    adhdScoreExplanation: normalizeAnalysisExplanation(adhd?.explanation),
    adhdHighlightText: normalizeHighlightText(adhd?.highlightText || ""),
    adhdHighlightExplanation: normalizeHighlightExplanation(adhd?.highlightExplanation || ""),
    adhdScoreSource: adhd?.scoreSource || "heuristic",
    adhdScoreModel: adhd?.scoreModel || "browser heuristic",
    adhdScoreConfidence: adhd?.scoreConfidence || "low",
    adhdScoreWarning: adhd?.scoreWarning || "",
    adhdTextChars: Math.max(0, Number(adhd?.textChars || textChars || 0)),
    lifeLeverageScore: clampAutismScore(lifeLeverage?.score),
    lifeLeverageExplanation: normalizeAnalysisExplanation(lifeLeverage?.explanation),
    lifeLeverageHighlightText: normalizeHighlightText(lifeLeverage?.highlightText || ""),
    lifeLeverageHighlightExplanation: normalizeHighlightExplanation(lifeLeverage?.highlightExplanation || ""),
    lifeLeverageScoreSource: lifeLeverage?.scoreSource || "heuristic",
    lifeLeverageScoreModel: lifeLeverage?.scoreModel || "browser heuristic",
    lifeLeverageScoreConfidence: lifeLeverage?.scoreConfidence || "low",
    lifeLeverageScoreWarning: lifeLeverage?.scoreWarning || "",
    lifeLeverageTextChars: Math.max(0, Number(lifeLeverage?.textChars || textChars || 0)),
    analysisQualityVersion,
  };
}

function autismScoreForRecord(item) {
  if (item && item.autismScore !== undefined && item.autismScore !== null && item.autismScore !== "") {
    return clampAutismScore(item.autismScore);
  }
  return analyzeAutismText(recordAnalysisBasis(item)).score;
}

function autismExplanationForRecord(item) {
  if (item?.autismScoreExplanation) return String(item.autismScoreExplanation).slice(0, 900);
  return analyzeAutismText(recordAnalysisBasis(item)).explanation;
}

function autismScoreSourceForRecord(item) {
  const source = String(item?.autismScoreSource || item?.scoreSource || "").toLowerCase().trim();
  if (source === "ai" || source === "heuristic") return source;
  return "";
}

function autismScoreModelForRecord(item) {
  return String(item?.autismScoreModel || item?.scoreModel || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function autismScoreConfidenceForRecord(item) {
  const confidence = String(item?.autismScoreConfidence || item?.scoreConfidence || "").toLowerCase().trim();
  return ["low", "medium", "high"].includes(confidence) ? confidence : "";
}

function autismScoreWarningForRecord(item) {
  return String(item?.autismScoreWarning || item?.scoreWarning || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function autismTextCharsForRecord(item) {
  return Math.max(0, Number(item?.autismTextChars || item?.textChars || 0));
}

function autismHighlightForRecord(item) {
  return {
    text: autismHighlightTextForRecord(item),
    explanation: autismHighlightExplanationForRecord(item),
  };
}

function autismHighlightTextForRecord(item) {
  if (!isGeneratedPdf(item)) return "";
  if (item?.autismHighlightText) return normalizeHighlightText(item.autismHighlightText);
  const fallback = analyzeAutismText(recordAnalysisBasis(item));
  return normalizeHighlightText(fallback.highlightText || "");
}

function autismHighlightExplanationForRecord(item) {
  if (!isGeneratedPdf(item)) return "";
  if (item?.autismHighlightExplanation) return normalizeHighlightExplanation(item.autismHighlightExplanation);
  const fallback = analyzeAutismText(recordAnalysisBasis(item));
  return normalizeHighlightExplanation(fallback.highlightExplanation || "");
}

function adhdScoreForRecord(item) {
  if (item && item.adhdScore !== undefined && item.adhdScore !== null && item.adhdScore !== "") {
    return clampAutismScore(item.adhdScore);
  }
  return analyzeAdhdText(recordAnalysisBasis(item)).score;
}

function adhdExplanationForRecord(item) {
  if (item?.adhdScoreExplanation) return normalizeAnalysisExplanation(item.adhdScoreExplanation);
  return analyzeAdhdText(recordAnalysisBasis(item)).explanation;
}

function adhdScoreSourceForRecord(item) {
  const source = String(item?.adhdScoreSource || "").toLowerCase().trim();
  if (source === "ai" || source === "heuristic") return source;
  return "";
}

function adhdScoreModelForRecord(item) {
  return String(item?.adhdScoreModel || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function adhdScoreConfidenceForRecord(item) {
  const confidence = String(item?.adhdScoreConfidence || "").toLowerCase().trim();
  return ["low", "medium", "high"].includes(confidence) ? confidence : "";
}

function adhdScoreWarningForRecord(item) {
  return String(item?.adhdScoreWarning || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function adhdTextCharsForRecord(item) {
  return Math.max(0, Number(item?.adhdTextChars || 0));
}

function lifeLeverageAnalysisForRecord(item) {
  return {
    score: lifeLeverageScoreForRecord(item),
    explanation: lifeLeverageExplanationForRecord(item),
    highlightText: lifeLeverageHighlightTextForRecord(item),
    highlightExplanation: lifeLeverageHighlightExplanationForRecord(item),
    scoreSource: lifeLeverageScoreSourceForRecord(item) || "heuristic",
    scoreModel: lifeLeverageScoreModelForRecord(item) || "browser heuristic",
    scoreConfidence: lifeLeverageScoreConfidenceForRecord(item) || "low",
    scoreWarning: lifeLeverageScoreWarningForRecord(item),
    textChars: lifeLeverageTextCharsForRecord(item),
  };
}

function lifeLeverageScoreForRecord(item) {
  if (item && item.lifeLeverageScore !== undefined && item.lifeLeverageScore !== null && item.lifeLeverageScore !== "") {
    return clampAutismScore(item.lifeLeverageScore);
  }
  return analyzeLifeLeverageText(recordAnalysisBasis(item)).score;
}

function lifeLeverageExplanationForRecord(item) {
  if (item?.lifeLeverageExplanation) return normalizeAnalysisExplanation(item.lifeLeverageExplanation);
  return analyzeLifeLeverageText(recordAnalysisBasis(item)).explanation;
}

function lifeLeverageHighlightTextForRecord(item) {
  if (item?.lifeLeverageHighlightText) return normalizeHighlightText(item.lifeLeverageHighlightText);
  if (!isGeneratedPdf(item) && !item?.sourceText) return "";
  const fallback = analyzeLifeLeverageText(recordAnalysisBasis(item));
  return normalizeHighlightText(fallback.highlightText || "");
}

function lifeLeverageHighlightExplanationForRecord(item) {
  if (item?.lifeLeverageHighlightExplanation) return normalizeHighlightExplanation(item.lifeLeverageHighlightExplanation);
  if (!isGeneratedPdf(item) && !item?.sourceText) return "";
  const fallback = analyzeLifeLeverageText(recordAnalysisBasis(item));
  return normalizeHighlightExplanation(fallback.highlightExplanation || "");
}

function lifeLeverageScoreSourceForRecord(item) {
  const source = String(item?.lifeLeverageScoreSource || "").toLowerCase().trim();
  if (source === "ai" || source === "heuristic") return source;
  return "";
}

function lifeLeverageScoreModelForRecord(item) {
  return String(item?.lifeLeverageScoreModel || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function lifeLeverageScoreConfidenceForRecord(item) {
  const confidence = String(item?.lifeLeverageScoreConfidence || "").toLowerCase().trim();
  return ["low", "medium", "high"].includes(confidence) ? confidence : "";
}

function lifeLeverageScoreWarningForRecord(item) {
  return String(item?.lifeLeverageScoreWarning || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function lifeLeverageTextCharsForRecord(item) {
  return Math.max(0, Number(item?.lifeLeverageTextChars || 0));
}

function adhdHighlightTextForRecord(item) {
  if (!isGeneratedPdf(item)) return "";
  if (item?.adhdHighlightText) return normalizeHighlightText(item.adhdHighlightText);
  if (!item?.sourceText) return "";
  return normalizeHighlightText(analyzeAdhdText(recordAnalysisBasis(item)).highlightText || "");
}

function adhdHighlightExplanationForRecord(item) {
  if (!isGeneratedPdf(item)) return "";
  if (item?.adhdHighlightExplanation) return normalizeHighlightExplanation(item.adhdHighlightExplanation);
  if (!item?.sourceText) return "";
  return normalizeHighlightExplanation(analyzeAdhdText(recordAnalysisBasis(item)).highlightExplanation || "");
}

async function adhdAnalysisForRecord(item) {
  const key = item?.id || `${item?.name || ""}-${item?.createdAt || ""}`;
  if (key && adhdAnalysisCache.has(key)) return adhdAnalysisCache.get(key);
  let sourceText = item?.sourceText || "";
  if (!item?.adhdScoreExplanation && !sourceText) {
    sourceText = await pdfTextForRecord(item);
  }
  if (!item?.adhdScoreExplanation && sourceText) {
    const analysis = analyzeAdhdText(sourceText);
    const computed = {
      score: analysis.score,
      explanation: analysis.explanation,
      highlightText: analysis.highlightText,
      highlightExplanation: analysis.highlightExplanation,
      scoreSource: "heuristic",
      scoreModel: "browser heuristic",
      scoreConfidence: "low",
      scoreWarning: "older synced PDF analyzed from file text",
      textChars: analysis.textChars,
    };
    if (item) {
      item.sourceText = sourceText;
      Object.assign(item, {
        adhdScore: computed.score,
        adhdScoreExplanation: computed.explanation,
        adhdHighlightText: computed.highlightText,
        adhdHighlightExplanation: computed.highlightExplanation,
        adhdScoreSource: computed.scoreSource,
        adhdScoreModel: computed.scoreModel,
        adhdScoreConfidence: computed.scoreConfidence,
        adhdScoreWarning: computed.scoreWarning,
        adhdTextChars: computed.textChars,
      });
    }
    if (key) adhdAnalysisCache.set(key, computed);
    return computed;
  }
  const stored = {
    score: adhdScoreForRecord(item),
    explanation: adhdExplanationForRecord(item),
    highlightText: adhdHighlightTextForRecord(item),
    highlightExplanation: adhdHighlightExplanationForRecord(item),
    scoreSource: adhdScoreSourceForRecord(item) || "heuristic",
    scoreModel: adhdScoreModelForRecord(item) || "browser heuristic",
    scoreConfidence: adhdScoreConfidenceForRecord(item) || "low",
    scoreWarning: adhdScoreWarningForRecord(item),
    textChars: adhdTextCharsForRecord(item),
  };
  const hasStoredExplanation = Boolean(item?.adhdScoreExplanation);
  if (!hasStoredExplanation && item) {
    Object.assign(item, {
      adhdScore: stored.score,
      adhdScoreExplanation: stored.explanation,
      adhdHighlightText: stored.highlightText,
      adhdHighlightExplanation: stored.highlightExplanation,
      adhdScoreSource: stored.scoreSource || "heuristic",
      adhdScoreModel: stored.scoreModel || "browser heuristic",
      adhdScoreConfidence: stored.scoreConfidence || "low",
      adhdScoreWarning: stored.scoreWarning || "older record scored from available metadata",
      adhdTextChars: stored.textChars,
    });
  }
  if (key) adhdAnalysisCache.set(key, stored);
  return stored;
}

async function pdfTextForRecord(item) {
  if (!isGeneratedPdf(item) || item?.mime !== "application/pdf") return "";
  const key = item?.id || "";
  if (key && pdfTextCache.has(key)) return pdfTextCache.get(key);
  try {
    const blob = item.source === "sync" && sync.status === "connected"
      ? await fetch(syncFileUrl(item.id, "view"), { cache: "no-store" }).then((response) => response.ok ? response.blob() : null)
      : await getBlob(item.id);
    if (!blob) return "";
    const pdfText = await blob.text();
    const parsed = generatedPdfTextSource(pdfText);
    if (key) pdfTextCache.set(key, parsed);
    return parsed;
  } catch {
    return "";
  }
}

function generatedPdfTextSource(pdfText) {
  const lines = [];
  for (const block of String(pdfText || "").split(/\nT\*\n?/)) {
    const segments = [];
    const pattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let match;
    while ((match = pattern.exec(block))) {
      segments.push(decodePdfLiteral(match[1]));
    }
    const line = segments.join("").replace(/\s+/g, " ").trim();
    if (line && !/^Created:/i.test(line)) lines.push(line);
  }
  return textPdfSource(stripGeneratedAnalysisLeak(lines.join(" ")));
}

function decodePdfLiteral(value) {
  return String(value || "")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f");
}

function stripGeneratedAnalysisLeak(value) {
  return String(value || "")
    .replace(/\s+It shows the need for certainty(?: and a stable rule before the situation feels safe enough to trust)?\.?/gi, " ")
    .replace(/\s+It shows distress becoming a body-level regulation problem(?:, not just ordinary annoyance)?\.?/gi, " ")
    .replace(/\s+It shows sensory comfort(?: and body safety carrying unusual weight in the decision)?\.?/gi, " ")
    .replace(/\s+It shows switching and change(?: carrying a heavier cost than the surface situation suggests)?\.?/gi, " ")
    .replace(/\s+It shows the social self-monitoring(?: and masking layer that often makes autistic experience harder to see from outside)?\.?/gi, " ")
    .replace(/\s+It shows social meaning(?: being treated as something that has to be decoded instead of automatically felt)?\.?/gi, " ")
    .replace(/\s+It shows a narrow, exact pattern(?: taking on more importance than the topic would usually carry)?\.?/gi, " ")
    .replace(/\s+It is the strongest personal pattern in this note(?:, even though the note itself is lower-signal overall)?\.?/gi, " ")
    .replace(/\s+It shows focus depending on interest(?: instead of staying available just because the task needs it)?\.?/gi, " ")
    .replace(/\s+It shows the hard part is getting the task started(?:, sequenced, or finished)?\.?/gi, " ")
    .replace(/\s+It shows memory, time, or organization(?: adding friction before the task can even move)?\.?/gi, " ")
    .replace(/\s+It shows the pressure to act or switch quickly(?: before there is time to steer it)?\.?/gi, " ")
    .replace(/\s+It shows the body wanting movement(?:, not just the mind disliking the situation)?\.?/gi, " ")
    .replace(/\s+It shows task friction(?: turning into frustration or overwhelm)?\.?/gi, " ")
    .replace(/\s+It shows attention locking hard(?: onto one thing while other priorities drop away)?\.?/gi, " ")
    .replace(/\s+It is the closest attention, task, time, or regulation clue(?: in a lower-signal ADHD note)?\.?/gi, " ");
}

function recordAnalysisBasis(item) {
  if (item?.sourceText) return stripGeneratedAnalysisLeak(item.sourceText);
  return stripGeneratedAnalysisLeak([
    item?.name,
    item?.lifeLeverageExplanation,
    item?.autismScoreExplanation,
    item?.autismHighlightText,
    item?.autismHighlightExplanation,
  ].filter(Boolean).join(" "));
}

function normalizeAnalysisExplanation(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 900);
}

function cardAnalysisExplanation(value, options = {}) {
  let text = removeRepeatedHighlightSentences(normalizeAnalysisExplanation(value), options.highlightText);
  text = removeRepeatedSignalSentences(text, options);
  text = normalizeCardAnalysisTone(text, options.trait, options.seedText);
  if (isThinAnalysisText(text)) {
    text = distinctCardContext(options);
  }
  text = compactCardAnalysis(cleanCardAnalysisArtifacts(text, options), options, 260);
  return removeRepeatedSignalSentences(text, options);
}

function pairedCardAnalysisText(autismText, adhdText, autismOptions = {}, adhdOptions = {}) {
  let autism = compactCardAnalysis(autismText, autismOptions, 250);
  let adhd = compactCardAnalysis(adhdText, adhdOptions, 250);
  autism = fillShortCardAnalysis(autism, autismOptions, 150);
  adhd = fillShortCardAnalysis(adhd, adhdOptions, 150);
  const autismLength = visibleAnalysisLength(autism);
  const adhdLength = visibleAnalysisLength(adhd);
  const longest = Math.max(autismLength, adhdLength);
  const shortest = Math.max(120, Math.min(autismLength, adhdLength));
  if (longest - shortest > 80) {
    const cap = Math.min(250, shortest + 65);
    if (autismLength > adhdLength) autism = compactCardAnalysis(autism, autismOptions, cap);
    if (adhdLength > autismLength) adhd = compactCardAnalysis(adhd, adhdOptions, cap);
  }
  return { autism, adhd };
}

function lifeLeverageCardAnalysis(value, options = {}) {
  let text = normalizeAnalysisExplanation(value);
  text = text
    .replace(/^This is highly useful because\s+/i, "This sits close to the Disney/R&D path because ")
    .replace(/^This is useful because\s+/i, "This is useful because ")
    .replace(/^This could help if\s+/i, "The Disney read starts with whether ")
    .replace(/\bThe Disney score is built around\s+/gi, "The goal-moving read comes from ")
    .replace(/\bThe Disney score is high because\s+/gi, "This sits close to the Disney/R&D path because ")
    .replace(/\bThe Disney score is real because\s+/gi, "This can help because ")
    .replace(/\bThe Disney score is lower-to-middle:\s*/gi, "")
    .replace(/\bThe Disney score stays low because\s+/gi, "The direct goal payoff is limited because ")
    .replace(/\bThe Disney score stays lower because\s+/gi, "The direct goal payoff is limited because ")
    .replace(/^This note is useful as\s+/i, "This is useful as ")
    .replace(/^The note is useful because\s+/i, "This is useful because ")
    .replace(/^The life-leverage signal is\s+/i, "The goal-moving signal is ")
    .replace(/^The life leverage signal is\s+/i, "The goal-moving signal is ")
    .replace(/^The life-leverage read is\s+/i, "The Disney read is ")
    .replace(/^The leverage stays limited because\s+/i, "It stays limited because ")
    .replace(/^It is not higher because\s+/i, "It is not higher because ")
    .replace(/^It is not quite perfect because\s+/i, "It is not higher because ")
    .replace(/^It is not even higher because\s+/i, "It is not higher because ")
    .replace(/^It stays low because\s+/i, "The direct goal payoff is limited because ")
    .replace(/\s+/g, " ")
    .trim();
  text = removeRepeatedSignalSentences(text, options);
  if (!text) text = distinctCardContext(options, "disney");
  text = firstSentences(text, 2);
  text = cardSentenceClip(text, 250);
  if (visibleAnalysisLength(text) < 120) text = distinctCardContext(options, "disney") || text;
  text = trimIncompleteSentence(text) || text;
  return removeRepeatedSignalSentences(text, options);
}

function lifeLeverageFallbackSummary(options = {}) {
  const details = scoreBasisDetailList(options, "disney").slice(0, 2);
  const detailText = details.length ? ` It connects to ${humanJoin(details)}.` : "";
  const leadPhrase = analysisLeadPhrase(options.highlightExplanation)
    .replace(/^(?:it|this)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const lead = options.highlightExplanation
    ? `The Disney/R&D read starts from ${leadPhrase || "the clearest goal-moving line in the note"}.`
    : "This is judged by whether the thought can move the Imagineering, R&D, money, or execution path.";
  return `${lead}${detailText} ${scoreBasisSentence({ ...options, trait: "disney" })}`;
}

function lifeLeverageBoundarySentence(score = 0) {
  const value = Number(score || 0);
  if (value >= 80) return "It can move research, career, money, or a durable system forward.";
  if (value >= 55) return "It helps motivation or execution, but it is not the full Disney/R&D path by itself.";
  return "The direct career, research, money, or execution payoff is still limited.";
}

function compactCardAnalysis(value, options = {}, maxChars = 300) {
  let text = cleanCardAnalysisArtifacts(value, options);
  if (!text) text = distinctCardContext(options);
  text = firstSentences(text, 2);
  text = cardSentenceClip(text, maxChars);
  return trimIncompleteSentence(text) || text;
}

function fillShortCardAnalysis(value, options = {}, minChars = 150) {
  let text = normalizeAnalysisExplanation(value);
  if (!text) return "";
  if (visibleAnalysisLength(text) >= minChars) return text;
  const boundary = scoreBasisSentence(options) || scoreBoundarySentence(options.score, options.trait);
  return cardSentenceClip(`${text} ${boundary}`, 250);
}

function cardSignalExplanation(value) {
  return cardSentenceClip(cleanCardAnalysisArtifacts(value), 130);
}

function cardSentenceClip(value, maxChars = 250) {
  const text = normalizeAnalysisExplanation(value);
  if (text.length <= maxChars) return text;
  const sentenceClip = completeSentenceClip(text, maxChars);
  if (sentenceClip.length <= maxChars + 12) return sentenceClip;
  return shortenLongSentence(sentenceClip, maxChars);
}

function shortenLongSentence(value, maxChars = 250) {
  const text = normalizeAnalysisExplanation(value).replace(/[.!?]+$/g, "");
  const chunks = text.split(/:\s+|;\s+|,\s+(?:and|but|then|while|because)\s+/).map((chunk) => chunk.trim()).filter(Boolean);
  let selected = "";
  for (const chunk of chunks) {
    const next = selected ? `${selected}; ${chunk}` : chunk;
    if (next.length > maxChars - 1 && selected) break;
    selected = next;
    if (selected.length >= Math.min(130, maxChars - 40)) break;
  }
  if (!selected) selected = text.split(/\s+/).slice(0, 22).join(" ");
  selected = selected.replace(/\s+[,;:]$/g, "").trim();
  return selected ? `${selected}.` : "";
}

function firstSentences(value, count = 2) {
  const sentences = analysisSentences(value).slice(0, count);
  return sentences.length ? sentences.join(" ") : normalizeAnalysisExplanation(value);
}

function visibleAnalysisLength(value) {
  return normalizeAnalysisExplanation(value).length;
}

function scoreBoundarySentence(score, trait = "autism") {
  const label = trait === "adhd" ? "ADHD" : "autism";
  const value = clampAutismScore(score);
  if (trait === "disney") return lifeLeverageBoundarySentence(value);
  if (value >= 80) return `The ${label} read is strong only when the note gives connected evidence, not one isolated line.`;
  if (value >= 50) return `The ${label} read is real but mixed across the note.`;
  return `The ${label} read stays lighter when the clue is present but not the main engine of the note.`;
}

function scoreBasisSentence(options = {}) {
  const trait = options.trait === "adhd" ? "adhd" : options.trait === "disney" ? "disney" : "autism";
  const value = clampAutismScore(options.score);
  const details = scoreBasisDetailList(options, trait).slice(0, 2);
  const detailText = details.length ? humanJoin(details) : "";
  const seed = `${trait}:${options.seedText || ""}:${options.highlightText || ""}:${detailText}:${value}`;
  if (!detailText) return scoreFallbackBasisSentence(trait, value, seed);
  const subject = detailSubject(detailText, details.length);
  const level = value >= 80 ? "high" : value >= 55 ? "middle" : "low";
  const templates = scoreBasisTemplates(trait, level, subject);
  return templates[stableAnalysisIndex(seed, templates.length)];
}

function scoreBasisDetailList(options = {}, trait = "autism") {
  const direct = cardConcreteDetails(
    options.sourceText,
    options.highlightText || "",
    [options.highlightExplanation, options.highlightText].filter(Boolean).join(" ")
  ).slice(0, 2);
  if (direct.length) return direct;
  return scoreBasisThemes(options, trait).slice(0, 2);
}

function detailSubject(detailText, count = 1) {
  const text = String(detailText || "").replace(/\s+/g, " ").trim();
  return {
    text,
    cap: sentenceStart(text),
    verb: count === 1 ? "shows" : "show",
    points: count === 1 ? "points" : "point",
  };
}

function scoreBasisTemplates(trait, level, subject) {
  if (trait === "adhd") {
    if (level === "high") {
      return [
        `${subject.cap} ${subject.verb} the same executive-load problem in the body of the note.`,
        `The ADHD read gets stronger because the note keeps moving through ${subject.text}.`,
        `That makes the highlighted line feel representative: ${subject.text} ${subject.points} to the same task, focus, or regulation strain.`,
        `${subject.cap} ${subject.verb} attention pressure turning into concrete task friction.`,
      ];
    }
    if (level === "middle") {
      return [
        `${subject.cap} ${subject.verb} real ADHD-shaped friction, while the rest of the thought is doing other work too.`,
        `The ADHD read stays moderate because ${subject.text} ${subject.points} in the same direction without carrying the whole note.`,
        `${subject.cap} ${subject.verb} concrete task or attention friction, but the signal is still mixed.`,
        `The attention/execution clue is believable because it sits beside ${subject.text}.`,
      ];
    }
    return [
      `${subject.cap} ${subject.verb} a small ADHD-shaped clue, but the note is mostly doing something else.`,
      `The ADHD read stays lighter because ${subject.text} ${subject.points} to some executive-load friction without becoming the main pattern.`,
      `${subject.cap} ${subject.verb} task or attention pressure, but it stays secondary.`,
      `This is not zero because ${subject.text} ${subject.verb} some task friction; it is just not the center of the note.`,
    ];
  }
  if (trait === "disney") {
    if (level === "high") {
      return [
        `${subject.cap} ${subject.verb} why this belongs close to the Disney/R&D path instead of sitting as a random saved thought.`,
        `This belongs high for Disney/R&D because ${subject.text} ${subject.verb} career, research, money, or execution direction in the body of the note.`,
        `That makes this more than motivation: ${subject.text} ${subject.points} toward the work and life path the bank is supposed to protect.`,
        `${subject.cap} ${subject.verb} the thought turning into something usable for the larger career path.`,
      ];
    }
    if (level === "middle") {
      return [
        `${subject.cap} ${subject.verb} useful momentum, but the note is not a direct Disney, research, or career move by itself.`,
        `The Disney/R&D read stays moderate because ${subject.text} ${subject.points} toward the long-term path, but indirectly.`,
        `The thought can still help because ${subject.text} ${subject.verb} motivation, systems, or execution, even if it is not the main career lane.`,
        `${subject.cap} ${subject.verb} something usable, just not a clean Imagineering/R&D move by itself.`,
      ];
    }
    return [
      `${subject.cap} ${subject.verb} some possible use, but the direct Disney, R&D, money, or career payoff is small.`,
      `The Disney/R&D read stays lighter because ${subject.text} ${subject.points} somewhere useful, but not toward the main path strongly enough.`,
      `${subject.cap} ${subject.verb} a side pattern more than a clear career, research, money, or execution move.`,
      `${subject.cap} ${subject.verb} why it can remain saved without becoming a main-path thought.`,
    ];
  }
  if (level === "high") {
    return [
      `${subject.cap} ${subject.verb} the same need for fit, certainty, sensory safety, or social clarity in the body of the note.`,
      `The autism read gets stronger because the note keeps returning to ${subject.text}.`,
      `That makes the highlighted line feel representative: ${subject.text} ${subject.points} to repeated rigidity, certainty, sensory, or social-meaning pressure.`,
      `${subject.cap} ${subject.verb} the pattern spreading beyond one sentence into how the whole situation is being sorted.`,
    ];
  }
  if (level === "middle") {
    return [
      `${subject.cap} ${subject.verb} a real autism-shaped clue, while the rest of the thought is mixed.`,
      `The autism read stays moderate because ${subject.text} ${subject.points} in the same direction without carrying the whole note.`,
      `${subject.cap} ${subject.verb} concrete fit, certainty, sensory, or social strain, but it is not the only thing happening.`,
      `The autism clue is believable because it sits beside ${subject.text}.`,
    ];
  }
  return [
    `${subject.cap} ${subject.verb} a small autism-shaped clue, but the note is mostly doing something else.`,
    `The autism read stays lighter because ${subject.text} ${subject.points} to some fit, certainty, sensory, or social strain without becoming the main pattern.`,
    `${subject.cap} ${subject.verb} real friction, but it stays secondary.`,
    `This is not zero because ${subject.text} ${subject.verb} some fit or certainty pressure; it is just not the center of the note.`,
  ];
}

function scoreFallbackBasisSentence(trait, score, seed = "") {
  const level = score >= 80 ? "high" : score >= 55 ? "middle" : "low";
  const templates = trait === "adhd"
    ? {
      high: [
        "The ADHD read is high only when attention, task-starting, time, or regulation pressure shows up in more than one way.",
        "This sits high for ADHD because the card is looking for repeated executive-load pressure, not a single keyword.",
      ],
      middle: [
        "The ADHD read stays in the middle when the task or attention clue is real but not the whole point of the note.",
        "This is a middle ADHD read: there is executive-load friction, but it is not the only pattern carrying the entry.",
      ],
      low: [
        "The ADHD read stays light when the entry gives only a small task, attention, time, or regulation clue.",
        "This is low-signal for ADHD, not zero; the note just does not give a strong executive-load pattern.",
      ],
    }
    : trait === "disney"
      ? {
        high: [
          "The Disney/R&D read is high only when the thought can move research, career, money, or a durable system forward.",
          "This goes high when the note protects the long-term Disney, R&D, money, or execution path instead of only recording a mood.",
        ],
        middle: [
          "The Disney/R&D read stays in the middle when the thought helps momentum or systems but is not a direct career move.",
          "This is useful, but indirect: it can support the bigger path without being the bigger path itself.",
        ],
        low: [
          "The Disney/R&D read stays light when the direct career, research, money, or execution payoff is small.",
          "This can stay saved, but it is not one of the thoughts that clearly moves the main life path.",
        ],
      }
      : {
        high: [
          "The autism read is high only when certainty, sensory, social, routine, or exact-fit pressure repeats across the note.",
          "This sits high for autism because the card is looking for a repeated pattern, not one dramatic sentence.",
        ],
        middle: [
          "The autism read stays in the middle when the clue is real but the note is not carried by autism-shaped pressure alone.",
          "This is a middle autism read: the fit, certainty, sensory, or social clue is present but mixed with other material.",
        ],
        low: [
          "The autism read stays light when the entry gives only a small fit, certainty, sensory, or social clue.",
          "This is low-signal for autism, not zero; the note just does not give a strong whole-note pattern.",
        ],
      };
  return templates[level][stableAnalysisIndex(seed, templates[level].length)];
}

function scoreBasisThemes(options = {}, trait = "autism") {
  const source = String(options.sourceText || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const text = comparableAnalysisText(source);
  const themes = [];
  const add = (theme, pattern) => {
    if (themes.includes(theme)) return;
    if (pattern.test(text)) themes.push(theme);
  };
  if (trait === "adhd") {
    add("paper-starting pressure", /\b(lock in|write my paper|paper|start|starting|task)\b/);
    add("money and time pressure", /\b(work at the same time|broke|money|need money|too much time|devote too much time)\b/);
    add("urgency to turn intention into action", /\b(need to|have to|urgent|momentum|finish|execute)\b/);
    add("task-priority friction", /\b(side thing|priority|focus|attention|switch|planning)\b/);
  } else if (trait === "disney") {
    add("the Disney/Imagineering goal", /\b(disney|imagineer|imagineering)\b/);
    add("PhD and research work", /\b(phd|research|paper|soft robotics|mechanical|prototype)\b/);
    add("career and money pressure", /\b(career|work|job|money|broke|network|successful)\b/);
    add("long-term R&D identity", /\b(scientist|engineer|r d|r&d|goal)\b/);
  } else {
    add("social nonresponse", /\b(group chat|nobody responded|unheard|invalidated)\b/);
    add("withdrawal from mismatch", /\b(leave environments|environment|mismatch|reciprocity|lack of reciprocity)\b/);
    add("feeling socially minimized", /\b(small and unimpressive|minimized|judged|unheard)\b/);
    add("certainty or exact-fit pressure", /\b(certainty|exact|predictable|routine|same|stable|rule)\b/);
    add("sensory or overwhelm load", /\b(sensory|overwhelm|comfortable|safe)\b/);
  }
  return themes.slice(0, 3);
}

function removeRepeatedHighlightSentences(value, highlightText) {
  const text = normalizeAnalysisExplanation(value);
  const phrase = comparableAnalysisText(highlightText);
  if (!text || !phrase) return text;
  const sentences = analysisSentences(text);
  const kept = sentences.filter((sentence, index) => {
    const comparable = comparableAnalysisText(sentence);
    if (!comparable.includes(phrase)) return true;
    if (/center of|selected|highlight|bolded|phrase|matters because|is .*shaped|is .*read/i.test(sentence)) return false;
    return !(index === 0 && comparable.indexOf(phrase) <= 4);
  });
  return (kept.length ? kept.join(" ") : text).replace(/\s+/g, " ").trim();
}

function removeRepeatedSignalSentences(value, options = {}) {
  const text = normalizeAnalysisExplanation(value);
  if (!text) return "";
  const signal = comparableAnalysisText(options.highlightExplanation);
  const highlight = comparableAnalysisText(options.highlightText);
  if (!signal && !highlight) return text;
  const signalTokens = signal.split(/\s+/).filter((token) => token.length >= 5);
  const kept = analysisSentences(text).filter((sentence) => {
    const comparable = comparableAnalysisText(sentence);
    if (!comparable) return false;
    if (highlight && (comparable.includes(highlight) || anchorSimilarity(comparable, highlight) > 0.68)) return false;
    if (!signal) return true;
    const overlap = signalTokens.length
      ? signalTokens.filter((token) => comparable.includes(token)).length / signalTokens.length
      : 0;
    if (overlap >= 0.55 && comparable.length <= signal.length * 1.9) return false;
    if (anchorSimilarity(comparable, signal) > 0.58) return false;
    return true;
  });
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function distinctCardContext(options = {}, mode = "") {
  const details = cardConcreteDetails(
    options.sourceText,
    options.highlightText || "",
    [options.highlightExplanation, options.highlightText].filter(Boolean).join(" ")
  ).slice(0, 2);
  if (details.length) return supportDetailsSentence(details);
  if (mode === "disney" && !options.highlightExplanation) return lifeLeverageFallbackSummary(options);
  return "";
}

function analysisSentences(value) {
  const text = normalizeAnalysisExplanation(value);
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
  if (sentences.length) return sentences.map((sentence) => sentence.replace(/\s+/g, " ").trim()).filter(Boolean);
  return text ? [text] : [];
}

function comparableAnalysisText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isThinAnalysisText(value) {
  const text = normalizeAnalysisExplanation(value);
  if (text.length < 170) return true;
  return /^i read (?:the )?(?:entry|note) as\b/i.test(text)
    || /^the rest of the .* weight is\b/i.test(text)
    || /^that puts it in the middle\b/i.test(text);
}

function addMissingCardDetails(value, options = {}) {
  const text = normalizeAnalysisExplanation(value);
  const details = cardConcreteDetails(options.sourceText, options.highlightText, text).slice(0, 3);
  if (details.length < 2 || analysisMentionsDetails(text, details)) return text;
  return `${text} ${supportDetailsSentence(details)}`;
}

function traitCardSummary(options = {}) {
  const lead = options.highlightExplanation
    ? traitSignalLead(options.trait, options.highlightExplanation, options.seedText)
    : traitFallbackLead(options.trait, options.seedText);
  return `${lead} ${scoreBasisSentence(options) || scoreBoundarySentence(options.score, options.trait)}`;
}

function normalizeCardAnalysisTone(value, trait = "autism", seedText = "") {
  return normalizeAnalysisExplanation(value)
    .replace(/\bThe rest of the note adds:\s*/gi, "The surrounding note keeps ")
    .replace(/\bThe note also adds:\s*/gi, "The surrounding note keeps ")
    .replace(/\bThe note also mentions:\s*/gi, "The surrounding note keeps ")
    .replace(/^That line matters because\s+([^.!?]+[.!?])\s*/i, (_match, explanation) => {
      return `${traitSignalLead(trait, explanation, seedText)} `;
    })
    .replace(/^The selected (?:autism|ADHD) line matters because\s+([^.!?]+[.!?])\s*/i, (_match, explanation) => {
      return `${traitSignalLead(trait, explanation, seedText)} `;
    })
    .replace(/\.\s*;\s*/g, ". The surrounding note keeps ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCardAnalysisArtifacts(value, options = {}) {
  return normalizeAnalysisExplanation(value)
    .replace(/\bThe rest of the note adds:\s*/gi, "The surrounding note keeps ")
    .replace(/\bThe note also adds:\s*/gi, "The surrounding note keeps ")
    .replace(/\bThe note also mentions:\s*/gi, "The surrounding note keeps ")
    .replace(/^["'“”]\s*/, "")
    .replace(/\bI read the (ADHD|autism) signal as ([^.]+)\./gi, (_match, label, phrase) => {
      return traitSignalLead(label.toLowerCase() === "adhd" ? "adhd" : "autism", phrase, options.seedText);
    })
    .replace(/\bI read it as ([^.]+?) because the (?:ADHD|autism)-relevant weight is\b/gi, "This reads as $1 because")
    .replace(/\bI score it as ([^.]+?) because\b/gi, "This reads as $1 because")
    .replace(/\bI score that as ([^.]+?)\./gi, "This reads as $1.")
    .replace(/\bI read that as ([^.]+?)\./gi, "This reads as $1.")
    .replace(/\bI treat it as ([^.]+?) because\b/gi, "It lands as $1 because")
    .replace(/\bI stop short of 100 because\b/gi, "A perfect read would need ")
    .replace(/\bThe (?:ADHD|autism)-relevant weight is\b/gi, "The signal is")
    .replace(/\bThat puts it in the middle rather than the diagnostic-letter range\./g, "That keeps it in the middle instead of treating it like a diagnosis letter.")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\.\s*;\s*/g, ". The surrounding note keeps ")
    .replace(/\s*;\s*(?:The score is not even higher|The note is not higher|The score is not higher|The entry is not higher)[^.]*\.?/gi, "")
    .replace(/\bpdf\s+(?=(?:This entry|This note|The note)\b)/gi, "")
    .replace(/\bThe phrase is (autism|ADHD)-shaped because\s+/gi, "That phrase is $1-shaped because ")
    .replace(/\s+/g, " ")
    .trim();
}

function traitSignalLead(trait, explanationOrPhrase, seedText = "") {
  const label = trait === "adhd" ? "ADHD" : "autism";
  const phrase = analysisLeadPhrase(explanationOrPhrase) || "the strongest pattern in this note";
  const templates = trait === "adhd"
    ? [
      `The ADHD signal here is ${phrase}.`,
      `For ADHD, this points to ${phrase}.`,
      `The main ADHD-shaped pattern is ${phrase}.`,
      `What stands out for ADHD is ${phrase}.`,
      `The clearest ADHD-shaped part is ${phrase}.`,
    ]
    : [
      `The autism signal here is ${phrase}.`,
      `For autism, this points to ${phrase}.`,
      `The main autism-shaped pattern is ${phrase}.`,
      `What stands out for autism is ${phrase}.`,
      `The clearest autism-shaped part is ${phrase}.`,
    ];
  return templates[stableAnalysisIndex(`${label}:${phrase}:${seedText}`, templates.length)];
}

function traitFallbackLead(trait, seedText = "") {
  const templates = trait === "adhd"
    ? [
      "The ADHD read starts from the strongest attention or task-friction clue available in this note.",
      "The ADHD card is using the clearest attention, task, time, or regulation clue in the text.",
      "For ADHD, the note gives a weaker but still readable attention-and-execution pattern.",
      "The ADHD read uses the strongest executive-function clue the note gives.",
    ]
    : [
      "The autism read starts from the strongest predictability, sensory, social, or exactness clue available in this note.",
      "The autism card is using the clearest certainty, routine, sensory, or social-meaning clue in the text.",
      "For autism, the note gives a weaker but still readable autistic-trait pattern.",
      "The autism read uses the strongest autism-shaped clue the note gives.",
    ];
  return templates[stableAnalysisIndex(`${trait}:${seedText}:fallback`, templates.length)];
}

function stableAnalysisIndex(value, length) {
  if (!length) return 0;
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % length;
}

function analysisLeadPhrase(value) {
  return analysisPhraseFromExplanation(value)
    .replace(/^the hard part is\s+/i, "")
    .replace(/^the need for\s+/i, "a need for ")
    .replace(/^the pressure to\s+/i, "pressure to ")
    .replace(/^the body wanting\s+/i, "the body wanting ")
    .replace(/\s+/g, " ")
    .trim();
}

function analysisPhraseFromExplanation(value) {
  return lowercaseFirst(String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/g, "")
    .split(/\s*;\s*/)[0]
    .replace(/^(?:it|this)\s+(?:directly\s+)?shows\s+/i, "")
    .replace(/^(?:it|this)\s+is\s+(?:autism|adhd)-shaped\s+because\s+/i, "")
    .replace(/^(?:it|this)\s+(?:directly\s+)?shows\s+/i, "")
    .replace(/^(?:it|this)\s+is\s+/i, "")
    .replace(/^the phrase is\s+/i, "")
    .replace(/^the line is\s+/i, ""));
}

function supportDetailsSentence(details) {
  const cleaned = details
    .map((detail) => cleanAnchor(detail).replace(/^[\s;:,.]+/, "").replace(/\s*[;:]\s*$/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (!cleaned.length) return "";
  const joined = humanJoin(cleaned);
  const subject = detailSubject(joined, cleaned.length);
  const templates = [
    `${subject.cap} ${subject.verb} the same pattern from another angle.`,
    `That same pressure shows up around ${joined}.`,
    `The surrounding details point to ${joined}.`,
  ];
  return templates[stableAnalysisIndex(joined, templates.length)];
}

function cardConcreteDetails(sourceText, highlightText, analysisText = "") {
  const source = String(sourceText || "").replace(/\s+/g, " ").trim().slice(0, 1800);
  if (!source) return [];
  const highlight = comparableAnalysisText(highlightText);
  const analysis = comparableAnalysisText(analysisText);
  return extractAnalysisAnchors(source)
    .filter((anchor) => {
      const comparable = comparableAnalysisText(anchor);
      if (!comparable || comparable.length < 12) return false;
      if (highlight && (comparable.includes(highlight) || anchorSimilarity(comparable, highlight) > 0.62)) return false;
      if (analysis && analysis.includes(comparable.slice(0, Math.min(24, comparable.length)))) return false;
      return true;
    })
    .slice(0, 4);
}

function analysisMentionsDetails(analysis, details) {
  const text = comparableAnalysisText(analysis);
  let matches = 0;
  for (const detail of details) {
    const tokens = comparableAnalysisText(detail).split(/\s+/).filter((token) => token.length >= 5);
    if (tokens.some((token) => text.includes(token))) matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

function completeSentenceClip(value, maxChars) {
  const text = normalizeAnalysisExplanation(value);
  if (text.length <= maxChars) return text;
  const sentences = analysisSentences(text);
  let selected = "";
  for (const sentence of sentences) {
    const next = selected ? `${selected} ${sentence}` : sentence;
    if (next.length > maxChars && selected) break;
    selected = next;
    if (selected.length >= Math.min(380, maxChars - 80)) break;
  }
  if (selected) return selected;
  return text;
}

function trimIncompleteSentence(value) {
  const text = normalizeAnalysisExplanation(value);
  if (!text || /[.!?]["')\]]?$/.test(text)) return text;
  const lastStop = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"));
  if (lastStop >= 80) return text.slice(0, lastStop + 1).trim();
  return text;
}

async function cardSourceTextForRecord(item) {
  if (item?.sourceText) return item.sourceText;
  const basis = recordAnalysisBasis(item);
  const basisDetails = cardConcreteDetails(basis, "", "").length;
  if (!isGeneratedPdf(item) || (basis.length >= 220 && basisDetails >= 2)) return basis;
  const text = await pdfTextForRecord(item);
  if (text && item) item.sourceText = text;
  return text || basis;
}

function isGeneratedPdf(item) {
  return (item?.kind || "").toLowerCase() === "generated pdf";
}

function analyzeAutismText(value) {
  const readableSource = normalizeForPdf(value);
  const text = readableSource.toLowerCase();
  const readableText = text.replace(/\s+/g, " ").trim();
  const anchors = extractAnalysisAnchors(readableSource);
  const support = matchStats(text, /\blevel 3\b|\brequir(?:es|ing) very substantial support\b|\bvery substantial support\b|\bsevere autism\b|\bextreme support\b|\bhigh support needs\b/g);
  const formal = matchStats(text, /\bautism diagnostic evaluation\b|\bdiagnos(?:ed|is) (?:with|of) (?:autism|asd|autism spectrum disorder)\b|\bmeets criteria for (?:autism|asd|autism spectrum disorder)\b|\bautism spectrum disorder\b/g);
  const direct = matchStats(text, /\bautis(?:m|tic)\b|\basd\b|\bautism spectrum\b|\bspectrum disorder\b/g);
  const diagnostic = matchStats(text, /\bdiagnostic evaluation\b|\bpsychological evaluation\b|\bneuropsych(?:ological)?\b|\bclinical\b|\breport\b|\bassessment\b|\bevaluation\b/g);
  const social = matchStats(text, /\bsocial communication\b|\bsocial interaction\b|\bsocial life\b|\bsocial(?:ly)?\b|\bconversation\b|\bback and forth\b|\brespond\b|\bnot responding\b|\bwe text\b|\btext(?:ing|ed)? (?:again|me|back)\b|\bpick up\b|\brelationship\b|\blove me\b|\bdone with me\b|\bblock me\b|\bpoint of view\b|\bunderstand(?:ing)? (?:other people|another person|people's actions)\b|\bmisread\b|\btone\b|\beye contact\b|\bliteral\b|\bblunt\b|\bconfus(?:e|ion|ed)\b|\breciprocity\b|\bnonverbal\b|\bfriends?\b|\bpeer(?:s)?\b|\bsocial cue(?:s)?\b/g);
  const sameness = matchStats(text, /\binsistence on sameness\b|\bsameness\b|\bswitch(?:ing)?\b|\btransition(?:s)?\b|\broutine(?:s)?\b|\bstable path\b|\bsame path\b|\bcommit(?:ting)?\b|\bone goal\b|\bone stable\b|\bchange decisions?\b|\bback and forth\b|\bmentalities\b|\bsmall change(?:s)?\b|\bdecide once\b/g);
  const sensory = matchStats(text, /\bsensory\b|\bcomfort\b|\bcomfortable\b|\bquiet\b|\bsmooth\b|\bbumpy\b|\bugly sound\b|\bsound\b|\baudio\b|\bmetal box\b|\binsulation\b|\btexture\b|\blight(?:s)?\b|\bsmell\b|\bnoise\b|\bsafe\b|\bsafety\b|\bcheap\b|\btemperature\b|\bclothing\b/g);
  const focused = matchStats(text, /\bspecial interest\b|\brestricted interest\b|\bfixated\b|\bfixed interest\b|\bfocused interest\b|\boverly focused\b|\bsystem(?:s|izing)?\b|\brule(?:s)?\b|\bpattern(?:s)?\b|\blist(?:s)?\b|\bexact\b|\bdetails\b|\bfacts\b|\bbrand\b|\bcategory\b|\bcategories\b|\baudi\b|\bcar brand\b|\bone audi\b/g);
  const masking = matchStats(text, /\bmasking\b|\bunmask(?:ing)?\b|\bcamouflag(?:e|ing)\b|\bappear normal\b|\bpass(?:ing)? as normal\b|\bfit in\b|\bhide(?:ing)?\b|\bcompensat(?:e|ing|ion)\b|\bsocial life\b/g);
  const predictability = matchStats(text, /\bconcrete anchor(?:s)?\b|\banchor(?:s)?\b|\bunpredictable\b|\bpredictable\b|\bknow for a fact\b|\bmake sure\b|\bto know\b|\bwhat(?:'| i)?s going to happen\b|\bassume\b|\bcertainty\b|\buncertain(?:ty)?\b|\bproof\b|\bonly way\b|\bif .{0,48} then\b/g);
  const regulation = matchStats(text, /\boverwhelm(?:ed|ing)?\b|\btoo much\b|\bhard to handle\b|\bpanic\b|\bshutdown\b|\bmeltdown\b|\bspiral\b|\bcan't handle\b|\bcant handle\b|\bstress(?:ful|ed)?\b|\bannoying\b|\banxiety\b|\banxious\b|\bupset\b|\bdistress(?:ed)?\b|\bimmediately assume\b/g);
  const functioning = matchStats(text, /\bfunction(?:ing)?\b|\bdaily (?:life|functioning)\b|\bwork\b|\bschool\b|\brelationship\b|\bsafety\b|\bneed(?:s|ed)? (?:support|help|accommodation)\b|\brequire(?:s|d)? support\b|\bsupport\b|\baccommodation(?:s)?\b|\bhelp\b|\bhard for me\b|\bdifficult(?:y)?\b|\baffects?\b|\bquality of life\b/g);
  const adhd = matchStats(text, /\badhd\b|\battention[- ]deficit\b|\bexecutive function\b|\bhyperfocus\b|\bfocus\b|\binattention\b|\bimpulsiv(?:e|ity)\b/g);

  const supportPoints = support.count ? 22 : 0;
  const formalPoints = formal.count ? 28 + Math.min(10, formal.count * 4) : 0;
  const directPoints = direct.count ? 18 + Math.min(16, direct.count * 2 + direct.terms.length * 3) : 0;
  const diagnosticPoints = diagnostic.count ? 6 + Math.min(8, diagnostic.count * 2) : 0;
  const socialPoints = scoreDimension(social, 20);
  const samenessPoints = scoreDimension(sameness, 20);
  const sensoryPoints = scoreDimension(sensory, 18);
  const focusedPoints = scoreDimension(focused, 18);
  const maskingPoints = scoreDimension(masking, 16);
  const predictabilityPoints = scoreDimension(predictability, 16);
  const regulationPoints = scoreDimension(regulation, 18);
  const functioningPoints = scoreDimension(functioning, 14);
  const adhdPoints = adhd.count ? Math.min(10, adhd.count * 2 + adhd.terms.length) : 0;
  const rawScore = supportPoints + formalPoints + directPoints + diagnosticPoints + socialPoints + samenessPoints + sensoryPoints + focusedPoints + maskingPoints + predictabilityPoints + regulationPoints + functioningPoints + adhdPoints;
  const coreDomains = [social, sameness, sensory, focused].filter((stats) => stats.count > 0).length;
  const contextDomains = [masking, predictability, regulation, functioning].filter((stats) => stats.count > 0).length;
  const evidenceDomains = coreDomains + contextDomains;

  let cap = 10;
  let capReason = "no readable autism-specific, DSM-core, or autism-context evidence";
  if (support.count && (formal.count || direct.count || coreDomains >= 2)) {
    cap = 100;
    capReason = "explicit high-support or Level 3/severe-autism wording appears with autism evidence";
  } else if (formal.count && direct.count && coreDomains >= 3 && contextDomains >= 2) {
    cap = 98;
    capReason = "formal autism wording plus broad DSM-core and context evidence";
  } else if ((formal.count || direct.count) && evidenceDomains >= 5) {
    cap = 96;
    capReason = "direct/formal autism evidence plus at least five independent autism evidence domains";
  } else if (formal.count && direct.count) {
    cap = 94;
    capReason = "formal autism diagnosis/evaluation wording is present without explicit high-support severity language";
  } else if (direct.count && evidenceDomains >= 4) {
    cap = 94;
    capReason = "direct autism wording plus broad autism-domain evidence";
  } else if (evidenceDomains >= 6) {
    cap = 92;
    capReason = "six or more autism-domain signals appear even without direct autism wording";
  } else if (evidenceDomains === 5) {
    cap = 88;
    capReason = "five autism-domain signals appear even without direct autism wording";
  } else if (direct.count && diagnostic.count) {
    cap = 86;
    capReason = "direct autism wording appears with general report/evaluation context";
  } else if (evidenceDomains === 4) {
    cap = 82;
    capReason = "four autism-domain signals appear without direct autism wording";
  } else if (direct.count && evidenceDomains >= 2) {
    cap = 84;
    capReason = "direct autism wording appears with multiple autism-domain signals";
  } else if (direct.count) {
    cap = 76;
    capReason = "direct autism wording appears but the readable text has limited domain detail";
  } else if (evidenceDomains === 3) {
    cap = 74;
    capReason = "three autism-domain signals appear without direct autism wording";
  } else if (evidenceDomains === 2) {
    cap = 62;
    capReason = "two autism-domain signals appear without direct autism wording";
  } else if (evidenceDomains === 1) {
    cap = 45;
    capReason = "one autism-domain signal appears without direct autism wording";
  } else if (adhd.count) {
    cap = 34;
    capReason = "ADHD/executive-function language is neurodivergent context, not autism-specific evidence";
  }

  const baselineScore = readableText.length >= 20 ? 12 : 8;
  const finalScore = clampAutismScore(Math.max(baselineScore, Math.min(rawScore, cap)));
  const highlight = heuristicHighlightForText(readableSource);
  return {
    score: finalScore,
    explanation: autismAnalysisText(finalScore, {
      support,
      formal,
      direct,
      social,
      sameness,
      sensory,
      focused,
      masking,
      predictability,
      regulation,
      functioning,
      adhd,
      evidenceDomains,
      hasReadableText: readableText.length >= 20,
      anchors,
    }),
    highlightText: highlight.text,
    highlightExplanation: highlight.explanation,
    scoreSource: "heuristic",
    scoreModel: "browser heuristic",
    scoreConfidence: "low",
    scoreWarning: "AI analysis not used",
    textChars: readableText.length,
  };
}

function heuristicHighlightForText(value) {
  const source = textPdfSource(value || "");
  const range = autismFlavorRanges(source)[0] || fallbackAutismFlavorRange(source);
  const text = range ? source.slice(range.start, range.end).trim() : "";
  return {
    text: normalizeHighlightText(text),
    explanation: highlightExplanationForPhrase(text),
  };
}

function highlightExplanationForPhrase(value) {
  const text = String(value || "").toLowerCase();
  if (/\bwhat'?s going to happen|know for a fact|certainty|uncertainty|predictable|proof|make sure\b/.test(text)) {
    return "It shows the need for certainty and a stable rule before the situation feels safe enough to trust.";
  }
  if (/\boverwhelm|panic|shutdown|meltdown|spiral|stress|unsafe\b/.test(text)) {
    return "It shows distress becoming a body-level regulation problem, not just ordinary annoyance.";
  }
  if (/\bsensory|sound|noise|comfort|comfortable|safe|safety|body|bumpy|texture|light|smell\b/.test(text)) {
    return "It shows sensory comfort and body safety carrying unusual weight in the decision.";
  }
  if (/\broutine|transition|switch|same|stable|change|back and forth|commit\b/.test(text)) {
    return "It shows switching and change carrying a heavier cost than the surface situation suggests.";
  }
  if (/\bmask|camouflage|normal|fit in|hide|compensate\b/.test(text)) {
    return "It shows the social self-monitoring and masking layer that often makes autistic experience harder to see from outside.";
  }
  if (/\bsocial|conversation|relationship|tone|misread|block|love|respond\b/.test(text)) {
    return "It shows social meaning being treated as something that has to be decoded instead of automatically felt.";
  }
  if (/\bfixed|focus|exact|details|rules|patterns|categories|system\b/.test(text)) {
    return "It shows a narrow, exact pattern taking on more importance than the topic would usually carry.";
  }
  return "It is the strongest personal pattern in this note, even though the note itself is lower-signal overall.";
}

function lowSignalAdhdBaseline(readableText, anchors = []) {
  const text = String(readableText || "");
  if (text.length < 20) return { score: 6, cap: 10 };
  const lengthPoints = text.length >= 2200
    ? 8
    : text.length >= 1200
      ? 6
      : text.length >= 600
        ? 4
        : text.length >= 180
          ? 2
          : 0;
  const personalAnchorCount = anchors.filter((anchor) => {
    return /\b(?:i|me|my|want|need|can't|cant|cannot|hard|frustrat|overwhelm|focus|start|finish|time|plan|forget|lost|momentum|motivation|step|task)\b/i.test(anchor);
  }).length;
  const anchorStrength = anchors.slice(0, 6).reduce((sum, anchor) => {
    return sum + Math.min(6, Math.max(0, anchorScore(anchor) - 4));
  }, 0);
  const score = Math.max(7, Math.min(26, 7 + lengthPoints + personalAnchorCount + Math.round(anchorStrength / 4)));
  return { score, cap: Math.max(12, Math.min(30, score + 4)) };
}

function analyzeAdhdText(value) {
  const readableSource = normalizeForPdf(value);
  const text = readableSource.toLowerCase();
  const readableText = text.replace(/\s+/g, " ").trim();
  const anchors = extractAnalysisAnchors(readableSource);
  const formal = matchStats(text, /\badhd letter\b|\battention[- ]deficit\/?hyperactivity disorder\b|\bdiagnos(?:ed|is) (?:with|of) adhd\b|\bmeets criteria for adhd\b|\battention[- ]deficit hyperactivity disorder\b/g);
  const direct = matchStats(text, /\badhd\b|\battention[- ]deficit\b|\bexecutive function(?:ing)?\b|\binattention\b|\bhyperactiv(?:e|ity)\b|\bimpulsiv(?:e|ity)\b/g);
  const attention = matchStats(text, /\battention\b|\bfocus\b|\bfocusing\b|\bdistract(?:ed|ible|ion)?\b|\bsustain(?:ed)? attention\b|\bboring\b|\binteresting\b|\bzoning out\b|\bcan't concentrate\b|\bcant concentrate\b|\bone thing\b|\bstay on\b/g);
  const executive = matchStats(text, /\bexecutive function(?:ing)?\b|\bprocrastinat(?:e|ing|ion)\b|\bfollow through\b|\bfinish(?:ing)? (?:the )?task\b|\bstart(?:ing)? (?:the )?task\b|\bcan't start\b|\bcant start\b|\bcannot start\b|\btask(?:s)?\b|\btoo many steps\b|\bsetup steps\b|\bmake myself\b|\bget started\b|\bgetting started\b|\bstuck (?:on|with) (?:the )?task\b|\bmental load\b|\bwarm[- ]?up period\b|\bramp(?:ing)? up\b|\bactivation energy\b|\bgetting into\b|\bstart friction\b|\btask friction\b|\blost momentum\b|\bmotivation\b/g);
  const organization = matchStats(text, /\bforget(?:ting|s|ful)?\b|\blose\b|\blost\b|\bmisplace\b|\btime(?: blindness)?\b|\bdeadline\b|\blate\b|\bappointment\b|\bcalendar\b|\bschedule\b|\borganize(?:d|ing|ation)?\b|\bplan(?:ning)?\b|\bpriorit(?:y|ize|izing)\b/g);
  const impulsivity = matchStats(text, /\bimpuls(?:e|ive|ivity)\b|\binterrupt\b|\bblurting?\b|\bcan't wait\b|\bcant wait\b|\bspend(?:ing)?\b|\bbuy(?:ing)?\b|\bswitch tabs\b|\bjump(?:ing)? between\b|\bact first\b/g);
  const restlessness = matchStats(text, /\brestless\b|\bfidget(?:ing)?\b|\bsquirm\b|\bon the go\b|\bdriven by a motor\b|\bcan't sit\b|\bcant sit\b|\bpace\b|\bpacing\b|\bbody wants to move\b/g);
  const regulation = matchStats(text, /\boverwhelm(?:ed|ing)?\b|\bfrustrat(?:ed|ion|ing)?\b|\birritab(?:le|ility)\b|\bangry\b|\bannoy(?:ed|ing)?\b|\bstress(?:ed|ful)?\b|\bemotion(?:al|ally)?\b|\bmood\b|\bpanic\b|\btoo much\b/g);
  const hyperfocus = matchStats(text, /\bhyperfocus\b|\bdeep focus\b|\bintense focus\b|\bfixat(?:e|ed|ion)\b|\binterest(?:ing)? enough\b|\bcan focus for hours\b|\bone thing for hours\b|\blocked in\b/g);
  const impact = matchStats(text, /\bwork\b|\bschool\b|\brelationship\b|\bdaily life\b|\bfunction(?:ing)?\b|\bneed(?:s|ed)? help\b|\bsupport\b|\baccommodation(?:s)?\b|\bhard for me\b|\bhard to\b|\bdifficult(?:y)?\b|\baffects?\b|\bcan't do\b|\bcant do\b/g);
  const autism = matchStats(text, /\bautis(?:m|tic)\b|\basd\b|\bsensory\b|\broutine\b|\bsameness\b|\bmasking\b/g);

  const formalPoints = formal.count ? 34 + Math.min(12, formal.count * 5) : 0;
  const directPoints = direct.count ? 20 + Math.min(16, direct.count * 3 + direct.terms.length * 2) : 0;
  const attentionPoints = scoreDimension(attention, 20);
  const executivePoints = scoreDimension(executive, 22);
  const organizationPoints = scoreDimension(organization, 18);
  const impulsivityPoints = scoreDimension(impulsivity, 16);
  const restlessnessPoints = scoreDimension(restlessness, 14);
  const regulationPoints = scoreDimension(regulation, 16);
  const hyperfocusPoints = scoreDimension(hyperfocus, 14);
  const impactPoints = scoreDimension(impact, 14);
  const autismPoints = autism.count ? Math.min(8, autism.count * 2 + autism.terms.length) : 0;
  const rawScore = formalPoints + directPoints + attentionPoints + executivePoints + organizationPoints + impulsivityPoints + restlessnessPoints + regulationPoints + hyperfocusPoints + impactPoints + autismPoints;
  const coreDomains = [attention, executive, organization, impulsivity, restlessness].filter((stats) => stats.count > 0).length;
  const contextDomains = [regulation, hyperfocus, impact].filter((stats) => stats.count > 0).length;
  const evidenceDomains = coreDomains + contextDomains;

  const baseline = lowSignalAdhdBaseline(readableText, anchors);
  let cap = baseline.cap;
  if (formal.count && direct.count && evidenceDomains >= 3) cap = 98;
  else if (formal.count || (direct.count && evidenceDomains >= 5)) cap = 96;
  else if (direct.count && evidenceDomains >= 4) cap = 94;
  else if (evidenceDomains >= 6) cap = 90;
  else if (direct.count && evidenceDomains >= 2) cap = 86;
  else if (evidenceDomains === 5) cap = 84;
  else if (evidenceDomains === 4) cap = 78;
  else if (direct.count) cap = 72;
  else if (evidenceDomains === 3) cap = 68;
  else if (evidenceDomains === 2) cap = 54;
  else if (evidenceDomains === 1) cap = 38;
  else if (autism.count) cap = Math.max(cap, 28);

  const baselineScore = baseline.score;
  let signalFloor = baselineScore;
  if (formal.count || direct.count) signalFloor = Math.max(signalFloor, 58);
  if (coreDomains >= 1) signalFloor = Math.max(signalFloor, 30);
  if (coreDomains >= 1 && contextDomains >= 1) signalFloor = Math.max(signalFloor, 42);
  if (evidenceDomains >= 3) signalFloor = Math.max(signalFloor, 52);
  if (evidenceDomains >= 4) signalFloor = Math.max(signalFloor, 64);
  if (evidenceDomains >= 5) signalFloor = Math.max(signalFloor, 74);
  if (evidenceDomains >= 6) signalFloor = Math.max(signalFloor, 82);
  const highlight = heuristicAdhdHighlightForText(readableSource);
  const finalScore = clampAutismScore(Math.max(signalFloor, Math.min(baselineScore + rawScore, cap)));
  return {
    score: finalScore,
    explanation: adhdAnalysisText(finalScore, {
      formal,
      direct,
      attention,
      executive,
      organization,
      impulsivity,
      restlessness,
      regulation,
      hyperfocus,
      impact,
      autism,
      evidenceDomains,
      hasReadableText: readableText.length >= 20,
      anchors,
      highlight,
    }),
    highlightText: highlight.text,
    highlightExplanation: highlight.explanation,
    scoreSource: "heuristic",
    scoreModel: "browser heuristic",
    scoreConfidence: "low",
    scoreWarning: "AI analysis not used",
    textChars: readableText.length,
  };
}

function analyzeLifeLeverageText(value) {
  const readableSource = normalizeForPdf(value);
  const text = readableSource.toLowerCase();
  const readableText = text.replace(/\s+/g, " ").trim();
  const anchors = extractAnalysisAnchors(readableSource);
  if (readableText.length < 20) {
    return {
      score: 1,
      explanation: "There is not enough readable thought here to tell whether it moves the Disney, R&D, career, money, or execution path. The bank should not pretend empty text is useful.",
      highlightText: "",
      highlightExplanation: "",
      scoreSource: "heuristic",
      scoreModel: "browser heuristic",
      scoreConfidence: "low",
      scoreWarning: "AI analysis not used",
      textChars: readableText.length,
    };
  }

  const disneyCareer = matchStats(text, /\bdisney\b|\bimagineer(?:ing)?\b|\bwdi\b|\bresearch scientist\b|\br&d\b|\br and d\b|\bsoft robotics\b|\brobotics\b|\bmechanical\b|\bhardware\b|\bprototype\b|\bpneumatic\b|\bactuator\b|\bmechanism\b|\blinkage\b|\bmorph(?:ing)?\b|\bpublication\b|\bpaper\b|\bpatent\b|\bportfolio\b|\bphd\b|\bresearch engineer\b|\bscientist engineer\b/g);
  const money = matchStats(text, /\bmoney\b|\brich\b|\brevenue\b|\bincome\b|\bprofit\b|\bsalary\b|\bpaid\b|\bclient\b|\bcustomer\b|\bsell(?:ing)?\b|\bbusiness\b|\bstartup\b|\bmarket\b|\bjob offer\b|\bbonus\b|\bcash\b|\bfinance\b|\bloan\b|\bcredit\b|\bspend(?:ing)?\b|\bprice\b|\bcost\b|\bbudget\b|\bmerchant\b|\bmake money\b|\bsuccessful\b/g);
  const career = matchStats(text, /\bcareer\b|\bjob\b|\bwork\b|\binterview\b|\bresume\b|\bcv\b|\bportfolio\b|\bapplication\b|\brecruit(?:er|ing)?\b|\bcompany\b|\bdisney\b|\bimagineer(?:ing)?\b|\btri\b|\btoyota research\b|\bintuitive\b|\bpostdoc\b|\bresearcher\b|\bscientist\b|\bengineer\b|\bmechanical\b|\brobotics\b|\bhardware\b|\bprototype\b|\bpatent\b/g);
  const research = matchStats(text, /\bphd\b|\bresearch\b|\bpaper\b|\bpublication\b|\bexperiment\b|\bmechanism\b|\blinkage\b|\bwavevis\b|\bfluxcell\b|\bsoft robotics\b|\bpneumatic\b|\bactuator\b|\bmorph(?:ing)?\b|\bsimulation\b|\bfabricat(?:e|ion)\b|\btest rig\b|\bdataset\b|\bfigure\b|\br&d\b|\br and d\b/g);
  const car = matchStats(text, /\bnice car\b|\bcar\b|\ba3\b|\baudi\b|\bmini\b|\bquattro\b|\bbuild\b|\bsteering\b|\binterior\b|\bdown payment\b|\bmonthly payment\b|\bpayment\b|\binsurance\b|\bdealer\b|\btrim\b/g);
  const happiness = matchStats(text, /\bhappy\b|\bhappiness\b|\brelationship\b|\blove\b|\bfriends?\b|\bfamily\b|\bhealth\b|\bsleep\b|\bexercise\b|\bfood\b|\bcooking\b|\bcomfort\b|\bcalm\b|\blife\b|\bquality of life\b|\bhome\b|\bfun\b|\bviolin\b|\bdisney\b|\bvacation\b/g);
  const execution = matchStats(text, /\bgoal\b|\bplan\b|\bnext step\b|\baction\b|\bpriority\b|\bfocus\b|\bschedule\b|\broutine\b|\bsystem\b|\bautomation\b|\bautomate\b|\bworkflow\b|\bprogress\b|\bspec\b|\baolabs\b|\bcodex\b|\bapp\b|\bsite\b|\bbug\b|\bfix\b|\bverify\b|\bdeploy\b|\bsync\b|\brebuild\b|\breduce friction\b|\bless cognitive load\b/g);
  const lowReturn = matchStats(text, /\brandom\b|\btangent\b|\bside topic\b|\bside-topic\b|\bvent\b|\bargument\b|\bscroll(?:ing)?\b|\bdistraction\b|\bwaste of time\b/g);

  const targetDomains = [disneyCareer, money, career, research, car, happiness, execution].filter((stats) => stats.count > 0).length;
  const goalPoints = scoreDimension(disneyCareer, 28)
    + scoreDimension(money, 18)
    + scoreDimension(career, 18)
    + scoreDimension(research, 22)
    + scoreDimension(car, 10)
    + scoreDimension(happiness, 14)
    + scoreDimension(execution, 20);
  const tangentPenalty = targetDomains ? Math.min(14, lowReturn.count * 3 + lowReturn.terms.length * 2) : 0;
  const detailBonus = Math.min(10, anchors.length * 2);
  let cap = 38;
  if (targetDomains >= 5) cap = 96;
  else if (targetDomains >= 4) cap = 90;
  else if (targetDomains >= 3) cap = 82;
  else if (targetDomains >= 2) cap = 70;
  else if (targetDomains === 1) cap = 58;
  if (disneyCareer.count && (career.count || research.count || execution.count)) cap = Math.max(cap, 94);
  if ((money.count || career.count || research.count) && (execution.count || car.count || happiness.count)) cap = Math.max(cap, 86);
  if (money.count && career.count && research.count) cap = Math.max(cap, 94);
  if (car.count && !disneyCareer.count && !career.count && !research.count && !execution.count) cap = Math.min(cap, 48);
  if (car.count && (money.count || happiness.count) && !disneyCareer.count && !research.count && !execution.count) cap = Math.min(cap, 64);
  if (!targetDomains && lowReturn.count) cap = Math.min(cap, 34);
  if (execution.count && /(?:codex|app|site|spec|progress|aolabs|workflow|system|rule|fix|pattern|friction)/i.test(text)) cap = Math.max(cap, 58);
  const baseline = targetDomains ? 18 : 8;
  const raw = baseline + goalPoints + detailBonus - tangentPenalty;
  const score = clampAutismScore(Math.max(1, Math.min(raw, cap)));
  const highlight = heuristicDisneyHighlightForText(readableSource, { anchors, disneyCareer, money, career, research, car, happiness, execution });
  return {
    score,
    explanation: lifeLeverageAnalysisText(score, { disneyCareer, money, career, research, car, happiness, execution, lowReturn, anchors, targetDomains, highlight }),
    highlightText: highlight.text,
    highlightExplanation: highlight.explanation,
    scoreSource: "heuristic",
    scoreModel: "browser heuristic",
    scoreConfidence: "low",
    scoreWarning: "AI analysis not used",
    textChars: readableText.length,
  };
}

function lifeLeverageAnalysisText(score, evidence) {
  const strongest = [
    evidence.disneyCareer.count ? "Disney/R&D" : "",
    evidence.money.count ? "money" : "",
    evidence.career.count ? "career" : "",
    evidence.research.count ? "research" : "",
    evidence.car.count ? "car" : "",
    evidence.happiness.count ? "happiness" : "",
    evidence.execution.count ? "execution" : "",
  ].filter(Boolean);
  const concrete = evidence.anchors?.slice(0, 3) || [];
  if (score >= 80) {
    const lane = strongest.length ? humanJoin(strongest.slice(0, 3)) : "the Disney/R&D path";
    const detailText = concrete.length
      ? `It gives ${humanJoin(concrete)}.`
      : "The details are specific enough to turn into an action or system change.";
    return `This connects directly to ${lane} instead of staying as a side thought. ${detailText}`;
  }
  if (score >= 55) {
    const lane = strongest.length ? humanJoin(strongest.slice(0, 3)) : "execution";
    return `This can improve ${lane}, but it is not a direct Imagineering or research move by itself. It still helps motivation, systems, or execution if acted on.`;
  }
  if (evidence.lowReturn.count && evidence.execution.count) {
    return "This starts as a side thought, but it also captures a system or friction rule that can prevent the same annoying mistake later. Useful, not the core career lane.";
  }
  if (evidence.lowReturn.count) {
    return "This reads mostly like a side thought rather than a career, research, money, car-motivation, or execution move. It can stay saved without dominating attention.";
  }
  return "This does not clearly point toward Imagineering, R&D, money, career, the car path, or a concrete system improvement. It stays above zero because saved thoughts can still reveal patterns later.";
}

function heuristicDisneyHighlightForText(value, evidence = {}) {
  const source = normalizeForPdf(value || "");
  const anchors = evidence.anchors || extractAnalysisAnchors(source);
  const candidates = [
    ...completePhraseCandidates(source).map((candidate) => candidate.text),
    ...anchors,
  ]
    .map((candidate, index) => {
      const phrase = normalizeHighlightText(candidate);
      return { phrase, index, score: disneyPhraseScore(phrase) };
    })
    .filter((item) => item.phrase && !isWeakHighlight(item.phrase))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0]?.phrase || normalizeHighlightText(anchors[0] || source);
  return {
    text: best,
    explanation: highlightExplanationForDisneyPhrase(best),
  };
}

function disneyPhraseScore(value) {
  const text = textPdfSource(value || "").toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = phraseFitScore(text, 18);
  if (/\b(?:disney|imagineer|imagineering|wdi|r&d|r and d|research scientist|research engineer|scientist engineer)\b/.test(text)) score += 70;
  if (/\b(?:soft robotics|robotics|mechanical|hardware|prototype|pneumatic|actuator|mechanism|linkage|morph|simulation|fabricat|experiment|paper|publication|patent|portfolio|phd)\b/.test(text)) score += 52;
  if (/\b(?:career|job|work|resume|cv|application|recruit|company|engineer|scientist|researcher)\b/.test(text)) score += 38;
  if (/\b(?:money|rich|income|salary|paid|cash|finance|business|revenue|profit|successful|make money)\b/.test(text)) score += 30;
  if (/\b(?:goal|plan|next step|action|priority|system|workflow|aolabs|codex|progress|spec|fix|verify|deploy|sync|reduce friction)\b/.test(text)) score += 28;
  if (/\b(?:car|a3|audi|mini|quattro|steering|interior|payment|dealer)\b/.test(text)) score += 18;
  if (/\b(?:happy|happiness|health|sleep|relationship|comfort|calm|life)\b/.test(text)) score += 12;
  if (/\bi\b|\bmy\b|\bme\b/.test(text)) score += 6;
  if (words < 5 || words > 20) score -= 18;
  return score;
}

function highlightExplanationForDisneyPhrase(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(?:disney|imagineer|imagineering|wdi)\b/.test(text)) {
    return "It directly points at the Disney Imagineering direction instead of only describing a side interest.";
  }
  if (/\b(?:r&d|r and d|research|soft robotics|robotics|mechanical|hardware|prototype|pneumatic|actuator|mechanism|linkage|experiment|paper|publication|patent|portfolio|phd)\b/.test(text)) {
    return "It points at the R&D body of work that can make the Disney career path more real.";
  }
  if (/\b(?:career|job|work|resume|cv|application|recruit|company|engineer|scientist|researcher)\b/.test(text)) {
    return "It connects the thought to career movement instead of leaving it as a private observation.";
  }
  if (/\b(?:money|rich|income|salary|paid|cash|finance|business|revenue|profit|successful|make money)\b/.test(text)) {
    return "It ties the thought to money and success, which can support the career path if it becomes action.";
  }
  if (/\b(?:car|a3|audi|mini|quattro|steering|interior|payment|dealer)\b/.test(text)) {
    return "It captures car motivation, which can push work and money, but is more indirect than research or career action.";
  }
  if (/\b(?:goal|plan|next step|action|priority|system|workflow|aolabs|codex|progress|spec|fix|verify|deploy|sync|reduce friction)\b/.test(text)) {
    return "It turns the thought into a system or action path instead of leaving it loose in the bank.";
  }
  return "It is the clearest phrase for whether this thought can become career, money, research, or execution momentum.";
}

function heuristicAdhdHighlightForText(value) {
  const source = textPdfSource(value || "");
  const range = adhdFlavorRanges(source)[0];
  const text = range ? source.slice(range.start, range.end).trim() : "";
  return {
    text: normalizeHighlightText(text),
    explanation: highlightExplanationForAdhdPhrase(text),
  };
}

function highlightExplanationForAdhdPhrase(value) {
  const text = String(value || "").toLowerCase();
  if (/\bfocus|attention|distract|concentrate|boring|interesting\b/.test(text)) {
    return "It shows focus depending on interest instead of staying available just because the task needs it.";
  }
  if (/\bexecutive|procrastinat|finish|start|can't start|cant start|cannot start|task|follow through|too many steps|setup steps|make myself|getting started|stuck|warm[- ]?up|ramp|activation energy|getting into|task friction|lost momentum|motivation\b/.test(text)) {
    return "It shows the hard part is getting the task started, sequenced, or finished.";
  }
  if (/\bforget|lose|lost|time|deadline|late|calendar|organize|plan|priority\b/.test(text)) {
    return "It shows memory, time, or organization adding friction before the task can even move.";
  }
  if (/\bimpuls|interrupt|can't wait|cant wait|spend|buy|switch tabs|jump\b/.test(text)) {
    return "It shows the pressure to act or switch quickly before there is time to steer it.";
  }
  if (/\brestless|fidget|on the go|motor|can't sit|cant sit|pace|move\b/.test(text)) {
    return "It shows the body wanting movement, not just the mind disliking the situation.";
  }
  if (/\boverwhelm|frustrat|irritab|angry|annoy|stress|emotion|mood|panic|too much\b/.test(text)) {
    return "It shows task friction turning into frustration or overwhelm.";
  }
  if (/\bhyperfocus|deep focus|intense focus|fixat|hours\b/.test(text)) {
    return "It shows attention locking hard onto one thing while other priorities drop away.";
  }
  return "It is the closest attention, task, time, or regulation clue in a lower-signal ADHD note.";
}

function adhdLowSignalLead(anchors = [], seedText = "") {
  const topic = anchors.length
    ? `the readable parts cover ${humanJoin(anchors.slice(0, 2))}`
    : "there is not much ADHD-specific readable detail";
  const templates = [
    `The ADHD signal is light here because ${topic}.`,
    `This stays low for ADHD because ${topic}.`,
    `The ADHD read is only a weak background signal because ${topic}.`,
    `There is some ADHD-shaped material here, but ${topic}.`,
    `For ADHD, this entry gives a small signal because ${topic}.`,
  ];
  return templates[stableAnalysisIndex(`${seedText}:${topic}:adhd-low`, templates.length)];
}

function adhdAnalysisText(score, evidence) {
  const anchors = evidence.anchors || [];
  const highlight = evidence.highlight || {};
  if (score <= 14) {
    if (!evidence.hasReadableText) {
      return "This file has almost no readable text for ADHD analysis. The read is cautious and low-signal, not 0 and not proof of no ADHD traits.";
    }
    return `${adhdLowSignalLead(anchors, `${highlight.text || ""}:${score}`)} Low does not mean zero; it means this note does not give much attention, task-starting, time, memory, restlessness, or impulsivity evidence.`;
  }
  const reasons = [];
  if (evidence.formal.count) reasons.push("the ADHD diagnosis or letter context");
  else if (evidence.direct.count) reasons.push("direct ADHD or executive-function language");
  if (evidence.attention.count) reasons.push("attention and focus being unstable or interest-driven");
  if (evidence.executive.count) reasons.push("starting, sequencing, or finishing tasks carrying extra load");
  if (evidence.organization.count) reasons.push("time, memory, planning, or organization friction");
  if (evidence.impulsivity.count) reasons.push("quick-action or quick-switching pressure");
  if (evidence.restlessness.count) reasons.push("restlessness or body activation");
  if (evidence.regulation.count) reasons.push("frustration, overwhelm, or emotional load");
  if (evidence.hyperfocus.count) reasons.push("attention locking onto one thing");
  if (evidence.impact.count) reasons.push("work, school, daily-life, or support impact");
  if (evidence.autism.count && reasons.length < 3) reasons.push("autism or sensory context that overlaps with executive load");

  const mainReason = reasons.length ? humanJoin(reasons.slice(0, 4)) : "only light attention or executive-function evidence";
  const strength = score >= 94
    ? "very strong ADHD evidence"
    : score >= 80
      ? "strongly ADHD-shaped"
      : score >= 50
        ? "a real ADHD-trait signal"
        : "a lighter ADHD-trait signal";
  const boundary = score >= 94
    ? "A perfect read would need fuller impairment or diagnostic detail from the entry itself."
    : score >= 70
      ? "That is high because the attention/execution pattern stacks across more than one setting, not because one word appears."
      : score < 40
        ? "That keeps it low-signal, not zero."
        : "That keeps it in the middle instead of treating it like a diagnosis letter.";
  if (highlight.text) {
    const reason = highlight.explanation
      ? traitSignalLead("adhd", highlight.explanation, `${highlight.text}:${anchors[0] || ""}`)
      : traitFallbackLead("adhd", `${highlight.text}:${anchors[0] || ""}`);
    const detailAnchors = anchors
      .filter((anchor) => anchorSimilarity(anchor, highlight.text) < 0.62)
      .slice(0, 3);
    const detailText = detailAnchors.length
      ? ` ${supportDetailsSentence(detailAnchors)}`
      : "";
    return `${reason}${detailText} This reads as ${strength} because ${mainReason}. ${boundary}`;
  }
  const anchorLead = anchors.length
    ? `This entry turns on ${humanJoin(anchors.slice(0, 3))}.`
    : "This entry has enough readable material to judge the ADHD-trait signal.";
  return `${anchorLead} This reads as ${strength}. The signal is ${mainReason}. ${boundary}`;
}

function normalizeHighlightText(value) {
  return completeHighlightPhrase(value, 18).slice(0, 160).trim();
}

function normalizeHighlightExplanation(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.slice(0, 360);
}

function lowercaseFirst(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : "";
}

function sentenceStart(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function autismAnalysisText(score, evidence) {
  const anchors = evidence.anchors || [];
  if (score <= 14) {
    if (!evidence.hasReadableText) {
      return "This file has almost no readable text for autism analysis. The read is cautious and low-signal, not 0 and not proof of no autistic traits.";
    }
    const anchorText = anchors.length ? ` The readable parts cover ${humanJoin(anchors.slice(0, 2))}.` : "";
    return `This is low-signal for autism from the readable text, but I would not call it 0 or use it as neurotypical proof.${anchorText}`;
  }

  const reasons = [];
  if (evidence.formal.count) reasons.push("the diagnosis or evaluation language");
  else if (evidence.direct.count) reasons.push("direct autism language");
  if (evidence.social.count) reasons.push("people, conversation, or relationships feeling hard to read");
  if (evidence.sameness.count) reasons.push("switching or changes seeming hard");
  if (evidence.sensory.count) reasons.push("sound, comfort, safety, or body feel mattering a lot");
  if (evidence.focused.count) reasons.push("fixed preferences or intense focus");
  if (evidence.masking.count) reasons.push("masking or social-mode switching");
  if (evidence.predictability.count) reasons.push("a strong need for proof, predictability, or if-then certainty");
  if (evidence.regulation.count) reasons.push("overwhelm or stress carrying a lot of weight");
  if (evidence.functioning.count) reasons.push("effects on work, safety, support, or daily functioning");
  if (evidence.adhd.count && reasons.length < 3) reasons.push("ADHD or executive-function context");

  const mainReason = reasons.length
    ? humanJoin(reasons.slice(0, 4))
    : "there is some autism-adjacent context, but not much strong evidence";
  const anchorLead = anchors.length
    ? `This note turns on ${humanJoin(anchors.slice(0, 3))}.`
    : "This note has enough readable material to judge the autism-trait signal.";
  const lead = score >= 94
    ? `${anchorLead} This reads as very strong autism evidence.`
    : score >= 80
      ? `${anchorLead} This reads as strongly autism-shaped.`
      : score >= 50
        ? `${anchorLead} This reads as a real autism-trait signal.`
        : `${anchorLead} This reads as a lighter autism-trait signal.`;
  let boundary = "";
  if (evidence.support.count) {
    boundary = "It lands very high because support or severity is named too.";
  } else if (score >= 94) {
    boundary = "A perfect read would need Level 3 or high-support autism detail in the entry itself.";
  } else if (!evidence.formal.count && !evidence.direct.count && score >= 80) {
    boundary = "It can still score high without the word autism because those patterns keep stacking up.";
  } else if (evidence.adhd.count && score < 50) {
    boundary = "ADHD counts as neurodivergent context here, but it is not enough by itself to make this high.";
  } else if (score < 40) {
    boundary = "That makes it low-signal, not a statement that there are no autistic traits.";
  } else {
    boundary = "That is why it lands in the middle instead of the very top band.";
  }

  return `${lead} The signal is ${mainReason}. ${boundary}`;
}

function extractAnalysisAnchors(value) {
  const text = normalizeForPdf(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  const clauses = text
    .split(/[\n.!?;]+|,\s+(?=(?:and|but|because|when|while|then|so|if|the|i)\b)/i)
    .map((part) => cleanAnchor(part))
    .filter(Boolean);
  const scored = clauses.map((clause, index) => ({
    clause,
    index,
    score: anchorScore(clause),
  }));
  return scored
    .filter((item) => item.score > 0 || item.clause.split(/\s+/).length >= 6)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.clause)
    .filter((item, index, list) => list.findIndex((other) => anchorSimilarity(item, other) > 0.72) === index)
    .slice(0, 5);
}

function cleanAnchor(value) {
  let text = String(value || "")
    .replace(/^[\s\-*\u2022\d.)\];:]+/, "")
    .replace(/\b(and|but|because|so)\s+\1\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i += 1) {
    text = text
      .replace(/^(?:,|\.)+\s*/, "")
      .replace(/^(?:and|but|because|so|then|while|when)\b[\s,]*/i, "")
      .trim();
  }
  if (/\b(?:application\/pdf|pdf generated|generated pdf|autism score|adhd score|disney score|score \d|synced -|browser heuristic)\b/i.test(text)) return "";
  if (/^(?:this entry|this note|the note|the score|i read|the selected|the phrase|the concrete pieces|other details carry|the autism-relevant|the adhd-relevant)\b/i.test(text)) return "";
  if (/\b(?:autism-shaped|adhd-shaped|autism-trait signal|adhd-trait signal|diagnostic-letter range|low-signal|high-signal saved note)\b/i.test(text)) return "";
  if (!text || text.length < 12) return "";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return "";
  return (words.length > 18 ? `${words.slice(0, 18).join(" ")}...` : words.join(" ")).slice(0, 140);
}

function anchorScore(value) {
  const text = String(value || "").toLowerCase();
  let score = 0;
  const patterns = [
    /\bpredict|certainty|uncertain|proof|know|what'?s going to happen|if\b/,
    /\bsound|noise|comfort|comfortable|safe|safety|body|texture|light|bumpy|metal box\b/,
    /\bsocial|conversation|relationship|respond|text|tone|misread|confus|block|love\b/,
    /\broutine|switch|transition|change|same|stable|commit|back and forth\b/,
    /\boverwhelm|panic|shutdown|meltdown|stress|anxiety|hard to handle|too much\b/,
    /\bfocus|fixed|interest|exact|details|pattern|rule|category|audi|car\b/,
    /\btask|start|finish|setup steps|getting started|lost momentum|motivation|deadline|schedule|forget|time\b/,
    /\bmask|normal|fit in|hide|compensat|camouflag\b/,
    /\badhd|executive function|attention|hyperfocus\b/,
    /\bautis|asd|diagnos|evaluation|assessment\b/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) score += 3;
  }
  if (/\bi\b|\bme\b|\bmy\b/.test(text)) score += 1;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 7 && words <= 18) score += 1;
  return score;
}

function anchorSimilarity(a, b) {
  const left = new Set(String(a || "").toLowerCase().split(/[^a-z0-9']+/).filter((token) => token.length >= 4));
  const right = new Set(String(b || "").toLowerCase().split(/[^a-z0-9']+/).filter((token) => token.length >= 4));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

function humanJoin(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function clampAutismScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(100, Math.round(number)));
}

function uniqueMatches(text, pattern) {
  return [...new Set((text.match(pattern) || []).map((item) => item.trim()).filter(Boolean))].slice(0, 5);
}

function matchStats(text, pattern) {
  const matches = [...String(text || "").matchAll(pattern)].map((match) => displayMatchedTerm(match[0])).filter(Boolean);
  return {
    count: matches.length,
    terms: [...new Set(matches)].slice(0, 5),
  };
}

function displayMatchedTerm(value) {
  const term = String(value || "").trim();
  if (!term) return "";
  if (/^if .+ then\b/.test(term)) return "if-then rule";
  if (/\blove me\b|\bdone with me\b|\bblock me\b|\bpick up\b|\brespond\b/.test(term)) return "relationship-certainty cue";
  if (/\baudi\b|\bcar brand\b|\bone audi\b/.test(term)) return "fixed preference / focused interest";
  return term.length > 38 ? `${term.slice(0, 35)}...` : term;
}

function scoreDimension(stats, maxPoints) {
  if (!stats.count) return 0;
  return Math.min(maxPoints, 6 + stats.count * 3 + stats.terms.length * 2);
}

function sortRecords(records) {
  return [...records].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function displayDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function stampForName(value) {
  const date = value ? new Date(value) : new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function extensionLabel(name = "") {
  const match = name.match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "file";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(fileStore);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putBlob(id, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(fileStore, "readwrite");
    tx.objectStore(fileStore).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(fileStore, "readonly");
    const request = tx.objectStore(fileStore).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(fileStore, "readwrite");
    tx.objectStore(fileStore).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
