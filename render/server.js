/* Nova Studio — single-server build for Render (Web Service).
 * Serves the static frontend AND mirrors the Cloudflare Pages routes:
 *   POST /login            -> verify shared password, set session cookie
 *   POST /logout           -> clear cookie
 *   GET  /me               -> { signedIn }
 *   POST /api/generate     -> SenseNova /v1/images/{generations|edits}  (auth required)
 *   GET  /api/proxy-image  -> safe passthrough of sensenova CDN images   (auth required)
 * Env: SENSENOVA_API_KEY, LOGIN_PASSWORD. Zero npm dependencies.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "..", "public");
const UPSTREAM = "https://token.sensenova.ai/v1/images";
const PORT = process.env.PORT || 8787;
const KEY = process.env.SENSENOVA_API_KEY || "";
const PASSWORD = process.env.LOGIN_PASSWORD || "";
const SESSION_COOKIE = "nova_session";

const hmac = (pwd) => createHmac("sha256", String(pwd)).update("nova-session-v1").digest("hex");

function sessionOk(req) {
  if (!PASSWORD) return false;
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const given = Buffer.from(part.slice(eq + 1).trim());
    const want = Buffer.from(hmac(PASSWORD));
    return given.length === want.length && timingSafeEqual(given, want);
  }
  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const sendJson = (res, status, obj, extraHeaders = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
};

const sessionCookie = (token, maxAge) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function handleLogin(req, res) {
  if (!PASSWORD) return sendJson(res, 500, { error: { message: "Server is missing the LOGIN_PASSWORD environment variable." } });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }
  const given = Buffer.from(String(body.password || ""));
  const want = Buffer.from(PASSWORD);
  if (given.length === want.length && timingSafeEqual(given, want)) {
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(hmac(PASSWORD), 60 * 60 * 24 * 30) });
  }
  return sendJson(res, 401, { error: { message: "Incorrect password." } });
}

const readJsonBody = (req) =>
  new Promise((fulfill, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 30_000_000) reject(new Error("Body too large.")); // base64 images get big
    });
    req.on("end", () => {
      try { fulfill(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Request body must be JSON.")); }
    });
    req.on("error", reject);
  });

async function handleGenerate(req, res) {
  if (!KEY) return sendJson(res, 500, { error: { message: "Server is missing the SENSENOVA_API_KEY environment variable." } });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }

  const mode = body.mode === "edit" ? "edit" : "generate";
  const payload = {
    model: String(body.model || ""),
    prompt: String(body.prompt || ""),
    size: body.size || "auto",
    n: 1,
    output_format: ["png", "jpeg", "webp"].includes(body.output_format) ? body.output_format : "png",
    response_format: "b64_json",
    watermark: body.watermark === true,
    prompt_extend: body.prompt_extend !== false,
  };

  if (!payload.model) return sendJson(res, 400, { error: { message: "model is required." } });
  if (!payload.prompt.trim()) return sendJson(res, 400, { error: { message: "prompt is required." } });

  if (mode === "edit") {
    if (!Array.isArray(body.images) || !body.images.length) {
      return sendJson(res, 400, { error: { message: "Edit mode requires at least one image." } });
    }
    payload.images = [];
    for (const [i, item] of body.images.entries()) {
      const url = item?.image_url;
      if (typeof url !== "string" || !/^(https:|data:image\/)/.test(url)) {
        return sendJson(res, 400, { error: { message: `images[${i}].image_url must be an https URL or a data:image/*;base64 URI.` } });
      }
      payload.images.push({ image_url: url });
    }
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/${mode === "edit" ? "edits" : "generations"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return sendJson(res, 502, { error: { message: `Could not reach SenseNova: ${e.message}` } });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    let message = `SenseNova returned HTTP ${upstream.status}.`;
    try { message = JSON.parse(text)?.error?.message || message; } catch {}
    return sendJson(res, upstream.status === 429 ? 429 : 502, { error: { message, code: upstream.status } });
  }
  try { sendJson(res, 200, JSON.parse(text)); }
  catch { sendJson(res, 502, { error: { message: "SenseNova returned a non-JSON response." } }); }
}

async function handleProxyImage(req, res, url) {
  const target = url.searchParams.get("url");
  if (!target) return sendJson(res, 400, { error: { message: "Missing ?url=" } });
  let parsed;
  try { parsed = new URL(target); }
  catch { return sendJson(res, 400, { error: { message: "Invalid URL." } }); }
  if (!/(^|\.)sensenova\.(ai|dev|cn)$/.test(parsed.hostname)) {
    return sendJson(res, 400, { error: { message: "Only sensenova CDN URLs are allowed." } });
  }
  try {
    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) return sendJson(res, 502, { error: { message: `Upstream returned ${upstream.status}.` } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "image/png",
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=60",
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: { message: `Fetch failed: ${e.message}` } });
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "/index.html" : pathname;
  const abs = normalize(join(PUBLIC_DIR, file));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error("dir");
    const data = await readFile(abs);
    res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (p === "/login" && req.method === "POST") return handleLogin(req, res);
  if (p === "/logout" && req.method === "POST") return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  if (p === "/me") return sendJson(res, 200, { signedIn: sessionOk(req) });

  if (p.startsWith("/api/")) {
    if (!sessionOk(req)) return sendJson(res, 401, { error: { message: "Not signed in.", code: 401 } });
    if (p === "/api/generate" && req.method === "POST") return handleGenerate(req, res);
    if (p === "/api/proxy-image" && req.method === "GET") return handleProxyImage(req, res, url);
    return sendJson(res, 404, { error: { message: "Unknown API route." } });
  }
  return serveStatic(res, decodeURIComponent(p));
}).listen(PORT, () => console.log(`Nova Studio on http://localhost:${PORT}`));
