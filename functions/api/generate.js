/* POST /api/generate — proxied to SenseNova /v1/images/{generations|edits}.
 * Auth is enforced by functions/api/_middleware.js.
 * Secrets: SENSENOVA_API_KEY, LOGIN_PASSWORD (Pages env vars).
 */

const UPSTREAM = "https://token.sensenova.ai/v1/images";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SENSENOVA_API_KEY) {
    return json({ error: { message: "Server is missing the SENSENOVA_API_KEY environment variable." } }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Request body must be JSON." } }, 400);
  }

  const mode = body.mode === "edit" ? "edit" : "generate";
  const payload = {
    model: String(body.model || ""),
    prompt: String(body.prompt || ""),
    size: body.size || "auto",
    n: 1,
    output_format: ["png", "jpeg", "webp"].includes(body.output_format) ? body.output_format : "png",
    response_format: "b64_json", // never hand out expiring CDN URLs to the browser
    watermark: body.watermark === true,
    prompt_extend: body.prompt_extend !== false,
  };

  if (!payload.model) return json({ error: { message: "model is required." } }, 400);
  if (!payload.prompt.trim()) return json({ error: { message: "prompt is required." } }, 400);

  if (mode === "edit") {
    if (!Array.isArray(body.images) || !body.images.length) {
      return json({ error: { message: "Edit mode requires at least one image." } }, 400);
    }
    payload.images = [];
    for (const [i, item] of body.images.entries()) {
      const url = item?.image_url;
      if (typeof url !== "string" || !/^(https:|data:image\/)/.test(url)) {
        return json({ error: { message: `images[${i}].image_url must be an https URL or a data:image/*;base64 URI.` } }, 400);
      }
      payload.images.push({ image_url: url });
    }
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/${mode === "edit" ? "edits" : "generations"}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SENSENOVA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ error: { message: `Could not reach SenseNova: ${err.message}` } }, 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    let message = `SenseNova returned HTTP ${upstream.status}.`;
    try {
      message = JSON.parse(text)?.error?.message || message;
    } catch { /* non-JSON error body */ }
    return json({ error: { message, code: upstream.status } }, upstream.status === 429 ? 429 : 502);
  }

  try {
    return json(JSON.parse(text));
  } catch {
    return json({ error: { message: "SenseNova returned a non-JSON response." } }, 502);
  }
}
