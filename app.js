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
const overallScore = document.getElementById("overall-autism-score");
const referenceScores = [
  { score: 96, weight: 3, label: "autism evaluation" },
  { score: 34, weight: 0.5, label: "adhd letter" },
];

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
renderOverallScore();
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
      const autism = await analyzeRecordText({
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
        autismScore: autism.score,
        autismScoreExplanation: autism.explanation,
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
  const autism = await analyzeRecordText({
    name: file.name,
    mime: file.mime,
    kind: file.kind,
    text,
  });
  return {
    ...file,
    autismScore: autism.score,
    autismScoreExplanation: autism.explanation,
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
  renderOverallScore();
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

function bankAutismScore() {
  const generated = state
    .filter((item) => (item.kind || "").toLowerCase() === "generated pdf")
    .map((item) => ({
      score: autismScoreForRecord(item),
      weight: generatedScoreWeight(item),
      label: "saved note",
    }))
    .filter((item) => Number.isFinite(item.score));
  const evidence = [...referenceScores, ...generated].filter((item) => item.score > 0);
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

function generatedScoreWeight(item) {
  const pages = Number(item.pages || 0);
  const size = Number(item.size || 0);
  if (pages >= 2 || size >= 3500) return 1.25;
  return 1;
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
  const lineWidth = width - margin * 2;
  const lines = [
    pdfLine(`Created: ${formatPdfTimestamp(createdAt)}`),
    blankPdfLine(),
    ...formattedPdfLines(text, { lineWidth, fontSize, measureText: pdfTextWidth }),
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

function createTextPreviewDataUrl(text, createdAt) {
  const canvas = document.createElement("canvas");
  canvas.width = 612;
  canvas.height = 792;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1e2724";
  context.textBaseline = "top";
  const margin = 54;
  const leading = 24;
  const fontSize = 17;
  const lineWidth = canvas.width - margin * 2;
  const measureText = (value, bold = false) => {
    context.font = `${bold ? "700" : "400"} ${fontSize}px Arial, sans-serif`;
    return context.measureText(value).width;
  };
  const lines = [
    pdfLine(`Created: ${formatPdfTimestamp(createdAt)}`),
    blankPdfLine(),
    ...formattedPdfLines(text, { lineWidth, fontSize, measureText }),
  ];
  lines.slice(0, 27).forEach((line, index) => {
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
  commands.push(`/F1 ${options.fontSize} Tf`);
  commands.push("0 Tw");
  if (line.indent) commands.push(`(${escapePdfString(line.indent)}) Tj`);
  const wordSpacing = pdfWordSpacing(line, Math.max(0, options.lineWidth - indentWidth), options.fontSize);
  if (wordSpacing > 0) commands.push(`${formatPdfNumber(wordSpacing)} Tw`);
  for (const segment of line.segments) {
    if (!segment.text) continue;
    if (Boolean(segment.bold) !== activeBold) {
      activeBold = Boolean(segment.bold);
      commands.push(`/${activeBold ? "F2" : "F1"} ${options.fontSize} Tf`);
    }
    commands.push(`(${escapePdfString(segment.text)}) Tj`);
  }
  commands.push("0 Tw");
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
    if (/^\s+$/.test(segment.text)) {
      x += context.measureText(segment.text).width + wordSpacing * segment.text.length;
      continue;
    }
    context.fillText(segment.text, x, y);
    x += context.measureText(segment.text).width;
  }
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
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

function formattedPdfLines(value, options) {
  const source = textPdfSource(value);
  if (!source.trim()) return [blankPdfLine()];
  const lines = [];
  source.split("\n").forEach((rawLine) => {
    const line = rawLine.replace(/[ \t]+$/g, "");
    if (!line.trim()) {
      lines.push(blankPdfLine());
      return;
    }
    const indent = line.match(/^[ ]*/)?.[0] || "";
    const content = line.slice(indent.length);
    const continuationIndent = indent ? `${indent}  ` : "";
    const firstWidth = Math.max(120, options.lineWidth - options.measureText(indent, false, options.fontSize));
    const restWidth = Math.max(120, options.lineWidth - options.measureText(continuationIndent, false, options.fontSize));
    const wrapped = wrapRichText(content, { ...options, firstWidth, restWidth });
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
  const tokens = tokenizePdfSegments(autismFlavorSegments(text));
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
      tokens.push({ text: part, bold: segment.bold });
    }
  }
  return tokens;
}

function mergeAdjacentPdfSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.bold === segment.bold) {
      previous.text += segment.text;
    } else {
      merged.push({ text: segment.text, bold: Boolean(segment.bold) });
    }
  }
  return merged;
}

function autismFlavorSegments(text) {
  const source = String(text || "");
  const ranges = autismFlavorRanges(source);
  if (!ranges.length) return [{ text: source, bold: false }];
  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: source.slice(cursor, range.start), bold: false });
    segments.push({ text: source.slice(range.start, range.end), bold: true });
    cursor = range.end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), bold: false });
  return segments;
}

function autismFlavorRanges(text) {
  const candidates = [];
  const patterns = [
    { pattern: /\b(?:autism|autistic|asd|diagnosis|diagnostic evaluation)\b/gi, weight: 100 },
    { pattern: /\b(?:what'?s going to happen|know for a fact|if-then|certainty|uncertainty|predictable|predictability|proof|make sure)\b/gi, weight: 92 },
    { pattern: /\b(?:overwhelm|overwhelmed|overwhelming|panic|shutdown|meltdown|spiral|body stops feeling alert|body feel(?:s)? unsafe)\b/gi, weight: 90 },
    { pattern: /\b(?:sensory|metal box|fluorescent|sound|noise|comfort|comfortable|safe|safety|body|bumpy|smooth|quiet|texture|light|smell)\b/gi, weight: 86 },
    { pattern: /\b(?:routine|routines|transition|transitions|switching|same|stable|change|changes|back and forth|commitment|commit)\b/gi, weight: 82 },
    { pattern: /\b(?:masking|mask|camouflage|appear normal|fit in|hide|compensate)\b/gi, weight: 80 },
    { pattern: /\b(?:social cues|eye contact|text back|respond|relationship|conversation|tone|misread|blunt|block me|love me|social)\b/gi, weight: 78 },
    { pattern: /\b(?:special interest|fixed preference|focused interest|fixated|exact|details|rules|patterns|categories|system)\b/gi, weight: 74 },
  ];
  for (const { pattern, weight } of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const range = expandAutismFlavorRange(text, match.index, match.index + match[0].length);
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

function fallbackAutismFlavorRange(text) {
  const clauses = String(text || "")
    .split(/[,.;:!?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).filter(Boolean).length >= 4);
  if (!clauses.length) return null;
  const scored = clauses.map((clause) => ({
    clause,
    score: fallbackClauseScore(clause),
  })).sort((a, b) => b.score - a.score || b.clause.length - a.clause.length);
  const phrase = scored[0].clause.split(/\s+/).slice(0, 14).join(" ");
  const start = text.indexOf(phrase);
  return start >= 0 ? { start, end: start + phrase.length } : null;
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
  return trimRangeToWords(text, rawStart, rawEnd, start, end, 14);
}

function trimRangeToWords(text, start, end, focusStart, focusEnd, maxWords) {
  const prefix = text.slice(start, focusStart).trim().split(/\s+/).filter(Boolean);
  const focus = text.slice(focusStart, focusEnd).trim().split(/\s+/).filter(Boolean);
  const suffix = text.slice(focusEnd, end).trim().split(/\s+/).filter(Boolean);
  let leftCount = Math.max(0, Math.floor((maxWords - focus.length) / 2));
  let rightCount = Math.max(0, maxWords - focus.length - leftCount);
  const words = [
    ...prefix.slice(-leftCount),
    ...focus,
    ...suffix.slice(0, rightCount),
  ];
  if (!words.length) return { start: focusStart, end: focusEnd };
  const phrase = words.join(" ");
  const phraseIndex = text.indexOf(phrase, Math.max(0, start - 1));
  if (phraseIndex >= 0) return { start: phraseIndex, end: phraseIndex + phrase.length };
  return { start: focusStart, end: focusEnd };
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
  const fallback = analyzeAutismText(`${name || ""} ${kind || ""} ${mime || ""} ${readable}`);
  if (sync.status !== "connected" || !sync.base) return fallback;
  try {
    const response = await postJson(`${sync.base}/api/analyze`, {
      name: name || "",
      kind: kind || "",
      mime: mime || "",
      text: readable,
      fallbackScore: fallback.score,
    });
    return normalizeRemoteAnalysis(response.analysis, fallback);
  } catch {
    return fallback;
  }
}

function normalizeRemoteAnalysis(analysis, fallback) {
  const score = clampAutismScore(analysis?.score ?? fallback.score);
  const explanation = String(analysis?.explanation || "").replace(/\s+/g, " ").trim();
  if (!explanation) return fallback;
  return {
    score: Math.max(1, score),
    explanation: explanation.slice(0, 900),
  };
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
  };
}

function autismAnalysisText(score, evidence) {
  const anchors = evidence.anchors || [];
  if (score <= 14) {
    if (!evidence.hasReadableText) {
      return "This file has almost no readable text for me to judge. I am leaving it as a low baseline, not calling it 0 or saying there are no autistic traits.";
    }
    const anchorText = anchors.length ? ` The actual readable parts are mostly about ${humanJoin(anchors.slice(0, 2))}.` : "";
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
    ? `${anchorLead} I read that as very strong autism evidence.`
    : score >= 80
      ? `${anchorLead} I read that as strongly autism-shaped.`
      : score >= 50
        ? `${anchorLead} I read that as a real autism-trait signal.`
        : `${anchorLead} I read that as a lighter autism-trait signal.`;
  let boundary = "";
  if (evidence.support.count) {
    boundary = "I treat it as very high because support or severity is named too.";
  } else if (score >= 94) {
    boundary = "I stop short of 100 because it does not say Level 3 or high-support autism.";
  } else if (!evidence.formal.count && !evidence.direct.count && score >= 80) {
    boundary = "It can still score high without the word autism because those patterns keep stacking up.";
  } else if (evidence.adhd.count && score < 50) {
    boundary = "ADHD counts as neurodivergent context here, but it is not enough by itself to make this high.";
  } else if (score < 40) {
    boundary = "That makes it low-signal, not a statement that there are no autistic traits.";
  } else {
    boundary = "That is why it lands in the middle instead of the very top band.";
  }

  return `${lead} The autism-relevant weight is ${mainReason}. ${boundary}`;
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
  const text = String(value || "")
    .replace(/^[\s\-*\u2022\d.)\]]+/, "")
    .replace(/\s+/g, " ")
    .trim();
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
