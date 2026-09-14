/* Nova Studio Telegram bot — POST /tg (webhook receiver)
 *
 * Lives in the SAME Pages project as the website, so it reuses
 * SENSENOVA_API_KEY. Not under /api/, so the site's cookie middleware
 * does not apply — Telegram authenticates with a secret header instead.
 *
 * Env vars:
 *   SENSENOVA_API_KEY         (shared with the site)
 *   TELEGRAM_BOT_TOKEN        from @BotFather
 *   TELEGRAM_ALLOWED_IDS      comma-separated numeric Telegram user IDs
 *   TELEGRAM_WEBHOOK_SECRET   any long random string, sent by Telegram as a header
 */

const UPSTREAM = "https://token.sensenova.ai/v1/images";

const MODELS = {
  "sensenova-u1.5-lite": { short: "lite", name: "U1.5 Lite", note: "generation + editing" },
  "sensenova-u1-fast": { short: "fast", name: "U1 Fast", note: "infographics, gen only" },
};

const SIZE_RULES = {
  "sensenova-u1.5-lite": {
    presets: ["auto", "2048x2048", "1024x1024", "2720x1536", "1536x2720", "1664x2496", "4096x4096"],
    check: (w, h) => w % 32 === 0 && h % 32 === 0 && w >= 512 && h <= 4096 && h >= 512 && w <= 4096 && w / h <= 3 && h / w <= 3,
  },
  "sensenova-u1-fast": {
    presets: ["auto", "2048x2048", "2752x1536", "3072x1376"],
    check: null, // fast only accepts its fixed constants
  },
};

const DEFAULTS = () => ({
  model: "sensenova-u1.5-lite",
  size: "auto",
  output_format: "png",
  watermark: false,
  prompt_extend: true,
});

/* Per-chat settings. Pages Functions are stateless between isolates, so this
 * memory survives only while an isolate lives (~minutes of traffic); after a
 * reset, defaults apply. [tags] in a message ALWAYS override — most reliable. */
const TTL_MS = 1000 * 60 * 60 * 6;
const CHATS = new Map();

function settingsFor(chatId) {
  const hit = CHATS.get(chatId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit;
  const fresh = { ...DEFAULTS(), ts: Date.now() };
  CHATS.set(chatId, fresh);
  return fresh;
}

function applySetting(chatId, key, value) {
  const s = settingsFor(chatId);
  if (key === "model") {
    s.model = value === "fast" ? "sensenova-u1-fast" : "sensenova-u1.5-lite";
    // keep size legal for the new model
    if (!SIZE_RULES[s.model].presets.includes(s.size)) {
      const parts = (s.size || "auto").split("x").map(Number);
      const ok = SIZE_RULES[s.model].check && parts.length === 2 && SIZE_RULES[s.model].check(parts[0], parts[1]);
      if (!ok) s.size = "auto";
    }
  } else if (key === "size") {
    s.size = value;
  } else if (key === "format") {
    s.output_format = value;
  } else if (key === "watermark" || key === "extend") {
    s[key === "extend" ? "prompt_extend" : "watermark"] = !s[key === "extend" ? "prompt_extend" : "watermark"];
  }
  s.ts = Date.now();
  return s;
}

const HELP = `Nova Studio — SenseNova image bot

Send any text and you get an image back.

Commands (each opens a button menu):
  /model   choose model
  /size    choose size (or /size 2720x1536)
  /format  PNG or JPEG
  /options watermark · prompt rewriting
  /settings show current setup
  /reset   back to defaults
  /id      your numeric id

Per-message tags (always work, even after a bot restart):
  [fast] [lite] [auto] [2048x2048] [jpeg] [png]
  [watermark] [noextend]
e.g.  [fast][2752x1536] neon Tokyo street in the rain

Edit a photo: reply to any photo with an instruction, e.g. "make it snow".`;

/* ---------- entry ---------- */

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  const secret = env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!secret) return new Response("TELEGRAM_WEBHOOK_SECRET is not configured", { status: 500 });
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad json");
  }

  // Telegram times out webhooks at ~60s; acknowledge now, work in background.
  waitUntil(handleUpdate(update, env).catch((err) => console.error("bot:", err)));
  return new Response("ok");
}

/* ---------- routing ---------- */

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message || update.channel_post;
  if (!msg?.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? 0;
  const text = (msg.text || "").trim();

  if (/^\/(start|help)/.test(text)) return send(env, chatId, HELP);
  if (text.startsWith("/id")) return send(env, chatId, `Your Telegram id: ${userId}\n(chat id: ${chatId})`);

  const allowed = (env.TELEGRAM_ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) {
    return send(env, chatId, `The bot has no allowlist configured yet. Your id is ${userId} — set TELEGRAM_ALLOWED_IDS in Cloudflare to unlock generation.`);
  }
  if (!allowed.includes(String(userId))) {
    return send(env, chatId, `Not authorized. Your id (${userId}) is not in the allowlist.`);
  }
  if (!env.SENSENOVA_API_KEY) return send(env, chatId, "Server is missing SENSENOVA_API_KEY.");

  if (text.startsWith("/")) return handleCommand(env, chatId, text);

  const { tokens, rest } = parseTags(text);
  const replyPhoto = msg.reply_to_message?.photo;

  if (replyPhoto?.length) {
    await editPhoto(env, chatId, replyPhoto, rest || "improve this image", tokens);
  } else if (rest) {
    await generate(env, chatId, rest, tokens);
  } else {
    await send(env, chatId, "Send a prompt (see /start for options).");
  }
}

async function handleCommand(env, chatId, text) {
  const [cmd, arg = ""] = text.split(/\s+/);
  const s = settingsFor(chatId);
  switch (cmd.split("@")[0]) {
    case "/model":
      return send(env, chatId, menuText("model", s), keyboard("model", s));
    case "/size":
      if (arg && /^(\d{3,4})x(\d{3,4})$/i.test(arg)) {
        const size = arg.toLowerCase();
        const r = SIZE_RULES[s.model];
        const valid = r.presets.includes(size) || (r.check && r.check(...size.split("x").map(Number)));
        if (!valid) return send(env, chatId, `⚠️ ${size} is not valid for ${MODELS[s.model].name}.`);
        applySetting(chatId, "size", size);
        return send(env, chatId, `Size set to ${size}.`);
      }
      return send(env, chatId, menuText("size", s), keyboard("size", s));
    case "/format":
      return send(env, chatId, menuText("format", s), keyboard("format", s));
    case "/options":
      return send(env, chatId, menuText("opt", s), keyboard("opt", s));
    case "/settings":
      return send(env, chatId, settingsLine(s));
    case "/reset":
      CHATS.set(chatId, { ...DEFAULTS(), ts: Date.now() });
      return send(env, chatId, "Defaults restored (lite · auto · png · no watermark · rewrite on).");
    default:
      return send(env, chatId, "Unknown command. Try /start");
  }
}

/* ---------- inline keyboards ---------- */

async function handleCallback(cb, env) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id ?? 0;
  const answer = (text, showAlert) => tgJson(env, "answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: !!showAlert } : {}) });

  if (!chatId) return answer();
  const allowed = (env.TELEGRAM_ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(String(userId))) return answer("Not authorized", true);

  const data = cb.data || "";
  const [kind, key, value] = data.split(":");
  const s = settingsFor(chatId);

  if (kind === "menu") return editMenu(env, cb, key || "model", s), answer();
  if (kind === "set") applySetting(chatId, key, value);
  else if (kind === "toggle") applySetting(chatId, key, null);
  else if (kind === "reset") CHATS.set(chatId, { ...DEFAULTS(), ts: Date.now() });
  else return answer();

  const menu = kind === "reset" ? "opt" : settingMenu(key);
  const cur = kind === "reset" ? settingsFor(chatId) : s;
  await Promise.all([
    editMenu(env, cb, menu, cur),
    answer(kind === "toggle" ? `${settingLabel(key)}: ${settingValue(cur, key)}` : settingValue(cur, key)),
  ]);
}

const settingMenu = (key) => ({ model: "model", size: "size", format: "format", watermark: "opt", extend: "opt" }[key] || "model");

async function editMenu(env, cb, menu, s) {
  await tgJson(env, "editMessageText", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: menuText(menu, s),
    reply_markup: JSON.stringify(keyboard(menu, s)),
  });
}

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
  if (menu === "model") return `Model (editing always uses U1.5 Lite):\n${settingsSummary(s)}`;
  if (menu === "size") return `Size for ${MODELS[s.model].name}:\nAuto lets the model pick. For a one-off custom size, use /size WxH or [WxH] tags.`;
  if (menu === "format") return `Output format (WebP is available on the website only):\n${settingsSummary(s)}`;
  return `Options:\n${settingsSummary(s)}`;
}

const settingLabel = (key) => ({ model: "Model", size: "Size", format: "Format", watermark: "Watermark", extend: "Rewrite" }[key] || key);
function settingValue(s, key) {
  if (key === "model") return MODELS[s.model].name;
  if (key === "format") return s.output_format.toUpperCase();
  if (key === "watermark") return s.watermark ? "ON" : "OFF";
  if (key === "extend") return s.prompt_extend ? "ON" : "OFF";
  return s.size;
}
const settingsSummary = (s) =>
  `${settingLabel("model")}: ${settingValue(s, "model")}\n${settingLabel("size")}: ${settingValue(s, "size")}\n${settingLabel("format")}: ${settingValue(s, "format")}\n${settingLabel("watermark")}: ${settingValue(s, "watermark")} · ${settingLabel("extend")}: ${settingValue(s, "extend")}`;
const settingsLine = (s) => `Current settings:\n${settingsSummary(s)}\n\nNote: settings are kept in short-term memory and may reset — [tags] always work.`;

/* ---------- generation & editing ---------- */

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

/* Merge: stored defaults < [tags]. */
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
      const sizeMatch = t.match(/^(\d{3,4})x(\d{3,4})$/);
      if (sizeMatch) s.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
      else note = `ignored unknown tag [${t}]`;
    }
  }
  if (isEdit) s.model = "sensenova-u1.5-lite"; // only u1.5 supports edits

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

async function generate(env, chatId, prompt, tokens) {
  const { s, note } = effectiveSettings(chatId, tokens, false);
  await runImageJob(env, chatId, {
    endpoint: "generations",
    label: `🎨 Generating (${MODELS[s.model].name} · ${s.size})${note ? " — ⚠️ " + note : ""}`,
    payload: { prompt, s },
  });
}

async function editPhoto(env, chatId, photoSizes, instruction, tokens) {
  const { s, note } = effectiveSettings(chatId, tokens, true);
  const file = photoSizes[photoSizes.length - 1]; // largest rendition
  const statusMsg = await send(env, chatId, "🖌️ Reading the photo…");
  let dataUrl;
  try {
    dataUrl = await downloadTelegramFile(env, file.file_id);
  } catch (err) {
    await edit(env, chatId, statusMsg, `Could not download that photo: ${err.message}`);
    return;
  }
  await deleteMessage(env, chatId, statusMsg);
  await runImageJob(env, chatId, {
    endpoint: "edits",
    label: `🖌️ Editing (${s.size})${note ? " — ⚠️ " + note : ""}`,
    payload: { prompt: instruction, s, images: [{ image_url: dataUrl }] },
  });
}

async function runImageJob(env, chatId, { endpoint, label, payload }) {
  const { prompt, s, images } = payload;
  const status = await send(env, chatId, label);
  const started = Date.now();
  try {
    const res = await fetch(`${UPSTREAM}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SENSENOVA_API_KEY}`, "Content-Type": "application/json" },
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
    });
    const bodyText = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = JSON.parse(bodyText)?.error?.message || message; } catch {}
      throw new Error(message);
    }
    const item = JSON.parse(bodyText)?.data?.[0];
    if (!item?.b64_json) throw new Error("The API returned no image data.");

    const mime = `image/${s.output_format}`;
    const bytes = base64ToBytes(item.b64_json);
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const tags = [
      `[${s.model === "sensenova-u1-fast" ? "fast" : "lite"}]`,
      `[${s.size}]`,
      `[${s.output_format}]`,
      s.watermark ? "[watermark]" : "",
      s.prompt_extend ? "" : "[noextend]",
      images ? "[edit]" : "",
    ].join("");
    const caption = `${clip(prompt, 700)}\n${tags} ${MODELS[s.model].name} · ${secs}s`;
    await sendImage(env, chatId, bytes, mime, caption);
    await deleteMessage(env, chatId, status);
  } catch (err) {
    await edit(env, chatId, status, `❌ ${err.message}`);
  }
}

/* ---------- SenseNova / Telegram helpers ---------- */

/* Returns "data:image/jpeg;base64,..." for a Telegram photo file_id. */
async function downloadTelegramFile(env, fileId) {
  const meta = await tgJson(env, "getFile", { file_id: fileId });
  if (!meta.ok) throw new Error(meta.description || "getFile failed");
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`);
  if (!res.ok) throw new Error(`photo download failed (${res.status})`);
  const mime = res.headers.get("Content-Type") || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

const send = (env, chatId, text, replyMarkup) =>
  tgJson(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}),
  }).then((r) => r.result?.message_id);

const edit = (env, chatId, messageId, text) =>
  tgJson(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });

const deleteMessage = (env, chatId, messageId) =>
  messageId ? tgJson(env, "deleteMessage", { chat_id: chatId, message_id: messageId }) : Promise.resolve();

async function sendImage(env, chatId, bytes, mime, caption) {
  // Telegram: photos cap at 5 MB upload; documents allow 20 MB.
  const asFile = bytes.byteLength > 4_500_000;
  const method = asFile ? "sendDocument" : "sendPhoto";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", clip(caption, 1000));
  const ext = mime.split("/")[1];
  form.append(asFile ? "document" : "photo", new File([bytes], `nova.${ext}`, { type: mime }));
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendImage failed: ${data.description || res.status}`);
  return data.result;
}

async function tgJson(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false, description: `Telegram ${method}: HTTP ${res.status}` }));
}

/* ---------- misc utils ---------- */

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
