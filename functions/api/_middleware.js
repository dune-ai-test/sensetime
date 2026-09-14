/* Guards every route under /api/* (functions/api/**) with the session cookie. */
import { requireAuthOrResponse } from "../_shared/auth.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const deny = await requireAuthOrResponse(request, env);
  if (deny) return deny;
  return next();
}
