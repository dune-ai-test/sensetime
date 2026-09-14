/* Nova Images — single-server build for Render (Web Service).
 * Serves the static frontend AND mirrors the Cloudflare Pages Functions:
 *   POST /api/generate      -> SenseNova /v1/images/{generations|edits}
 *   GET  /api/proxy-image   -> safe passthrough of sensenova CDN images
 * Reads SENSENOVA_API_KEY from the environment. Zero npm dependencies:
 * Node's built-in fetch/http only, so `npm install` never breaks.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "..", "public"); // static frontend, shared with Cloudflare
const UPSTREAM = "https://token.sensenova.ai/v1/images";
const PORT = process.env.PORT || 8787;
const KEY = process.env.SENSENOVA_API_KEY || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
};

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
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: { message: `Fetch failed: ${e.message}` } });
  }
}

async function serveStatic(res, pathname) {
  let file = pathname === "/" ? "/index.html" : pathname;
  // Resolve inside PUBLIC_DIR only; reject anything that tries to escape.
  const abs = normalize(join(PUBLIC_DIR, file));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error("dir");
    const data = await readFile(abs);
    res.writeHead(200, { "Content-Type": MIME[extname(abs)] || "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA-ish fallback to index for unknown non-asset paths
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  if (url.pathname === "/api/generate" && req.method === "POST") return handleGenerate(req, res);
  if (url.pathname === "/api/proxy-image" && req.method === "GET") return handleProxyImage(req, res, url);
  if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: { message: "Unknown API route." } });
  return serveStatic(res, decodeURIComponent(url.pathname));
}).listen(PORT, () => console.log(`Nova Images on http://localhost:${PORT}`));
