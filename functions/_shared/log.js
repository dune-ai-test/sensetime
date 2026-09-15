/* Shared event log for Cloudflare KV (binding: LOGS). Optional — silently
 * skipped when unbound. Keys use the "log-" prefix the /logs page lists. */

export async function log(env, chatId, event, detail = "") {
  if (!env.LOGS) return;
  try {
    const key = `log-${String(Date.now()).padStart(14, "0")}-${Math.random().toString(36).slice(2, 8)}`;
    await env.LOGS.put(
      key,
      JSON.stringify({ t: Date.now(), chatId, event, detail: String(detail).slice(0, 400) }),
      { expirationTtl: 7 * 24 * 3600 },
    );
  } catch { /* logging must never break a request */ }
}
