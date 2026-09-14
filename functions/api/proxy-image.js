/* GET /api/proxy-image?url=<cdn url> — streams an expiring SenseNova CDN
 * image through our origin (used only as a fallback; normal responses are
 * b64_json). Auth is enforced by functions/api/_middleware.js.
 */

const deny = (message, status = 400) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url).searchParams.get("url");

  if (!url) return deny("Missing ?url=");
  let target;
  try {
    target = new URL(url);
  } catch {
    return deny("Invalid URL.");
  }
  // Only allow SenseNova's own CDN hosts; never act as an open proxy.
  if (!/(^|\.)sensenova\.(ai|dev|cn)$/.test(target.hostname)) {
    return deny("Only sensenova CDN URLs are allowed.");
  }

  try {
    const upstream = await fetch(target.toString(), { cf: { cacheTtl: 60 } });
    if (!upstream.ok) return deny(`Upstream returned ${upstream.status}.`, 502);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "image/png",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    return deny(`Fetch failed: ${err.message}`, 502);
  }
}
