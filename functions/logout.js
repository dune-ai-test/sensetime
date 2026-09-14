/* POST /logout — clears the session cookie. */
import { clearCookieHeaders, json } from "./_shared/auth.js";

export async function onRequestPost() {
  return json({ ok: true }, 200, clearCookieHeaders());
}
