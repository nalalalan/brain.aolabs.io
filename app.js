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
  const paragraph = textPdfParagraph(text);
  if (!paragraph) {
    pendingTextPdf = null;
    renderPending();
    return;
  }
  const createdAt = new Date().toISOString();
  const name = `brain-text-${stampForName(createdAt)}.pdf`;
  const result = createTextPdf(paragraph, createdAt);
  pendingTextPdf = {
    id: `text-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    mime: "application/pdf",
    size: result.blob.size,
    createdAt,
    sourceCreatedAt: createdAt,
    kind: "generated pdf",
    pages: result.pages,
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
      nextRecords.push(await saveFileLike({
        id: `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || "uploaded file",
        mime: file.type || "application/octet-stream",
        size: file.size || 0,
        createdAt: new Date().toISOString(),
        sourceCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : "",
        kind: file.type?.startsWith("image/") ? "image" : "file",
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
  if (item.kind === "image") {
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
  const meta = document.createElement("p");
  meta.className = "vault-meta";
  meta.textContent = [item.source === "sync" ? "synced" : "device", item.kind || "file", item.pages ? `${item.pages} pages` : "", formatBytes(item.size || 0), displayDate(item.createdAt)].filter(Boolean).join(" - ");
  main.append(title, meta);

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
  const lines = [`Created: ${formatPdfTimestamp(createdAt)}`, "", ...wrapText(textPdfParagraph(text), maxChars)];
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

function textPdfParagraph(value) {
  return normalizeForPdf(value).replace(/\s+/g, " ").trim();
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
