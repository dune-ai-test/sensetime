# Nova Studio — SenseNova image generation site

A **password-protected** single-page web app for generating and editing images
through the [SenseNova](https://platform.sensenova.ai) API. The browser only
ever talks to **your** backend; the SenseNova API key never reaches the client.

**Nothing is stored server-side.** Functions are stateless relays — images
pass through and are kept only in the visitor's browser session (a reload
clears the gallery). Cloudflare never persists them.

```
app/
├── public/               # the single-page frontend (index.html + app.js)
│   ├── index.html
│   └── app.js
├── functions/            # Option A: Cloudflare Pages Functions (recommended)
│   ├── _shared/auth.js       # HMAC session cookie helpers
│   ├── login.js              # POST /login  (password -> session cookie)
│   ├── logout.js             # POST /logout
│   ├── me.js                 # GET  /me     (signed-in check)
│   └── api/
│       ├── _middleware.js    # requires the session cookie for all /api/*
│       ├── generate.js       # POST /api/generate
│       └── proxy-image.js    # GET  /api/proxy-image
├── render/               # Option B: one tiny Node server for Render
│   └── server.js         # same routes incl. auth, zero dependencies
└── package.json          # Option B only
```

## What it supports (from the SenseNova docs)

- **Text→Image** — `sensenova-u1.5-lite` (generation + editing) and
  `sensenova-u1-fast` (infographics, generation only).
- **Image editing** — upload one or more images (they're sent as
  `data:image/*;base64` URIs) plus an instruction prompt; U1.5 Lite only.
- Options exposed in the UI: size preset (auto/1024/2K/4K), output format
  (PNG/JPEG/WebP), `prompt_extend` (AI prompt rewriting), watermark.
- Responses always come back as `b64_json` so images don't expire; the
  expiring CDN URLs are never handed to the browser.
- Quota shown in docs: **1,500 requests / 5 hours** per model, free during
  public beta.

## Get an API key

1. Sign in at <https://platform.sensenova.ai>.
2. Open the Console → **API Keys** (`/console/keys`) and create a key
   (starts with `sk-`).
3. Keep it secret — it goes into the hosting platform's environment variables,
   never into the frontend code.

---

## Deploy — Option A: Cloudflare Pages (recommended)

1. Push the `app/` folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
   and pick the repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(empty)*
   - **Build output directory:** `public`
4. Save & deploy. Pages automatically picks up the `functions/` folder —
   no extra configuration.
5. **Settings → Environment variables → Add** (as **Secrets**, both variables, Production + Preview):
   - `SENSENOVA_API_KEY` = your `sk-...` key
   - `LOGIN_PASSWORD` = the password visitors must enter (pick something strong — it is the only gate)
6. Redeploy (or trigger a deploy) so the variable is live.

Local testing (optional): `npx wrangler pages dev .` with the key set, then
open <http://localhost:8788>.

## Deploy — Option B: Render (Web Service)

`render/server.js` serves the frontend **and** the same `/api/*` routes with
zero npm dependencies, so Render's free tier works fine.

1. Push the `app/` folder to a GitHub repo.
2. Render dashboard → **New → Web Service**, connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** *(empty — nothing to build)*
   - **Start command:** `node render/server.js`
   - **Environment variables:** `SENSENOVA_API_KEY` = your `sk-...` key and
     `LOGIN_PASSWORD` = your chosen access password
4. Deploy. Render reads `PORT` from its environment automatically.

> Note: Render's free tier sleeps after 15 min of inactivity, so the first
> request after a gap can take ~30 s. Cloudflare Pages/Functions has no such
> cold-start problem. That's the main reason to prefer Option A.

---

## Telegram bot (same project, route `/tg`)

`functions/tg.js` adds a Telegram front-end to the *same* Pages deploy — it
reuses `SENSENOVA_API_KEY` and needs no extra hosting. Send text → get an
image; reply to a photo with an instruction → get an edited image.
Settings live behind commands with inline buttons: `/model`, `/size`,
`/format`, `/options` (watermark / rewriting toggles), `/settings`, `/reset`.
Settings are kept in the Worker's short-term memory and can reset — the
per-message tags `[fast] [2048x2048] [jpeg] [watermark] [noextend]` always
work regardless.

1. **Create the bot:** message [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the token.
2. **Add two more Secrets** in Pages Settings → Environment variables:
   - `TELEGRAM_BOT_TOKEN` = the token from BotFather
   - `TELEGRAM_WEBHOOK_SECRET` = any long random string, e.g. from
     <https://randomkeygen.com>
   - `TELEGRAM_ALLOWED_IDS` = leave empty for the first run (see step 5)
3. **Retry the deployment** so both variables are live.
4. **Register the webhook** — open this in a browser (GET works the same):
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.pages.dev/tg&secret_token=<SECRET>
   ```
   Expect `{"ok":true,"result":true,...}`. Re-run it anytime to change the URL.
   To remove: `.../deleteWebhook`.
5. **Set your allowlist:** DM the bot `/id` — it answers your numeric id even
   while no allowlist is set. Put it into `TELEGRAM_ALLOWED_IDS`
   (comma-separated for friends), retry the deployment, then `/start` and
   generate.
6. Optional: BotFather → `/setdescription` and `/setcommands`:
   ```
   start - help
   model - choose model
   size - choose size
   format - png or jpeg
   options - watermark and rewriting
   settings - show current setup
   reset - restore defaults
   id - show my telegram id
   ```

### Recommended: run the bot on Render with long-polling (`render/bot.js`)

**Why:** Telegram closes webhook connections after ~60 s and Cloudflare then
kills the Pages function mid-wait — so any generation longer than ~55 s
(4K, or Lite when busy) can never deliver through the `/tg` webhook.
A long-polling process has no deadline: it waits as long as SenseNova needs
and pushes the photo whenever it's ready. Bonus: per-chat settings
(`/size`, `/model` buttons) become fully reliable, because the process is
persistent instead of random Cloudflare isolates.

1. **Remove the webhook first** (long-poll and webhook conflict):
   `https://api.telegram.org/bot<TOKEN>/deleteWebhook`
2. **Render → New → Web Service**, connect `dune-ai-test/sensetime`:
   - Runtime: Node · Build command: *(empty)* · Start command: `node render/bot.js`
   - Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_IDS`, `SENSENOVA_API_KEY`
3. **Keep it awake** (Render free tier sleeps 15 min after the last incoming
   request; an up-poll loop produces none). Create a free
   [UptimeRobot](https://uptimerobot.com) HTTP monitor hitting
   `https://<your-service>.onrender.com/` every 5 minutes. With ~24/7 uptime
   the service uses ≈744 of Render's 750 free hours/month — fine for one
   service; anything more costs the paid tier.
4. **Same feature set as the webhook bot**: text→image, reply-photo→edit,
   `/model` `/size` `/format` `/options` `/settings` `/reset` `/id`,
   `[tags]` overrides, photo-vs-document upload switch, big green/❌ status.

The Cloudflare `/tg` webhook route stays in the repo — it's a harmless
fallback if Render is ever down (webhook re-register to switch back), but
only one of the two can be active at a time.

### Send a website image to Telegram (works on Pages alone, any size/speed)

The 60 s webhook ceiling only affects *receiving* messages. *Sending* is a
plain Bot API call that takes seconds — the slow generation already happened
in your browser. So every gallery tile has a **Send → Telegram** button:
it forwards the finished image to your chat with the full prompt + settings
tag line (`[lite][4096x4096][png][noextend] …`) in the caption; >4.5 MB
files arrive as documents automatically.

Setup (one-time, Cloudflare only):

1. Pages → Settings → Environment variables → add:
   - `TELEGRAM_CHAT_ID` = your numeric Telegram id (the bot replies to `/id`
     with it; yours is `1109142596`)
   - `TELEGRAM_BOT_TOKEN` is already set from the webhook bot.
2. Retry the deployment.
3. Sign in on the site → generate anything (even 4K, even minutes) → click
   **Send → Telegram** on the tile. The route is `/api/send-tg` and inherits
   the site login — nobody outside your session can push to your chat.

### Debugging with the /logs page (webhook bot)

The bot writes every step (message received, allowlist decision, job start,
upstream status/timing, photo sent, any crash) to Cloudflare KV, and
`https://<project>.pages.dev/logs` shows them — auto-refreshing, 7-day
retention. One-time setup:

1. Cloudflare dashboard → **Storage → KV → Create namespace** → name it
   `nova-logs`.
2. Pages project → **Settings → Functions (Integrations) → KV namespace
   bindings** → add binding: **namespace** `nova-logs`, **variable name**
   exactly `LOGS`. Redeploy/retry so the binding is live.
3. Open `/logs` in a browser where you're signed in to the studio (uses the
   same session cookie), or pass the webhook secret: `/logs?key=<TELEGRAM_WEBHOOK_SECRET>`.

If `LOGS` is not bound, the bot still works — logging is silently skipped.

**Silent generation? Reading the log tells you where it stops:**
- nothing at all → webhook delivery issue (`getWebhookInfo` again)
- `msg` then `deny`/`deny:nolist` → add your id to `TELEGRAM_ALLOWED_IDS`
- `job` but no `upstream-ok` → SenseNova call failed or timed out (`upstream-err`
  / `fail` has the message)
- `upstream-ok` but no `sent` → Telegram refused the photo (`fail` has the reason)

(The Render long-poll bot logs the same trail to Render's **Logs** tab
instead — including `sent <chat> <KB> <sec> <size>` lines.)

Security: the webhook verifies Telegram's `X-Telegram-Bot-Api-Secret-Token`
header, so strangers POSTing to `/tg` are rejected; the allowlist gates
generation. Commands like `/id` still answer anyone — harmless (their own id).

---

## Security notes

- The proxy **whitelists** exactly the parameters the docs define and forces
  `response_format: b64_json` and `n: 1`.
- `prompt`, `model`, and `size` are validated server-side before any
  upstream call, so nobody can turn your endpoint into a free relay for other
  models.
- `/api/proxy-image` only forwards to `*.sensenova.ai|dev|cn` hosts — it is
  not an open proxy.
- 429s from SenseNova (quota exhausted) are passed through with a clear
  message, matching the docs' "retry with exponential backoff" advice.
- **Login:** one shared password (`LOGIN_PASSWORD`). A correct sign-in sets an
  HttpOnly, SameSite=Lax, `Secure` cookie valid 30 days whose value is
  `HMAC-SHA256(LOGIN_PASSWORD)` of a fixed string — stateless, unguessable
  without the password, and `/api/*` middleware rejects anyone without it.
  Failed attempts are throttled best-effort (25/10 min/IP), so treat the
  password itself as the real defense. Note: the site itself (HTML/JS) is
  still publicly fetchable by design — only generation is gated.
- **Storage:** none. No images, prompts, or keys are persisted anywhere on
  Cloudflare; the gallery exists only in the open browser tab.
