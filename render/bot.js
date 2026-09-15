/* Nova Studio — long-polling Telegram bot for Render (Web Service).
 *
 * Why long-poll instead of the Pages webhook: Telegram cuts webhook
 * connections at ~60 s and Cloudflare then kills the function mid-wait, so
 * jobs slower than that (4K, busy Lite) can never deliver via webhook.
 * A polling process has no deadline: get the job, take 3 minutes if needed,
 * push the photo whenever it's ready.
 *
 * Start:  node render/bot.js
 * Env:    TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS, SENSENOVA_API_KEY, PORT
 *
 * The HTTP server only exists to answer Render's keep-alive pings (free
 * tier sleeps without incoming requests) — the real work is the poll loop.
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const KEY = process.env.SENSENOVA_API_KEY || "";
const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 10000;
const UPSTREAM = "https://token.sensenova.ai/v1/images";
const OFFSET_FILE = new URL("./.offset.json", import.meta.url);

/* ---------- model/size knowledge (mirrors the web + webhook bot) ---------- */

const MODELS = {
  "sensenova-u1.5-lite": { short: "lite", name: "U1.5 Lite", note: "generation + editing" },
  "sensenova-u1-fast": { short: "fast", name: "U1 Fast", note: "infographics, gen only" },
};

const SIZE_RULES = {
  "sensenova-u1.5-lite": {
    presets: ["auto", "2048x2048", "1024x1024", "2720x1536", "1536x2720", "1664x2496", "4096x4096"],
    check: (w, h) => w % 32 === 0 && h % 32 === 0 && w >= 512 && h >= 512 && w <= 4096 && h <= 4096 && w / h <= 3 && h / w <= 3,
  },
  "sensenova-u1-fast": {
    presets: ["auto", "2048x2048", "2752x1536", "3072x1376"],
    check: null,
  },
};

const DEFAULTS = () => ({
  model: "sensenova-u1.5-lite",
  size: "auto",
  output_format: "png",
  watermark: false,
  prompt_extend: true,
});

/* Persistent for the life of the process — reliable unlike Pages isolates. */
const CHATS = new Map();
const settingsFor = (chatId) => {
  if (!CHATS.has(chatId)) CHATS.set(chatId, DEFAULTS());
  return CHATS.get(chatId);
};

const HELP = `Nova Studio — SenseNova image bot

Send any text and you get an image back — no time limits now, 4K included.

Commands (each opens a button menu):
  /model   choose model
  /size    choose size (or /size 2720x1536)
  /format  PNG or JPEG
  /options watermark · prompt rewriting
  /settings show current setup
  /reset   back to defaults
  /id      your numeric id

Per-message tags also work:
  [fast] [lite] [2048x2048] [jpeg] [png] [watermark] [noextend]
e.g.  [1664x2496] poster for a jazz night, art-deco style

Edit a photo: reply to any photo with an instruction, e.g. "make it snow".`;

/* ---------- Telegram API ---------- */

async function tg(method, payload, raw = false) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = raw ? res : await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!raw && !data.ok && method !== "answerCallbackQuery") console.warn(`tg ${method}: ${data.description}`);
  return data;
}

const send = (chatId, text, replyMarkup) =>
  tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}),
  }).then((r) => r.result?.message_id);

const editMsg = (chatId, messageId, text) =>
  tg("editMessageText", { chat_id: chatId, message_id: messageId, text });

const deleteMsg = (chatId, messageId) => messageId && tg("deleteMessage", { chat_id: chatId, message_id: messageId });

async function sendImage(chatId, bytes, mime, caption) {
  /* Always a document: consistent delivery, no 5 MB photo cap, original
   * bytes preserved (Telegram re-compresses sendPhoto uploads). */
  const method = "sendDocument";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", clip(caption, 1000));
  form.append("document", new Blob([bytes], { type: mime }), fileName(caption, mime.split("/")[1]));
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendImage failed: ${data.description || res.status}`);
  return data.result;
}

async function downloadTelegramFile(fileId) {
  const meta = await tg("getFile", { file_id: fileId });
  if (!meta.ok) throw new Error(meta.description || "getFile failed");
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${meta.result.file_path}`);
  if (!res.ok) throw new Error(`photo download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${res.headers.get("content-type") || "image/jpeg"};base64,${buf.toString("base64")}`;
}

/* ---------- update dispatch (mirrors functions/tg.js) ---------- */

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message || update.channel_post;
  if (!msg?.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? 0;
  const text = (msg.text || "").trim();

  if (/^\/(start|help)/.test(text)) return send(chatId, HELP);
  if (text.startsWith("/id")) return send(chatId, `Your Telegram id: ${userId}\n(chat id: ${chatId})`);

  if (!ALLOWED.length) return send(chatId, `No allowlist configured (TELEGRAM_ALLOWED_IDS). Your id is ${userId}.`);
  if (!ALLOWED.includes(String(userId))) return send(chatId, `Not authorized. Your id (${userId}) is not in the allowlist.`);
  if (!KEY) return send(chatId, "Server is missing SENSENOVA_API_KEY.");

  if (text.startsWith("/")) return handleCommand(chatId, text);

  const { tokens, rest } = parseTags(text);
  const replyPhoto = msg.reply_to_message?.photo;
  if (replyPhoto?.length) {
    await doEdit(chatId, replyPhoto, rest || "improve this image", tokens);
  } else if (rest) {
    await doGenerate(chatId, rest, tokens);
  } else {
    await send(chatId, "Send a prompt (see /start for options).");
  }
}

async function handleCommand(chatId, text) {
  const [cmd, arg = ""] = text.split(/\s+/);
  const s = settingsFor(chatId);
  switch (cmd.split("@")[0]) {
    case "/model":
      return send(chatId, menuText("model", s), keyboard("model", s));
    case "/size":
      if (arg) {
        const size = arg.toLowerCase();
        const r = SIZE_RULES[s.model];
        const m = size.match(/^(\d{3,4})x(\d{3,4})$/);
        const valid = r.presets.includes(size) || (m && r.check && r.check(+m[1], +m[2]));
        if (!valid) return send(chatId, `⚠️ ${size} is not valid for ${MODELS[s.model].name}.`);
        s.size = size;
        return send(chatId, `Size set to ${size}.`);
      }
      return send(chatId, menuText("size", s), keyboard("size", s));
    case "/format":
      return send(chatId, menuText("format", s), keyboard("format", s));
    case "/options":
      return send(chatId, menuText("opt", s), keyboard("opt", s));
    case "/settings":
      return send(chatId, `Current settings:\n${summary(s)}`);
    case "/reset":
      CHATS.set(chatId, DEFAULTS());
      return send(chatId, "Defaults restored (U1.5 Lite · auto · png · no watermark · rewrite on).");
    default:
      return send(chatId, "Unknown command. Try /start");
  }
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id ?? 0;
  const answer = (text) => tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}) });
  if (!chatId) return answer();
  if (!ALLOWED.includes(String(userId))) return answer("Not authorized");

  const [kind, key, value] = (cb.data || "").split(":");
  const s = settingsFor(chatId);
  if (kind === "menu") { await renderMenu(cb, key || "model", s); return answer(); }
  if (kind === "set") {
    if (key === "model") {
      s.model = value === "fast" ? "sensenova-u1-fast" : "sensenova-u1.5-lite";
      if (!SIZE_RULES[s.model].presets.includes(s.size)) s.size = "auto";
    } else if (key === "size") s.size = value;
    else if (key === "format") s.output_format = value;
  } else if (kind === "toggle") {
    if (key === "watermark") s.watermark = !s.watermark;
    if (key === "extend") s.prompt_extend = !s.prompt_extend;
  } else if (kind === "reset") {
    CHATS.set(chatId, DEFAULTS());
  } else return answer();

  const menu = { model: "model", size: "size", format: "format", watermark: "opt", extend: "opt" }[key] || "opt";
  await Promise.all([renderMenu(cb, menu, settingsFor(chatId)), answer(labelValue(settingsFor(chatId), key))]);
}

/* ---------- menus ---------- */

function keyboard(menu, s) {
  const on = (v) => (v ? "✓ " : "");
  const rows = [];
  if (menu === "model") {
    rows.push(Object.keys(MODELS).map((id) => ({
      text: `${on(s.model === id)}${MODELS[id].name} — ${MODELS[id].note}`,
      callback_data: `set:model:${MODELS[id].short}`,
    })));
  } else if (menu === "size") {
    for (let i = 0; i < SIZE_RULES[s.model].presets.length; i += 3) {
      rows.push(SIZE_RULES[s.model].presets.slice(i, i + 3).map((sz) => ({
        text: `${on(s.size === sz)}${sz === "auto" ? "Auto" : sz}`,
        callback_data: `set:size:${sz}`,
      })));
    }
  } else if (menu === "format") {
    rows.push(["png", "jpeg"].map((f) => ({
      text: `${on(s.output_format === f)}${f.toUpperCase()}`,
      callback_data: `set:format:${f}`,
    })));
  } else if (menu === "opt") {
    rows.push([
      { text: `${s.watermark ? "✅ Watermark ON" : "⬜ Watermark OFF"}`, callback_data: "toggle:watermark" },
      { text: `${s.prompt_extend ? "✅ Rewrite ON" : "⬜ Rewrite OFF"}`, callback_data: "toggle:extend" },
    ]);
    rows.push([{ text: "♻️ Reset all settings", callback_data: "reset:x" }]);
  }
  return { inline_keyboard: rows };
}

function menuText(menu, s) {
  if (menu === "model") return `Model (editing always uses U1.5 Lite):\n${summary(s)}`;
  if (menu === "size") return `Size for ${MODELS[s.model].name}:\nAuto lets the model pick. One-off: /size WxH`;
  if (menu === "format") return `Output format:\n${summary(s)}`;
  return `Options:\n${summary(s)}`;
}

async function renderMenu(cb, menu, s) {
  await tg("editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: menuText(menu, s),
    reply_markup: JSON.stringify(keyboard(menu, s)),
  });
}

const labelValue = (s, key) =>
  ({ model: `Model: ${MODELS[s.model].name}`, size: `Size: ${s.size}`, format: `Format: ${s.output_format.toUpperCase()}`, watermark: `Watermark: ${s.watermark ? "ON" : "OFF"}`, extend: `Rewrite: ${s.prompt_extend ? "ON" : "OFF"}` }[key] || "ok");

const summary = (s) =>
  `Model: ${MODELS[s.model].name}\nSize: ${s.size}\nFormat: ${s.output_format.toUpperCase()}\nWatermark: ${s.watermark ? "ON" : "OFF"} · Rewrite: ${s.prompt_extend ? "ON" : "OFF"}`;

/* ---------- generation ---------- */

function parseTags(text) {
  const tokens = [];
  let rest = text;
  let m;
  while ((m = rest.match(/^\[(\w+)\]\s*/i))) {
    tokens.push(m[1].toLowerCase());
    rest = rest.slice(m[0].length);
  }
  return { tokens, rest: rest.trim() };
}

function effectiveSettings(chatId, tokens, isEdit) {
  const s = { ...settingsFor(chatId) };
  let note = "";
  for (const t of tokens) {
    if (t === "fast" || t === "lite") s.model = t === "fast" ? "sensenova-u1-fast" : "sensenova-u1.5-lite";
    else if (t === "jpeg" || t === "jpg") s.output_format = "jpeg";
    else if (t === "png") s.output_format = "png";
    else if (t === "auto") s.size = "auto";
    else if (t === "watermark" || t === "wm") s.watermark = true;
    else if (t === "noextend") s.prompt_extend = false;
    else {
      const sm = t.match(/^(\d{3,4})x(\d{3,4})$/);
      if (sm) s.size = `${sm[1]}x${sm[2]}`;
      else note = `ignored unknown tag [${t}]`;
    }
  }
  if (isEdit) s.model = "sensenova-u1.5-lite";
  const rule = SIZE_RULES[s.model];
  if (s.size !== "auto" && !rule.presets.includes(s.size)) {
    const [w, h] = s.size.split("x").map(Number);
    if (!(rule.check && rule.check(w, h))) {
      note = `${note ? note + "; " : ""}[${s.size}] invalid for ${MODELS[s.model].name} — using auto`;
      s.size = "auto";
    }
  }
  return { s, note };
}

async function doGenerate(chatId, prompt, tokens) {
  const { s } = effectiveSettings(chatId, tokens, false);
  await runImageJob(chatId, "generations", `🎨 Generating (${MODELS[s.model].name} · ${s.size}) — big sizes can take a few minutes`, { prompt, s });
}

async function doEdit(chatId, photoSizes, instruction, tokens) {
  const { s } = effectiveSettings(chatId, tokens, true);
  const file = photoSizes[photoSizes.length - 1];
  const statusMsg = await send(chatId, "🖌️ Reading the photo…");
  let dataUrl;
  try {
    dataUrl = await downloadTelegramFile(file.file_id);
  } catch (err) {
    return editMsg(chatId, statusMsg, `Could not download that photo: ${err.message}`);
  }
  await deleteMsg(chatId, statusMsg);
  await runImageJob(chatId, "edits", `🖌️ Editing (${s.size})`, { prompt: instruction, s, images: [{ image_url: dataUrl }] });
}

async function runImageJob(chatId, endpoint, label, { prompt, s, images }) {
  const status = await send(chatId, label);
  const started = Date.now();
  try {
    const res = await fetch(`${UPSTREAM}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: s.model,
        prompt,
        size: s.size,
        n: 1,
        output_format: s.output_format,
        response_format: "b64_json",
        watermark: s.watermark,
        prompt_extend: s.prompt_extend,
        ...(images ? { images } : {}),
      }),
      // no AbortSignal: wait as long as SenseNova needs
    });
    const bodyText = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = JSON.parse(bodyText)?.error?.message || message; } catch {}
      throw new Error(message);
    }
    const item = JSON.parse(bodyText)?.data?.[0];
    if (!item?.b64_json) throw new Error("The API returned no image data.");
    const bytes = Buffer.from(item.b64_json, "base64"); // native, instant

    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const tags = [
      `[${s.model === "sensenova-u1-fast" ? "fast" : "lite"}]`,
      `[${s.size}]`,
      `[${s.output_format}]`,
      s.watermark ? "[watermark]" : "",
      s.prompt_extend ? "" : "[noextend]",
      images ? "[edit]" : "",
    ].join("");
    await sendImage(chatId, bytes, `image/${s.output_format}`, `${clip(prompt, 700)}\n${tags} ${MODELS[s.model].name} · ${secs}s`);
    await deleteMsg(chatId, status);
    console.log(`sent ${chatId} ${Math.round(bytes.byteLength / 1024)}KB ${secs}s ${s.size}`);
  } catch (err) {
    await editMsg(chatId, status, `❌ ${err.message}`).catch(() => {});
  }
}

/* ---------- long-poll loop ---------- */

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/* nova-prompt-slug-153012.png — meaningful document names. */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastOffset = 0;
try {
  lastOffset = (JSON.parse(await readFile(OFFSET_FILE, "utf8")).offset) || 0;
} catch { lastOffset = 0; }

async function saveOffset() {
  try { await writeFile(OFFSET_FILE, JSON.stringify({ offset: lastOffset })); } catch {}
}

async function pollLoop() {
  if (!TOKEN || !KEY) {
    console.error("bot.js: TELEGRAM_BOT_TOKEN and SENSENOVA_API_KEY are required");
    return;
  }
  console.log("Nova bot polling. Allowlist:", ALLOWED.length ? ALLOWED.join(",") : "(EMPTY — nobody can generate)");
  for (;;) {
    try {
      const res = await tg("getUpdates", { offset: lastOffset + 1, timeout: 50, allowed_updates: ["message", "callback_query"] });
      if (res.ok) {
        for (const update of res.result || []) {
          lastOffset = update.update_id;
          await saveOffset();
          handleUpdate(update).catch((err) => console.error("update error:", err)); // concurrent: don't block polling
        }
      } else if (/conflict/i.test(res.description || "")) {
        console.error("409 CONFLICT: a webhook is still set. Run deleteWebhook (see README) and redeploy/restart.");
        await sleep(30000);
      }
    } catch (err) {
      console.error("poll error:", err.message);
      await sleep(5000);
    }
  }
}

/* Render pings keep the service awake; /healthz doubles as a status page. */
createServer(async (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, uptime: process.uptime(), lastOffset, allowlist: ALLOWED.length }));
}).listen(PORT, () => console.log(`keepalive http on :${PORT}`));

pollLoop();
