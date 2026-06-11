const stateKey = "brain-pdf-bank-v1";
const dbName = "brain-pdf-bank-files";
const fileStore = "files";

let state = loadState();
let pendingFiles = [];
let pendingTextPdf = null;
let textTimer = 0;
let openUrls = [];
let autoSyncRunning = false;

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

noteInput?.addEventListener("input", () => scheduleTextPdf());
fileInput?.addEventListener("change", () => {
  stageFiles([...fileInput.files]);
  fileInput.value = "";
});
saveButton?.addEventListener("click", () => savePending());

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
renderVault();
void initSync();

function resolveApiBase() {
  const configured = window.BRAIN_API_BASE;
  if (configured) return String(configured).replace(/\/+$/, "");
  const host = window.location.hostname;
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return window.location.origin;
  if (host === "brain.aolabs.io" || host.endsWith(".up.railway.app")) return window.location.origin;
  return "https://brain.aolabs.io";
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
  const result = createTextPdf(sourceText, createdAt);
  const previewDataUrl = createTextPreviewDataUrl(sourceText, createdAt);
  const autism = analyzeAutismText(sourceText);
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
  if (saveButton) saveButton.disabled = true;
  const nextRecords = [];
  try {
    if (textFile) {
      nextRecords.push(await saveFileLike(textFile));
      pendingTextPdf = null;
      if (noteInput) noteInput.value = "";
    }
    for (const file of files) {
      const autism = await analyzeUploadFile(file);
      nextRecords.push(await saveFileLike({
        id: `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || "uploaded file",
        mime: file.type || "application/octet-stream",
        size: file.size || 0,
        createdAt: new Date().toISOString(),
        sourceCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : "",
        kind: file.type?.startsWith("image/") ? "image" : "file",
        autismScore: autism.score,
        autismScoreExplanation: autism.explanation,
        blob: file,
      }));
    }
    pendingFiles = [];
    state = sortRecords([...nextRecords, ...state.filter((item) => !nextRecords.some((next) => next.id === item.id))]);
    persistState();
  } finally {
    if (saveButton) saveButton.disabled = false;
    renderPending();
    renderVault();
  }
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

async function createVaultItem(item) {
  const row = document.createElement("article");
  row.className = "vault-item";

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
  const score = document.createElement("p");
  score.className = "autism-score";
  score.textContent = `autism score ${autismScoreForRecord(item)}/100`;
  const scoreWhy = document.createElement("p");
  scoreWhy.className = "autism-score-why";
  scoreWhy.textContent = autismExplanationForRecord(item);
  const meta = document.createElement("p");
  meta.className = "vault-meta";
  meta.textContent = [item.source === "sync" ? "synced" : "device", item.kind || "file", item.pages ? `${item.pages} pages` : "", formatBytes(item.size || 0), displayDate(item.createdAt)].filter(Boolean).join(" - ");
  main.append(title, score, scoreWhy, meta);

  const actions = document.createElement("div");
  actions.className = "vault-actions";
  actions.append(
    actionButton("open", () => openRecord(item)),
    actionButton("download", () => downloadRecord(item)),
    actionButton("delete", () => deleteRecord(item), "danger")
  );

  row.append(thumb, main, actions);
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
}

function normalizeSyncFile(file) {
  return {
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
    source: "sync",
  };
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

function createTextPdf(text, createdAt) {
  const width = 612;
  const height = 792;
  const margin = 54;
  const fontSize = 10.5;
  const leading = 15;
  const maxChars = 88;
  const lines = [`Created: ${formatPdfTimestamp(createdAt)}`, "", ...formattedPdfLines(text, maxChars)];
  const maxLines = Math.floor((height - margin * 2) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines));
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids = [];
  pages.forEach((pageLines) => {
    const pageObj = objects.length + 1;
    const contentObj = objects.length + 2;
    kids.push(`${pageObj} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`);
    objects.push(streamForPage(pageLines, { margin, height, fontSize, leading }));
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  const pdf = buildPdf(objects);
  return { blob: new Blob([pdf], { type: "application/pdf" }), pages: pages.length };
}

function createTextPreviewDataUrl(text, createdAt) {
  const canvas = document.createElement("canvas");
  canvas.width = 612;
  canvas.height = 792;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1e2724";
  context.font = "17px Arial, sans-serif";
  context.textBaseline = "top";
  const margin = 54;
  const leading = 24;
  const lines = [`Created: ${formatPdfTimestamp(createdAt)}`, "", ...formattedPdfLines(text, 70)];
  lines.slice(0, 27).forEach((line, index) => {
    context.fillText(line, margin, margin + index * leading);
  });
  return canvas.toDataURL("image/png");
}

function streamForPage(lines, options) {
  const { margin, height, fontSize, leading } = options;
  const commands = [
    "BT",
    `/F1 ${fontSize} Tf`,
    `${leading} TL`,
    `${margin} ${height - margin} Td`,
    ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`),
    "ET",
  ].join("\n");
  return `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
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

function wrapText(text, maxChars) {
  const lines = [];
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let line = "";
  words.forEach((word) => {
    if (word.length > maxChars) {
      if (line) lines.push(line);
      line = "";
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      return;
    }
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function textPdfSource(value) {
  return normalizeForPdf(value)
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

function formattedPdfLines(value, maxChars) {
  const source = textPdfSource(value);
  if (!source.trim()) return [""];
  const lines = [];
  source.split("\n").forEach((rawLine) => {
    const line = rawLine.replace(/[ \t]+$/g, "");
    if (!line.trim()) {
      lines.push("");
      return;
    }
    const indent = line.match(/^[ ]*/)?.[0] || "";
    const content = line.slice(indent.length);
    const width = Math.max(24, maxChars - indent.length);
    wrapText(content, width).forEach((part, index) => {
      lines.push(`${indent}${index > 0 ? "  " : ""}${part}`);
    });
  });
  return lines.length ? lines : [""];
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

async function analyzeUploadFile(file) {
  let text = `${file.name || ""} ${file.type || ""}`;
  if (file.type?.startsWith("text/") || /\.(txt|md|csv|json|pdf)$/i.test(file.name || "")) {
    const readable = await file.text().catch(() => "");
    text += ` ${readable.slice(0, 50000)}`;
  }
  return analyzeAutismText(text);
}

function autismScoreForRecord(item) {
  if (item && item.autismScore !== undefined && item.autismScore !== null && item.autismScore !== "") {
    return clampAutismScore(item.autismScore);
  }
  return analyzeAutismText(`${item?.name || ""} ${item?.kind || ""} ${item?.mime || ""}`).score;
}

function autismExplanationForRecord(item) {
  if (item?.autismScoreExplanation) return String(item.autismScoreExplanation).slice(0, 900);
  return analyzeAutismText(`${item?.name || ""} ${item?.kind || ""} ${item?.mime || ""}`).explanation;
}

function analyzeAutismText(value) {
  const text = normalizeForPdf(value).toLowerCase();
  const extreme = matchStats(text, /\blevel 3\b|\brequir(?:es|ing) very substantial support\b|\bvery substantial support\b|\bsevere autism\b|\bextreme support\b|\bhigh support needs\b/g);
  const formal = matchStats(text, /\bautism diagnostic evaluation\b|\bdiagnos(?:ed|is) (?:with|of) (?:autism|asd|autism spectrum disorder)\b|\bmeets criteria for (?:autism|asd|autism spectrum disorder)\b|\bautism spectrum disorder\b/g);
  const direct = matchStats(text, /\bautis(?:m|tic)\b|\basd\b|\bautism spectrum\b|\bspectrum disorder\b/g);
  const diagnostic = matchStats(text, /\bdiagnostic evaluation\b|\bpsychological evaluation\b|\bneuropsych(?:ological)?\b|\bclinical\b|\breport\b|\bassessment\b|\bevaluation\b/g);
  const predictability = matchStats(text, /\bconcrete anchor(?:s)?\b|\banchor(?:s)?\b|\bunpredictable\b|\bpredictable\b|\bknow for a fact\b|\bmake sure\b|\bto know\b|\bwhat(?:'| i)?s going to happen\b|\bassume\b|\bcertainty\b|\buncertain(?:ty)?\b|\bproof\b|\bif .{0,40} then\b/g);
  const switching = matchStats(text, /\bswitch(?:ing)?\b|\btransition(?:s)?\b|\broutine(?:s)?\b|\bstable path\b|\bsame path\b|\bcommit(?:ting)?\b|\bone goal\b|\bone stable\b|\bchange decisions?\b|\bback and forth\b|\bmentalities\b/g);
  const sensory = matchStats(text, /\bsensory\b|\bcomfort\b|\bcomfortable\b|\bquiet\b|\bsmooth\b|\bbumpy\b|\bugly sound\b|\bsound\b|\baudio\b|\bmetal box\b|\binsulation\b|\btexture\b|\blight(?:s)?\b|\bsmell\b|\bnoise\b|\bsafe\b|\bsafety\b|\bcheap\b/g);
  const masking = matchStats(text, /\bmasking\b|\bunmask(?:ing)?\b|\bsocial life\b|\bsocial(?:ly)?\b|\btone\b|\beye contact\b|\bmisread\b|\bliteral\b|\bblunt\b|\breciprocity\b|\bnonverbal\b|\bconfus(?:e|ion|ed)\b/g);
  const overwhelm = matchStats(text, /\boverwhelm(?:ed|ing)?\b|\btoo much\b|\bhard to handle\b|\bpanic\b|\bshutdown\b|\bmeltdown\b|\bspiral\b|\bcan't handle\b|\bcant handle\b|\bstress(?:ful|ed)?\b|\bannoying\b/g);
  const systems = matchStats(text, /\bspecial interest\b|\brestricted interest\b|\bsystem(?:s|izing)?\b|\brule(?:s)?\b|\bpattern(?:s)?\b|\blist(?:s)?\b|\bexact\b|\bbrand\b|\bcategory\b|\bcategories\b|\baudi\b|\bcar brand\b|\bone audi\b/g);
  const adhd = matchStats(text, /\badhd\b|\battention[- ]deficit\b|\bexecutive function\b|\bhyperfocus\b|\bfocus\b|\binattention\b|\bimpulsiv(?:e|ity)\b/g);

  const extremePoints = extreme.count ? 20 : 0;
  const formalPoints = formal.count ? 26 + Math.min(12, formal.count * 4) : 0;
  const directPoints = direct.count ? 18 + Math.min(16, direct.count * 2 + direct.terms.length * 3) : 0;
  const diagnosticPoints = diagnostic.count ? 8 + Math.min(10, diagnostic.count * 2) : 0;
  const predictabilityPoints = scoreDimension(predictability, 20);
  const switchingPoints = scoreDimension(switching, 18);
  const sensoryPoints = scoreDimension(sensory, 18);
  const maskingPoints = scoreDimension(masking, 18);
  const overwhelmPoints = scoreDimension(overwhelm, 16);
  const systemsPoints = scoreDimension(systems, 14);
  const adhdPoints = adhd.count ? Math.min(10, adhd.count * 2 + adhd.terms.length) : 0;
  const rawScore = extremePoints + formalPoints + directPoints + diagnosticPoints + predictabilityPoints + switchingPoints + sensoryPoints + maskingPoints + overwhelmPoints + systemsPoints + adhdPoints;
  const traitDimensions = [predictability, switching, sensory, masking, overwhelm, systems].filter((stats) => stats.count > 0).length;

  let cap = 10;
  let capReason = "no readable autism-specific or autism-trait evidence";
  if (extreme.count && (formal.count || direct.count || traitDimensions >= 4)) {
    cap = 100;
    capReason = "explicit high-support or severe-autism wording appears with autism evidence";
  } else if (formal.count && direct.count && traitDimensions >= 3) {
    cap = 96;
    capReason = "formal autism wording plus several independent autism-trait dimensions";
  } else if (formal.count && direct.count) {
    cap = 94;
    capReason = "formal autism diagnosis/evaluation wording is present without explicit extreme-support language";
  } else if (direct.count && traitDimensions >= 4) {
    cap = 92;
    capReason = "direct autism wording plus broad trait evidence";
  } else if (traitDimensions >= 5) {
    cap = 86;
    capReason = "many independent autism-trait dimensions appear even without direct autism wording";
  } else if (direct.count && diagnostic.count) {
    cap = 86;
    capReason = "direct autism wording appears with general report/evaluation context";
  } else if (direct.count && traitDimensions >= 2) {
    cap = 84;
    capReason = "direct autism wording appears with multiple trait dimensions";
  } else if (traitDimensions === 4) {
    cap = 78;
    capReason = "four independent autism-trait dimensions appear without direct autism wording";
  } else if (direct.count) {
    cap = 76;
    capReason = "direct autism wording appears but the readable text has limited trait detail";
  } else if (traitDimensions === 3) {
    cap = 70;
    capReason = "three independent autism-trait dimensions appear without direct autism wording";
  } else if (traitDimensions === 2) {
    cap = 58;
    capReason = "two autism-trait dimensions appear without direct autism wording";
  } else if (traitDimensions === 1) {
    cap = 42;
    capReason = "one autism-trait dimension appears without direct autism wording";
  } else if (adhd.count) {
    cap = 34;
    capReason = "ADHD/executive-function language is neurodivergent context, not autism-specific evidence";
  }

  const finalScore = clampAutismScore(Math.min(rawScore, cap));
  const parts = [];
  addScorePart(parts, "extreme-support wording", extremePoints, extreme);
  addScorePart(parts, "formal autism wording", formalPoints, formal);
  addScorePart(parts, "direct autism wording", directPoints, direct);
  addScorePart(parts, "evaluation/report context", diagnosticPoints, diagnostic);
  addScorePart(parts, "predictability/concrete-anchor signal", predictabilityPoints, predictability);
  addScorePart(parts, "switching/routine signal", switchingPoints, switching);
  addScorePart(parts, "sensory/safety-comfort signal", sensoryPoints, sensory);
  addScorePart(parts, "masking/social-interpretation signal", maskingPoints, masking);
  addScorePart(parts, "overwhelm/load signal", overwhelmPoints, overwhelm);
  addScorePart(parts, "systemizing/special-interest signal", systemsPoints, systems);
  addScorePart(parts, "ADHD/executive context", adhdPoints, adhd);
  const breakdown = parts.length ? parts.join(" + ") : "0 matched autism-context evidence";
  const capText = rawScore > finalScore ? `raw ${rawScore} capped at ${cap}` : `raw ${rawScore}, cap ${cap} not reached`;
  return {
    score: finalScore,
    explanation: `Score ${finalScore}/100 = ${breakdown}; ${traitDimensions} trait dimensions; ${capText} because ${capReason}. This is a document-language score, not a clinical severity rating.`,
  };
}

function clampAutismScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
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
  return term.length > 38 ? `${term.slice(0, 35)}...` : term;
}

function scoreDimension(stats, maxPoints) {
  if (!stats.count) return 0;
  return Math.min(maxPoints, 6 + stats.count * 3 + stats.terms.length * 2);
}

function addScorePart(parts, label, points, stats) {
  if (!points) return;
  const terms = stats.terms.length ? `: ${stats.terms.join(", ")}` : "";
  const count = stats.count === 1 ? "1 hit" : `${stats.count} hits`;
  parts.push(`${points} ${label} (${count}${terms})`);
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
