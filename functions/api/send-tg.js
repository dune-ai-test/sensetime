/* POST /api/send-tg — forward a generated image (as a data: URL) to the
 * owner's Telegram chat. Auth is enforced by functions/api/_middleware.js.
 *
 * Unlike the /tg webhook (which can't outlive Telegram's 60 s disconnect),
 * sending is a plain Bot API call taking seconds — the slow part already
 * happened in your browser. No webhook or long-poll needed for this route.
 *
 * Env: TELEGRAM_BOT_TOKEN (already set), TELEGRAM_CHAT_ID (your numeric id).
 */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ error: { message: "Server is missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID." } }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Request body must be JSON." } }, 400);
  }

  const dataUrl = String(body.dataUrl || "");
  const caption = String(body.caption || "").slice(0, 1000);
  const mimeMatch = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/);
  if (!mimeMatch || dataUrl.length > 30_000_000) {
    return json({ error: { message: "dataUrl must be a base64 image (≤ ~22 MB)." } }, 400);
  }

  // Native data-URL decode — CPU-cheap for multi-MB images.
  let bytes;
  try {
    bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  } catch {
    return json({ error: { message: "Could not decode the image." } }, 400);
  }

  const mime = mimeMatch[1];
  // Telegram: photos max 5 MB, documents 20 MB.
  const asFile = bytes.byteLength > 4_500_000;
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append(asFile ? "document" : "photo", new File([bytes], `nova.${mime.split("/")[1]}`, { type: mime }));

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${asFile ? "sendDocument" : "sendPhoto"}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    return json({ error: { message: `Telegram: ${data.description || `HTTP ${res.status}`}` } }, 502);
  }
  return json({ ok: true, via: asFile ? "document" : "photo", kb: Math.round(bytes.byteLength / 1024) });
}
