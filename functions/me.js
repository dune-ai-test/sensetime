/* GET /me — is the current visitor signed in? */
import { isAuthenticated, json } from "./_shared/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const signedIn = Boolean(env.LOGIN_PASSWORD) && (await isAuthenticated(request, env.LOGIN_PASSWORD));
  return json({ signedIn });
}
