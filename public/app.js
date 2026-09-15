/* Nova Studio — frontend. Talks only to same-origin routes:
 *   POST /login  POST /logout  GET /me  POST /api/generate  GET /api/proxy-image
 */

const MODELS = {
  "sensenova-u1.5-lite": {
    name: "U1.5 Lite",
    desc: "Generation & instruction-based editing",
    tag: "Edit",
    edit: true,
    sizes: ["auto", "2048x2048", "2720x1536", "1536x2720", "1664x2496", "2496x1664", "1024x1024", "4096x4096"],
  },
  "sensenova-u1-fast": {
    name: "U1 Fast",
    desc: "Infographics — text-to-image only",
    tag: "2K",
    edit: false,
    sizes: ["auto", "2048x2048", "2752x1536", "3072x1376"],
  },
};

const $ = (id) => document.getElementById(id);
const el = {
  modelList: $("modelList"), sizeChips: $("sizeChips"), format: $("format"),
  prompt: $("prompt"), promptExtend: $("promptExtend"), watermark: $("watermark"),
  go: $("go"), goLabel: $("goLabel"), status: $("status"),
  gallery: $("gallery"), empty: $("empty"), count: $("count"), clearAll: $("clearAll"),
  tabGenerate: $("tabGenerate"), tabEdit: $("tabEdit"), editBlock: $("editBlock"),
  dropzone: $("dropzone"), file: $("file"), thumbs: $("thumbs"),
  login: $("login"), loginCard: $("loginCard"), loginForm: $("loginForm"),
  password: $("password"), loginBtn: $("loginBtn"), loginErr: $("loginErr"),
  signOut: $("signOut"), lightbox: $("lightbox"), lightboxImg: $("lightboxImg"),
  toasts: $("toasts"),
};

let mode = "generate";
let model = Object.keys(MODELS)[0];
let size = MODELS[model].sizes[0];
let sources = []; // { name, dataUrl }
let imgCount = 0;
let busy = false;

/* ---------- toasts ---------- */

function toast(msg, kind = "", ms = 4200) {
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function setHint(text, kind = "") {
  el.status.className = "hint" + (kind ? " " + kind : "");
  el.status.textContent = text;
}

/* ---------- auth ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Session expired — sign in again.");
  }
  return res;
}

function showLogin() {
  el.login.classList.remove("hidden");
  el.signOut.hidden = true;
  setTimeout(() => el.password.focus(), 50);
}

function enterStudio() {
  el.login.classList.add("hidden");
  el.signOut.hidden = false;
  el.loginErr.textContent = "";
  el.password.value = "";
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  el.loginBtn.disabled = true;
  el.loginBtn.innerHTML = '<span class="spin"></span>';
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: el.password.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      el.loginErr.textContent = data?.error?.message || "Sign-in failed.";
      el.loginCard.classList.remove("shake");
      void el.loginCard.offsetWidth; // restart animation
      el.loginCard.classList.add("shake");
      return;
    }
    enterStudio();
  } catch (err) {
    el.loginErr.textContent = String(err.message || err);
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.innerHTML = "<span>Enter studio</span>";
    busy = false;
  }
});

el.signOut.addEventListener("click", async () => {
  await fetch("/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  showLogin();
});

/* ---------- composer controls ---------- */

function renderModels() {
  el.modelList.innerHTML = "";
  for (const [id, m] of Object.entries(MODELS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "model-row" + (id === model ? " sel" : "");
    b.innerHTML = `<b>${m.name}</b><span>${m.desc}</span>`;
    b.addEventListener("click", () => {
      model = id;
      size = MODELS[id].sizes[0];
      if (!m.edit && mode === "edit") setMode("generate");
      renderModels();
      renderSizes();
      el.tabEdit.disabled = !m.edit;
    });
    el.modelList.appendChild(b);
  }
}

function renderSizes() {
  el.sizeChips.innerHTML = "";
  for (const s of MODELS[model].sizes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (s === size ? " on" : "");
    b.textContent = s === "auto" ? "Auto" : s.replace("x", " × ");
    b.addEventListener("click", () => { size = s; renderSizes(); });
    el.sizeChips.appendChild(b);
  }
}

function setMode(m) {
  mode = m;
  el.tabGenerate.classList.toggle("on", m === "generate");
  el.tabEdit.classList.toggle("on", m === "edit");
  el.editBlock.hidden = m !== "edit";
  el.goLabel.textContent = m === "edit" ? "Apply edit" : "Generate image";
  renumberSteps();
  el.prompt.placeholder = m === "edit"
    ? "Instruction for the source image(s), e.g. “remove the background”, “make it snow”…"
    : "e.g. A serene Japanese garden at dusk, stone lanterns glowing, koi pond reflections, cinematic lighting";
}

/* 01, 02, 03… only visible composer sections are numbered. */
function renumberSteps() {
  const labels = document.querySelectorAll(".composer .lab b");
  let n = 0;
  for (const b of labels) {
    if (b.closest(".blk")?.hidden) continue;
    n += 1;
    b.textContent = String(n).padStart(2, "0");
  }
}

el.tabGenerate.addEventListener("click", () => setMode("generate"));
el.tabEdit.addEventListener("click", () => { if (!el.tabEdit.disabled) setMode("edit"); });

/* ---------- source images (edit mode) ---------- */

function addFiles(list) {
  for (const f of list) {
    if (!f.type.startsWith("image/")) continue;
    const r = new FileReader();
    r.onload = () => { sources.push({ name: f.name, dataUrl: r.result }); renderThumbs(); };
    r.readAsDataURL(f);
  }
}

function renderThumbs() {
  el.thumbs.innerHTML = "";
  sources.forEach((s, i) => {
    const wrap = document.createElement("span");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = s.dataUrl;
    img.title = s.name;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.addEventListener("click", () => { sources.splice(i, 1); renderThumbs(); });
    wrap.append(img, x);
    el.thumbs.appendChild(wrap);
  });
}

el.dropzone.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", () => addFiles(el.file.files));
el.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); el.dropzone.classList.add("over"); });
el.dropzone.addEventListener("dragleave", () => el.dropzone.classList.remove("over"));
el.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  el.dropzone.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

/* ---------- generation ---------- */

async function run() {
  if (busy) return;
  const prompt = el.prompt.value.trim();
  if (!prompt) { setHint("Enter a prompt first.", "err"); return; }
  if (mode === "edit" && !sources.length) { setHint("Add at least one source image.", "err"); return; }

  busy = true;
  el.go.disabled = true;
  el.go.insertAdjacentHTML("afterbegin", '<span class="spin"></span>');
  setHint("Rendering…");
  const slot = addSkeleton();
  const t0 = Date.now();
  const tick = setInterval(() => {
    slot.textContent = `Rendering… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);
  slot.textContent = "Rendering… 0s";

  const req = {
    mode,
    model,
    prompt,
    size,
    n: 1,
    output_format: el.format.value,
    response_format: "b64_json",
    watermark: el.watermark.checked,
    prompt_extend: el.promptExtend.checked,
  };
  if (mode === "edit") req.images = sources.map((s) => ({ image_url: s.dataUrl }));

  try {
    const res = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    slot.remove();
    const items = data?.data || [];
    if (!items.length) throw new Error("The API returned no images.");
    for (const item of items) {
      const src = item.b64_json
        ? `data:image/${req.output_format === "jpeg" ? "jpeg" : req.output_format};base64,${item.b64_json}`
        : item.url; // legacy path; proxy-image will cover downloads
      addTile(src, req);
    }
    setHint(`Done — ${items.length} image${items.length > 1 ? "s" : ""} added.`, "ok");
  } catch (err) {
    slot.remove();
    const msg = String(err.message || err);
    setHint(msg, "err");
    toast(msg, "err");
  } finally {
    clearInterval(tick);
    busy = false;
    el.go.disabled = false;
    el.go.querySelector(".spin")?.remove();
  }
}

el.go.addEventListener("click", run);
el.prompt.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});

/* ---------- gallery ---------- */

function refreshCount() {
  imgCount = el.gallery.querySelectorAll(".tile").length;
  el.count.textContent = imgCount ? `${imgCount} image${imgCount > 1 ? "s" : ""}` : "";
  el.clearAll.hidden = !imgCount;
}

function addSkeleton() {
  el.empty?.remove();
  const d = document.createElement("div");
  d.className = "skeleton";
  el.gallery.prepend(d);
  return d;
}

function addTile(src, req) {
  el.empty?.remove();
  const fig = document.createElement("figure");
  fig.className = "tile";

  const holder = document.createElement("div");
  holder.className = "tile-img";
  const img = document.createElement("img");
  img.src = src;
  img.loading = "lazy";
  img.addEventListener("click", () => openLightbox(src));

  const veil = document.createElement("div");
  veil.className = "veil";

  const tgBtn = mkBtn("telegram");
  tgBtn.addEventListener("click", () => sendToTg(tgBtn, src, req));
  const dl = mkBtn("download");
  dl.addEventListener("click", () => download(src, req));
  const reuse = mkBtn("reuse prompt");
  reuse.addEventListener("click", () => { el.prompt.value = req.prompt; el.prompt.focus(); });
  if (MODELS[req.model].edit) {
    const use = mkBtn("use as source");
    use.addEventListener("click", async () => {
      sources.push({ name: "gallery image", dataUrl: await toDataUrl(src) });
      renderThumbs();
      setMode("edit");
      toast("Added to Edit sources.");
    });
    veil.appendChild(use);
  }
  veil.append(reuse, tgBtn, dl);
  holder.append(img, veil);

  const foot = document.createElement("figcaption");
  foot.className = "tile-foot";
  const p = document.createElement("p");
  p.textContent = req.prompt;
  p.title = req.prompt;
  const meta = document.createElement("div");
  meta.className = "tile-meta";
  meta.innerHTML = `<span class="m">${MODELS[req.model].name}</span><span class="m">${req.size}</span>` +
    (req.mode === "edit" ? `<span class="m">edit</span>` : "") +
    `<time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
  foot.append(p, meta);

  fig.append(holder, foot);
  el.gallery.prepend(fig);
  refreshCount();
}

function mkBtn(text) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  return b;
}

async function toDataUrl(src) {
  if (src.startsWith("data:")) return src;
  const blob = await (await api("/api/proxy-image?url=" + encodeURIComponent(src))).blob();
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}

/* ---------- send to telegram ---------- */

function tgCaption(req) {
  const tags = [
    req.model === "sensenova-u1-fast" ? "[fast]" : "[lite]",
    `[${req.size}]`,
    `[${req.output_format}]`,
    req.watermark ? "[watermark]" : "",
    req.prompt_extend ? "" : "[noextend]",
    req.mode === "edit" ? "[edit]" : "",
  ].join("");
  return `${req.prompt}\n${tags} ${req.model.replace("sensenova-", "")}`;
}

async function sendToTg(btn, src, req) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const dataUrl = await toDataUrl(src);
    const res = await api("/api/send-tg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl, caption: tgCaption(req) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    toast(`Sent to Telegram (${data.via}${data.kb ? ` · ${data.kb} KB` : ""}).`);
    btn.textContent = "sent ✓";
    setTimeout(() => { btn.textContent = "telegram"; }, 3000);
  } catch (err) {
    toast(err.message, "err");
    btn.textContent = "telegram";
  } finally {
    btn.disabled = false;
  }
}

async function download(src, req) {
  try {
    const blob = src.startsWith("data:")
      ? await (await fetch(src)).blob()
      : await (await api("/api/proxy-image?url=" + encodeURIComponent(src))).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nova-${Date.now()}.${req.output_format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, "err");
  }
}

el.clearAll.addEventListener("click", () => {
  el.gallery.querySelectorAll(".tile").forEach((t) => t.remove());
  if (!el.gallery.children.length) location.reload();
  refreshCount();
});

/* ---------- lightbox ---------- */

function openLightbox(src) {
  el.lightboxImg.src = src;
  el.lightbox.classList.add("open");
}
el.lightbox.addEventListener("click", () => el.lightbox.classList.remove("open"));
addEventListener("keydown", (e) => { if (e.key === "Escape") el.lightbox.classList.remove("open"); });

/* ---------- init ---------- */

(async function init() {
  renderModels();
  renderSizes();
  setMode("generate");
  try {
    const res = await fetch("/me", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (data?.signedIn) enterStudio();
    else showLogin();
  } catch {
    showLogin(); // can't reach the server; make them sign in anyway
  }
})();
