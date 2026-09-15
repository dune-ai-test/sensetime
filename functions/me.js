/* GET /me — is the current visitor signed in, and as what role? */
import { sessionRole, json } from "./_shared/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const role = Boolean(env.LOGIN_PASSWORD) ? await sessionRole(request, env) : null;
  return json({ signedIn: role !== null, role });
}
