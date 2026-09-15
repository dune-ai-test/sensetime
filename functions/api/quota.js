/* GET /api/quota — live budget figures for the header pill.
 * Auth is enforced by functions/api/_middleware.js. */

import { sessionRole } from "../_shared/auth.js";
import { usedGlobal, usedDemo, quotaCap, demoLimit, WINDOW_HOURS } from "../_shared/quota.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const role = await sessionRole(request, env);
  const used = await usedGlobal(env);
  const body = {
    role,
    used,
    cap: quotaCap(env),
    windowHours: WINDOW_HOURS,
  };
  if (role === "demo") body.demo = { used: await usedDemo(env), cap: demoLimit(env) };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
