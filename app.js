const stateKey = "brain-pdf-bank-v1";
const dbName = "brain-pdf-bank-files";
const fileStore = "files";

let state = loadState();
let pendingFiles = [];
let pendingTextPdf = null;
let textTimer = 0;
let openUrls = [];

const noteInput = document.getElementById("brain-note");
const fileInput = document.getElementById("brain-files");
const saveButton = document.getElementById("brain-save");
const pendingList = document.getElementById("brain-pending");
const vaultList = document.getElementById("brain-vault");
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

renderPending();
renderVault();

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(stateKey) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistState() {
  localStorage.setItem(stateKey, JSON.stringify(state.slice(0, 500)));
}

function scheduleTextPdf() {
  window.clearTimeout(textTimer);
  textTimer = window.setTimeout(convertTextToPendingPdf, 180);
}

function convertTextToPendingPdf() {
  const text = noteInput?.value.trim() || "";
  if (!text) {
    pendingTextPdf = null;
    renderPending();
    return;
  }
  const createdAt = new Date().toISOString();
  const name = `brain-text-${stampForName(createdAt)}.pdf`;
  const result = createTextPdf(text, "brain text capture");
  pendingTextPdf = {
    id: `text-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    mime: "application/pdf",
    size: result.blob.size,
    createdAt,
    sourceCreatedAt: createdAt,
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
  const nextRecords = [];
  if (pendingTextPdf) {
    await putBlob(pendingTextPdf.id, pendingTextPdf.blob);
    nextRecords.push(fileRecordFromPending(pendingTextPdf, "generated pdf"));
    pendingTextPdf = null;
    if (noteInput) noteInput.value = "";
  }
  for (const file of pendingFiles) {
    const id = `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await putBlob(id, file);
    nextRecords.push({
      id,
      type: "file",
      name: file.name || "uploaded file",
      mime: file.type || "application/octet-stream",
      size: file.size || 0,
      createdAt: new Date().toISOString(),
      sourceCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : "",
      kind: file.type?.startsWith("image/") ? "image" : "file",
    });
  }
  pendingFiles = [];
  if (nextRecords.length) {
    state = [...nextRecords, ...state.filter((item) => !nextRecords.some((next) => next.id === item.id))];
    persistState();
  }
  renderPending();
  renderVault();
}

function fileRecordFromPending(file, kind) {
  return {
    id: file.id,
    type: "file",
    name: file.name,
    mime: file.mime,
    size: file.size,
    createdAt: file.createdAt,
    sourceCreatedAt: file.sourceCreatedAt,
    kind,
    pages: file.pages,
  };
}

function renderPending() {
  if (!pendingList) return;
  pendingList.replaceChildren();
  if (pendingTextPdf) {
    pendingList.append(
      chip(`${pendingTextPdf.name} · ${pendingTextPdf.pages} pages`),
      pendingAction("open generated pdf", () => openBlob(pendingTextPdf.blob, pendingTextPdf.name))
    );
  }
  pendingFiles.slice(0, 8).forEach((file) => {
    pendingList.append(chip(`${file.name || "file"} · ${formatBytes(file.size || 0)}`));
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
    empty.textContent = "No local files saved yet.";
    vaultList.append(empty);
    return;
  }
  for (const item of state) {
    vaultList.append(await createVaultItem(item));
  }
}

async function createVaultItem(item) {
  const row = document.createElement("article");
  row.className = "vault-item";

  const thumb = document.createElement("div");
  thumb.className = "vault-thumb";
  if (item.kind === "image") {
    const blob = await getBlob(item.id);
    if (blob) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(blob);
      openUrls.push(url);
      img.src = url;
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
  meta.textContent = [item.kind || "file", item.pages ? `${item.pages} pages` : "", formatBytes(item.size || 0), displayDate(item.createdAt)].filter(Boolean).join(" · ");
  main.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "vault-actions";
  actions.append(
    actionButton("open", async () => {
      const blob = await getBlob(item.id);
      if (blob) openBlob(blob, item.name);
    }),
    actionButton("download", async () => {
      const blob = await getBlob(item.id);
      if (blob) downloadBlob(blob, item.name);
    }),
    actionButton("delete", () => deleteRecord(item.id), "danger")
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

async function deleteRecord(id) {
  state = state.filter((item) => item.id !== id);
  persistState();
  await deleteBlob(id);
  renderVault();
}

function createTextPdf(text, title) {
  const width = 612;
  const height = 792;
  const margin = 54;
  const fontSize = 10.5;
  const leading = 15.5;
  const maxChars = 86;
  const bodyLines = wrapText(normalizeForPdf(text), maxChars);
  const lines = [title, "", ...bodyLines];
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
  pages.forEach((pageLines, index) => {
    const pageObj = objects.length + 1;
    const contentObj = objects.length + 2;
    kids.push(`${pageObj} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`);
    objects.push(streamForPage(pageLines, { margin, height, fontSize, leading, page: index + 1, pages: pages.length }));
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  const pdf = buildPdf(objects);
  return { blob: new Blob([pdf], { type: "application/pdf" }), pages: pages.length };
}

function streamForPage(lines, options) {
  const { margin, height, fontSize, leading, page, pages } = options;
  const commands = [
    "BT",
    `/F1 ${fontSize} Tf`,
    `${leading} TL`,
    `${margin} ${height - margin} Td`,
    ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`),
    `0 -${leading * 1.4} Td`,
    `(${escapePdfString(`${page} / ${pages}`)}) Tj`,
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
  text.split(/\n/).forEach((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      return;
    }
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
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    if (line) lines.push(line);
    lines.push("");
  });
  return lines;
}

function normalizeForPdf(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\n\t\x20-\x7E]/g, "?");
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
