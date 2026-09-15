/* Shared session auth for all routes.
 * Single shared password, kept in the LOGIN_PASSWORD environment variable.
 * A valid session is a stateless HttpOnly cookie containing
 * HMAC-SHA256(key = LOGIN_PASSWORD, msg = "nova-session-v1").
 * Nothing is stored server-side; clearing the cookie logs out.
 */

export const SESSION_COOKIE = "nova_session";
const SESSION_MSG = "nova-session-v1";

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(password)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(SESSION_MSG)));
}

export function readSession(request) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return "";
}

/* Which password does this session cookie correspond to? The cookie is the
 * HMAC of the password itself, so each password maps to one token and the
 * role can be re-derived without storing anything. */
export async function sessionRole(request, env) {
  const given = readSession(request);
  if (!given) return null;
  if (env.LOGIN_PASSWORD && given === (await sessionToken(env.LOGIN_PASSWORD))) return "owner";
  if (env.DEMO_PASSWORD && given === (await sessionToken(env.DEMO_PASSWORD))) return "demo";
  return null;
}

export async function isAuthenticated(request, env) {
  return (await sessionRole(request, env)) !== null;
}

/* Set / clear the session cookie. */
export function cookieHeaders(token, { maxAge = 60 * 60 * 24 * 30 } = {}) {
  return {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  };
}

export const clearCookieHeaders = () => cookieHeaders("", { maxAge: 0 });

export const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });

/* Middleware guard used by every file under functions/api/. */
export async function requireAuthOrResponse(request, env) {
  if (!env.LOGIN_PASSWORD) {
    return json({ error: { message: "Server is missing the LOGIN_PASSWORD environment variable." } }, 500);
  }
  if (!(await isAuthenticated(request, env))) {
    return json({ error: { message: "Not signed in.", code: 401 } }, 401);
  }
  return null;
}
