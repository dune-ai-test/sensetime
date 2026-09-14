/* POST /login — verifies the shared password and sets the session cookie. */

import { sessionToken, cookieHeaders, json } from "./_shared/auth.js";

/* Best-effort brute-force damping: Pages isolates are short-lived and
 * per-region, so this is not a hard rate limit — a strong password is. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 25;
const attempts = new Map();

function ipOf(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function throttleHit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

/* Fixed-length compare so timing leaks nothing about the password. */
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.LOGIN_PASSWORD) {
    return json({ error: { message: "Server is missing the LOGIN_PASSWORD environment variable." } }, 500);
  }

  const ip = ipOf(request);
  if (throttleHit(ip)) {
    return json({ error: { message: "Too many failed attempts — try again in a few minutes." } }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Send JSON: {\"password\": \"...\"}" } }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password && equal(password, env.LOGIN_PASSWORD)) {
    attempts.delete(ip);
    const token = await sessionToken(env.LOGIN_PASSWORD);
    return json({ ok: true }, 200, cookieHeaders(token));
  }
  return json({ error: { message: "Incorrect password." } }, 401);
}
