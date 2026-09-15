/* GET /logs — bot event log viewer (stored in the LOGS KV namespace).
 * Access: the site's session cookie (sign in with your password), OR
 * ?key=<TELEGRAM_WEBHOOK_SECRET> as a fallback.
 *   /logs          list (auto-refresh every 5 s)
 *   /logs?clear=1  wipe all entries
 */

import { isAuthenticated } from "./_shared/auth.js";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PAGE = (rows, key) => `<!doctype html><html><head><meta charset="utf-8"><title>Nova · bot log</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0a0a0c; color:#eeeef0; font:13px/1.5 ui-monospace,Consolas,monospace; margin:24px; }
  h1 { font:600 16px/1.4 system-ui; margin:0 0 4px; }
  .bar { display:flex; gap:14px; align-items:center; margin:8px 0 18px; color:#6b6b75; font-family:system-ui; }
  a { color:#818cf8; text-decoration:none; }
  table { border-collapse:collapse; width:100%; }
  td { padding:4px 10px 4px 0; border-bottom:1px solid #1d1d23; vertical-align:top; }
  td.t { white-space:nowrap; color:#6b6b75; }
  .e { padding:1px 7px; border-radius:6px; border:1px solid #26262c; background:#16161b; white-space:nowrap; }
  .e.job,.e.sent,.e.web\\:sent { border-color:#1e4d38; color:#34d399; }
  .e.deny,.e.deny\\:nolist,.e.upstream-err,.e.fail,.e.crash,.e.err\\:noapikey,.e.web\\:err,.e.web\\:fail { border-color:#5a2330; color:#f87171; }
  .e.cb,.e.msg,.e.web\\:send { color:#a1a1aa; }
  .d { color:#c9c9d1; word-break:break-word; }
  .note { font-family:system-ui; color:#fbbf24; margin-bottom:12px; }
</style></head><body>
<h1>Nova · Telegram bot log</h1>
<div class="bar"><span>auto-refresh 5 s</span><a href="/logs?clear=1${key ? `&key=${encodeURIComponent(key)}` : ""}">clear all</a><a href="/">back to studio</a></div>
${rows || '<div style="color:#6b6b75;font-family:system-ui">No entries yet — send the bot a message (try /id first).</div>'}
</body></html>`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.LOGS) {
    return html("KV not bound — create a namespace and bind it as LOGS (see README, Telegram bot section).", 501);
  }

  const key = url.searchParams.get("key") || "";
  const bySecret = Boolean(env.TELEGRAM_WEBHOOK_SECRET) && key === env.TELEGRAM_WEBHOOK_SECRET;
  const byCookie = Boolean(env.LOGIN_PASSWORD) && (await isAuthenticated(request, env));
  if (!bySecret && !byCookie) {
    return html("401 — sign in on the site first (same browser), or open /logs?key=&lt;TELEGRAM_WEBHOOK_SECRET&gt;.", 401);
  }

  if (url.searchParams.get("clear") === "1") {
    let cursor;
    do {
      const list = await env.LOGS.list({ prefix: "log-", limit: 1000, cursor });
      if (list.keys.length) await env.LOGS.delete(list.keys.map((k) => k.name));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return Response.redirect(url.origin + "/logs" + (key ? `?key=${encodeURIComponent(key)}` : ""), 302);
  }

  const list = await env.LOGS.list({ prefix: "log-", limit: 150, reverse: true });
  const rows = [];
  for (const k of list.keys) {
    const raw = await env.LOGS.get(k.name);
    if (!raw) continue;
    try {
      const e = JSON.parse(raw);
      rows.push(
        `<tr><td class="t">${esc(new Date(e.t).toLocaleTimeString())}</td>` +
        `<td><span class="e ${esc(e.event)}">${esc(e.event)}</span></td>` +
        `<td class="t">${esc(e.chatId)}</td>` +
        `<td class="d">${esc(e.detail)}</td></tr>`,
      );
    } catch { /* skip malformed entry */ }
  }
  return html(PAGE(rows.length ? `<table>${rows.join("")}</table>` : "", key));
}

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
