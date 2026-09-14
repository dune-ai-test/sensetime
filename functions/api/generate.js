/* Cloudflare Pages Function: POST /api/generate
 * Proxies to the SenseNova image APIs server-side so the API key stays hidden.
 * Set SENSENOVA_API_KEY in Pages: Settings → Environment variables (and in
 * project secrets if running locally with `wrangler pages dev`).
 */

const UPSTREAM = "https://token.sensenova.ai/v1/images";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });

async function handlePost(request, env) {
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
    try {
      payload.images = body.images.map((item, i) => {
        const url = item?.image_url;
        if (typeof url !== "string" || !/^(https:|data:image\/)/.test(url)) {
          throw new Error(`images[${i}].image_url must be an https URL or a data:image/*;base64 URI.`);
        }
        return { image_url: url };
      });
    } catch (err) {
      return json({ error: { message: err.message } }, 400);
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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (request.method !== "POST") {
    return json({ error: { message: "Use POST." } }, 405);
  }
  return handlePost(request, env);
}
