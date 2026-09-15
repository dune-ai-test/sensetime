/* Rolling usage counters in the LOGS KV namespace, bucketed per UTC hour.
 * A 5-hour window = sum of the last 5 buckets (approximate at boundaries,
 * good enough for a budget banner and demo limits). Keys never collide with
 * the "log-" prefix used by the /logs page or "upd-" webhook dedupe.
 *
 * Env knobs: QUOTA_CAP (display cap for the SenseNova beta quota, default
 * 1500), DEMO_LIMIT (demo generations per window, default 30).
 */

export const WINDOW_HOURS = 5;

const pad = (n) => String(n).padStart(2, "0");
export const bucketOf = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;

function buckets(n = WINDOW_HOURS) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i += 1) out.push(bucketOf(new Date(now - i * 3600_000)));
  return out;
}

async function kvAdd(env, key) {
  if (!env.LOGS) return 0;
  try {
    const cur = parseInt((await env.LOGS.get(key)) || "0", 10) + 1;
    await env.LOGS.put(key, String(cur), { expirationTtl: 7 * 24 * 3600 });
    return cur;
  } catch {
    return 0;
  }
}

async function kvSum(env, keys) {
  if (!env.LOGS) return 0;
  const vals = await Promise.all(keys.map((k) => env.LOGS.get(k).catch(() => null)));
  return vals.reduce((a, v) => a + (parseInt(v || "0", 10) || 0), 0);
}

export const usedGlobal = (env) => kvSum(env, buckets().map((b) => `cnt-${b}`));
export const bumpGlobal = (env) => kvAdd(env, `cnt-${bucketOf(new Date())}`);
export const usedDemo = (env) => kvSum(env, buckets().map((b) => `use-${b}-demo`));
export const bumpDemo = (env) => kvAdd(env, `use-${bucketOf(new Date())}-demo`);

export const quotaCap = (env) => Number(env.QUOTA_CAP || 1500);
export const demoLimit = (env) => Number(env.DEMO_LIMIT || 30);
