/* POST /api/send-tg — forward a generated image (as a data: URL) to the
 * owner's Telegram chat. Auth is enforced by functions/api/_middleware.js.
 *
 * Unlike the /tg webhook (which can't outlive Telegram's 60 s disconnect),
 * sending is a plain Bot API call taking seconds — the slow part already
 * happened in your browser. No webhook or long-poll needed for this route.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID; all outcomes recorded in /logs.
 */

import { log } from "../_shared/log.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/* nova-cozy-kitchen-scene-153012.png — prompt slug + UTC time, so Telegram
 * document cards read meaningfully instead of "nova.png" every time. */
function fileName(caption, ext) {
  const slug = String(caption || "")
    .split("\n")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/, "");
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return `nova-${slug || "image"}-${stamp}.${ext}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  /* No dedicated TELEGRAM_CHAT_ID needed: in DMs the chat id equals the user
   * id, so default to the first TELEGRAM_ALLOWED_IDS entry. Set
   * TELEGRAM_CHAT_ID explicitly for groups or a non-owner destination. */
  const chat = env.TELEGRAM_CHAT_ID
    || (env.TELEGRAM_ALLOWED_IDS || "").split(",")[0]?.trim()
    || "?";
  const started = Date.now();

  if (!env.TELEGRAM_BOT_TOKEN || chat === "?") {
    await log(env, chat, "web:err", "missing TELEGRAM_BOT_TOKEN, and no TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_IDS to fall back to");
    return json({ error: { message: "Server is missing TELEGRAM_BOT_TOKEN or a chat id (TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_IDS)." } }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    await log(env, chat, "web:err", "bad JSON body");
    return json({ error: { message: "Request body must be JSON." } }, 400);
  }

  const dataUrl = String(body.dataUrl || "");
  const caption = String(body.caption || "").slice(0, 1000);
  const mimeMatch = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/);
  if (!mimeMatch || dataUrl.length > 30_000_000) {
    await log(env, chat, "web:err", `invalid dataUrl (prefix: ${dataUrl.slice(0, 24) || "none"})`);
    return json({ error: { message: "dataUrl must be a base64 image (≤ ~22 MB)." } }, 400);
  }

  await log(env, chat, "web:send", `${mimeMatch[1]} ${Math.round(dataUrl.length / 1024)} KB b64 · “${caption.slice(0, 80)}”`);

  // Native data-URL decode — CPU-cheap for multi-MB images.
  let bytes;
  try {
    bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  } catch {
    await log(env, chat, "web:err", "decode failed");
    return json({ error: { message: "Could not decode the image." } }, 400);
  }

  const mime = mimeMatch[1];
  /* Always deliver as document: consistent in-chat appearance, no 5 MB
   * photo cap, and Telegram stores the original bytes untouched. */
  const asFile = true;
  const form = new FormData();
  form.append("chat_id", chat);
  form.append("caption", caption);
  form.append("document", new File([bytes], fileName(caption, mime.split("/")[1]), { type: mime }));

  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${asFile ? "sendDocument" : "sendPhoto"}`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    await log(env, chat, "web:fail", `network: ${err.message}`);
    return json({ error: { message: `Could not reach Telegram: ${err.message}` } }, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const description = data.description || `HTTP ${res.status}`;
    await log(env, chat, "web:fail", `Telegram refused (${asFile ? "document" : "photo"}): ${description}`);
    return json({ error: { message: `Telegram: ${description}` } }, 502);
  }

  await log(env, chat, "web:sent", `${asFile ? "document" : "photo"} · ${Math.round(bytes.byteLength / 1024)} KB · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return json({ ok: true, via: asFile ? "document" : "photo", kb: Math.round(bytes.byteLength / 1024) });
}
