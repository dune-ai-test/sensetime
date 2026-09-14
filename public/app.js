/* Nova Images — frontend for the /api/generate proxy (Cloudflare Pages Function or Render service) */

const MODELS = {
  "sensenova-u1.5-lite": {
    label: "U1.5 Lite — generation + editing",
    edit: true,
    sizes: ["auto", "2048x2048", "2720x1536", "1536x2720", "1664x2496", "2496x1664", "4096x4096", "1024x1024"],
  },
  "sensenova-u1-fast": {
    label: "U1 Fast — infographics (generation only)",
    edit: false,
    sizes: ["auto", "2048x2048", "2752x1536", "3072x1376"],
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  model: $("model"), size: $("size"), format: $("format"), prompt: $("prompt"),
  promptExtend: $("promptExtend"), watermark: $("watermark"), go: $("go"),
  status: $("status"), gallery: $("gallery"), empty: $("empty"),
  tabGenerate: $("tabGenerate"), tabEdit: $("tabEdit"), editInputs: $("editInputs"),
  drop: $("drop"), file: $("file"), thumbs: $("thumbs"),
};

let mode = "generate"; // or "edit"
let sources = []; // { name, dataUrl }

/* ---------- controls ---------- */

function fillModels() {
  els.model.innerHTML = "";
  for (const [id, m] of Object.entries(MODELS)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = m.label;
    els.model.appendChild(o);
  }
  fillSizes();
  syncModeAvailability();
}

function fillSizes() {
  const sizes = MODELS[els.model.value].sizes;
  els.size.innerHTML = "";
  for (const s of sizes) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s === "auto" ? "Auto" : s;
    els.size.appendChild(o);
  }
}

function syncModeAvailability() {
  const canEdit = MODELS[els.model.value].edit;
  els.tabEdit.disabled = !canEdit;
  els.tabEdit.style.opacity = canEdit ? 1 : 0.4;
  if (!canEdit && mode === "edit") setMode("generate");
}

function setMode(m) {
  mode = m;
  els.tabGenerate.classList.toggle("active", m === "generate");
  els.tabEdit.classList.toggle("active", m === "edit");
  els.editInputs.style.display = m === "edit" ? "block" : "none";
  els.go.textContent = m === "edit" ? "Edit image" : "Create image";
  els.prompt.placeholder = m === "edit"
    ? "Make it a winter scene with falling snow and warm window lights"
    : "A serene Japanese garden at dusk, stone lanterns glowing, koi pond reflections, cinematic lighting";
}

els.model.addEventListener("change", () => { fillSizes(); syncModeAvailability(); });
els.tabGenerate.addEventListener("click", () => setMode("generate"));
els.tabEdit.addEventListener("click", () => { if (!els.tabEdit.disabled) setMode("edit"); });

/* ---------- image sources (edit mode) ---------- */

function addFiles(list) {
  for (const f of list) {
    if (!f.type.startsWith("image/")) continue;
    const r = new FileReader();
    r.onload = () => {
      sources.push({ name: f.name, dataUrl: r.result });
      renderThumbs();
    };
    r.readAsDataURL(f);
  }
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  sources.forEach((s, i) => {
    const wrap = document.createElement("span");
    wrap.style.position = "relative";
    const img = document.createElement("img");
    img.src = s.dataUrl;
    img.title = s.name;
    const x = document.createElement("span");
    x.textContent = "×";
    x.style.cssText = "position:absolute;top:-6px;right:-6px;background:#ff6d7a;color:#fff;border-radius:50%;width:18px;height:18px;font-size:12px;line-height:18px;text-align:center;cursor:pointer";
    x.onclick = () => { sources.splice(i, 1); renderThumbs(); };
    wrap.append(img, x);
    els.thumbs.appendChild(wrap);
  });
}

els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", () => addFiles(els.file.files));
els.drop.addEventListener("dragover", (e) => { e.preventDefault(); els.drop.classList.add("over"); });
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

/* ---------- generate ---------- */

function setStatus(text, kind) {
  els.status.className = "status" + (kind ? " " + kind : "");
  els.status.innerHTML = text;
}

async function run() {
  const prompt = els.prompt.value.trim();
  if (!prompt) return setStatus("Enter a prompt first.", "err");
  if (mode === "edit") {
    if (!sources.length) return setStatus("Add at least one source image in Edit mode.", "err");
    if (!MODELS[els.model.value].edit) return setStatus("This model does not support editing.", "err");
  }

  els.go.disabled = true;
  setStatus('<span class="spinner"></span>Generating… this can take 10–60 seconds.', "busy");
  const slot = addSkeleton();

  const body = {
    mode,
    model: els.model.value,
    prompt,
    size: els.size.value,
    n: 1,
    output_format: els.format.value,
    response_format: "b64_json",
    watermark: els.watermark.checked,
    prompt_extend: els.promptExtend.checked,
  };
  if (mode === "edit") body.images = sources.map((s) => ({ image_url: s.dataUrl }));

  try {
    const res = await fetch("api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);

    const items = data?.data || [];
    slot.remove();
    if (!items.length) throw new Error("The API returned no images.");
    for (const item of items) {
      const src = item.b64_json
        ? `data:image/${els.format.value === "jpeg" ? "jpeg" : els.format.value};base64,${item.b64_json}`
        : item.url;
      addCard(src, body);
    }
    setStatus(`Done — ${items.length} image${items.length > 1 ? "s" : ""} created.`, "ok");
  } catch (err) {
    slot.remove();
    setStatus(String(err.message || err), "err");
  } finally {
    els.go.disabled = false;
  }
}

els.go.addEventListener("click", run);
els.prompt.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});

/* ---------- gallery ---------- */

function addSkeleton() {
  els.empty?.remove();
  const el = document.createElement("div");
  el.className = "skeleton";
  els.gallery.prepend(el);
  return el;
}

function addCard(src, req) {
  els.empty?.remove();
  const fig = document.createElement("figure");
  const img = document.createElement("img");
  img.src = src;
  img.loading = "lazy";
  const cap = document.createElement("figcaption");
  const p = document.createElement("p");
  p.textContent = req.prompt;
  p.title = req.prompt;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span>${req.model.replace("sensenova-", "")} · ${req.size}</span>`;
  const actions = document.createElement("div");
  actions.className = "actions";

  const dl = document.createElement("a");
  dl.textContent = "Download";
  dl.addEventListener("click", async () => {
    let blob;
    if (src.startsWith("data:")) blob = await (await fetch(src)).blob();
    else blob = await (await fetch("api/proxy-image?url=" + encodeURIComponent(src))).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nova-${Date.now()}.${req.output_format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const again = document.createElement("a");
  again.textContent = "Reuse prompt";
  again.addEventListener("click", () => {
    els.prompt.value = req.prompt;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  actions.append(dl, again);
  cap.append(p, meta);
  cap.appendChild(actions);
  fig.append(img, cap);
  els.gallery.prepend(fig);
}

/* ---------- init ---------- */
fillModels();
