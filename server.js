const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 3000);
const publicDir = __dirname;
const storageRoot = path.resolve(process.env.BRAIN_STORAGE_DIR || path.join(os.homedir(), "Documents", "brain-pdf-bank"));
const indexPath = path.join(storageRoot, ".brain-files.json");
const maxUploadBytes = Number(process.env.BRAIN_MAX_UPLOAD_MB || 100) * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxUploadBytes * 1.4) throw Object.assign(new Error("Upload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw Object.assign(new Error("Invalid file payload"), { status: 400 });
  const mime = match[1] || "application/octet-stream";
  const encoded = match[3] || "";
  const data = match[2] ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8");
  return { mime, data };
}

function sanitizeFileName(name) {
  const cleaned = String(name || "brain-file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "brain-file";
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath, "utf8"));
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

async function writeIndex(files) {
  await fsp.mkdir(storageRoot, { recursive: true });
  await fsp.writeFile(indexPath, JSON.stringify({ files }, null, 2));
}

async function saveUploadedFile(payload) {
  const decoded = dataUrlToBuffer(payload.dataUrl);
  if (decoded.data.length > maxUploadBytes) throw Object.assign(new Error("Upload too large"), { status: 413 });
  const preview = payload.previewDataUrl ? dataUrlToBuffer(payload.previewDataUrl) : null;
  if (preview && !String(preview.mime || "").startsWith("image/")) throw Object.assign(new Error("Invalid preview payload"), { status: 400 });

  const id = crypto.randomUUID();
  const name = sanitizeFileName(payload.name);
  const storageName = `${id}-${name}`;
  const filePath = path.join(storageRoot, storageName);
  await fsp.mkdir(storageRoot, { recursive: true });
  await fsp.writeFile(filePath, decoded.data);
  let previewStorageName = "";
  let previewMime = "";
  if (preview) {
    previewStorageName = `${id}-preview.png`;
    previewMime = preview.mime || "image/png";
    await fsp.writeFile(path.join(storageRoot, previewStorageName), preview.data);
  }

  const requestedCreatedAt = payload.createdAt ? new Date(payload.createdAt) : null;
  const now = requestedCreatedAt && !Number.isNaN(requestedCreatedAt.getTime()) ? requestedCreatedAt.toISOString() : new Date().toISOString();
  const entry = {
    id,
    name,
    mime: payload.mime || decoded.mime || "application/octet-stream",
    size: decoded.data.length,
    createdAt: now,
    sourceCreatedAt: payload.sourceCreatedAt || "",
    kind: payload.kind || "file",
    pages: Number(payload.pages || 0),
    autismScore: clampScore(payload.autismScore),
    autismScoreExplanation: cleanExplanation(payload.autismScoreExplanation),
    storageName,
    previewStorageName,
    previewMime,
  };
  const files = await readIndex();
  files.unshift(entry);
  await writeIndex(files);
  return entry;
}

function publicEntry(entry) {
  const { storageName, previewStorageName, previewMime, ...rest } = entry;
  return { ...rest, hasPreview: Boolean(previewStorageName), previewMime: previewMime || "" };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cleanExplanation(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function findEntry(id) {
  const files = await readIndex();
  return { files, entry: files.find((file) => file.id === id) };
}

async function serveStoredFile(req, res, requestUrl, id, mode) {
  const { entry } = await findEntry(id);
  if (!entry) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const isPreview = mode === "preview";
  const filePath = path.resolve(storageRoot, isPreview ? entry.previewStorageName || "" : entry.storageName || "");
  if (!isInside(storageRoot, filePath)) {
    sendJson(res, 403, { error: "Invalid file path" });
    return;
  }
  const disposition = mode === "download" ? "attachment" : "inline";
  res.writeHead(200, {
    "Content-Type": isPreview ? entry.previewMime || "image/png" : entry.mime || "application/octet-stream",
    "Content-Disposition": `${disposition}; filename="${encodeURIComponent(entry.name)}"`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function deleteStoredFile(req, res, id) {
  const { files, entry } = await findEntry(id);
  if (!entry) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const filePath = path.resolve(storageRoot, entry.storageName || "");
  if (isInside(storageRoot, filePath)) await fsp.rm(filePath, { force: true });
  const previewPath = path.resolve(storageRoot, entry.previewStorageName || "");
  if (entry.previewStorageName && isInside(storageRoot, previewPath)) await fsp.rm(previewPath, { force: true });
  await writeIndex(files.filter((file) => file.id !== id));
  sendJson(res, 200, { ok: true });
}

function sendStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const blockedNames = new Set(["server.js", "package.json", "railway.json"]);
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith(".")) || blockedNames.has(parts[parts.length - 1])) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(cleanPath)}`);
  if (!isInside(publicDir, filePath)) {
    sendJson(res, 403, { error: "Invalid path" });
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, app: "brain", storage: storageRoot });
      return;
    }

    if (requestUrl.pathname === "/api/files" && req.method === "GET") {
      const files = (await readIndex()).map(publicEntry);
      sendJson(res, 200, { files });
      return;
    }

    if (requestUrl.pathname === "/api/files" && req.method === "POST") {
      const entry = await saveUploadedFile(await readJson(req));
      sendJson(res, 200, { file: publicEntry(entry) });
      return;
    }

    const serveMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)\/(view|download|preview)$/);
    if (serveMatch && req.method === "GET") {
      await serveStoredFile(req, res, requestUrl, serveMatch[1], serveMatch[2]);
      return;
    }

    const deleteMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      await deleteStoredFile(req, res, deleteMatch[1]);
      return;
    }

    sendStatic(req, res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(port, () => {
  console.log(`brain listening on ${port}`);
});
