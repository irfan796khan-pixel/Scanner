const $ = (id) => document.getElementById(id);
const vid = $("vid"), cvs = $("cvs");

let stream = null, track = null, wakeLock = null;
let torchOn = false, sheets = 0, busy = 0, worker = null, workerReady = null;
let rows = [];

const STORE_KEY = "routeScannerRows";

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(rows)); } catch (e) {}
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) rows = JSON.parse(raw) || [];
  } catch (e) { rows = []; }
}
function buzz(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }
function showErr(msg) {
  $("errBox").innerHTML = '<div class="err">' + msg + "</div>";
  setTimeout(() => { $("errBox").innerHTML = ""; }, 6000);
}

/* ---------- camera ---------- */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false
    });
  } catch (e) {
    showErr("Camera not available here. Use photos instead — it opens your normal camera.");
    return false;
  }
  track = stream.getVideoTracks()[0];
  vid.srcObject = stream;
  vid.style.display = "block";
  vid.style.position = "absolute";
  vid.style.width = "1px";
  vid.style.height = "1px";
  vid.style.opacity = "0";
  vid.style.pointerEvents = "none";
  await vid.play();
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  return true;
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null; torchOn = false;
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}

async function toggleTorch() {
  if (!track) return;
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    $("btnTorch").classList.toggle("on", torchOn);
  } catch (e) {
    torchOn = false;
    showErr("This camera will not let the app control the torch.");
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && !$("stage").classList.contains("hidden") && !stream) {
    await startCamera();
  }
});

/* ---------- capture ---------- */

function grabFrame() {
  if (!vid.videoWidth) return null;
  const w = Math.min(2000, vid.videoWidth);
  const h = Math.round(vid.videoHeight * (w / vid.videoWidth));
  cvs.width = w; cvs.height = h;
  cvs.getContext("2d").drawImage(vid, 0, 0, w, h);
  return cvs;
}

function sharpness(canvas) {
  const s = document.createElement("canvas");
  s.width = 160; s.height = 160;
  const c = s.getContext("2d");
  c.drawImage(canvas, 0, 0, 160, 160);
  const d = c.getImageData(0, 0, 160, 160).data;
  const g = new Float32Array(160 * 160);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11);
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < 159; y++) {
    for (let x = 1; x < 159; x++) {
      const i = y * 160 + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 160] - g[i + 160];
      sum += lap; sq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

async function onTap() {
  const canvas = grabFrame();
  if (!canvas) { showErr("Camera is still waking up. Try again in a second."); return; }
  if (sharpness(canvas) < 90) {
    buzz([40, 60, 40]);
    $("hint").textContent = "too blurry — that one again";
    setTimeout(() => { $("hint").textContent = "tap for the next sheet"; }, 1400);
    return;
  }
  buzz(35);
  sheets++;
  $("count").textContent = sheets;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  queueRead(dataUrl);
}

/* ---------- on-device reading ---------- */

async function getWorker() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    worker = await Tesseract.createWorker("eng");
    return worker;
  })();
  return workerReady;
}

async function queueRead(dataUrl) {
  busy++;
  updateStatus();
  try {
    const w = await getWorker();
    const res = await w.recognize(dataUrl);
    rows.push(parseSheet(res.data.text || ""));
    save();
    renderReview();
  } catch (e) {
    rows.push(parseSheet(""));
    save();
    renderReview();
    showErr("One sheet could not be read on the phone. Its fields are blank — fill them in or let Claude read it.");
  } finally {
    busy--;
    updateStatus();
  }
}

function updateStatus() {
  $("stageStatus").textContent = busy > 0 ? "reading " + busy : "Route sheets";
  const done = rows.length, tapped = sheets;
  $("tally").textContent = tapped + " sheets, " + done + " read";
}

/* ---------- parsing printed fields ---------- */

const money = /(\d{1,3}(?:,\d{3})*\.\d{2})/g;
const NOISE = /(invoice|estimate|packing|slip|terms|thank|total|subtotal|balance|due|qty|description|amount|phone|tel|fax|street|road|ave|www|\.com|remit|restock)/i;

function parseSheet(text) {
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  const joined = lines.join(" ");

  let invoice = "";
  const inv = joined.match(/INV[-\s]?0*(\d{3,7})/i);
  if (inv) invoice = "INV-" + inv[1].padStart(6, "0");

  let date = "";
  const d = joined.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (d) date = d[1];

  const amounts = (joined.match(money) || []).map(a => parseFloat(a.replace(/,/g, "")));
  const amount = amounts.length ? Math.max.apply(null, amounts).toFixed(2) : "";

  let store = "";
  for (const l of lines.slice(0, 14)) {
    const clean = l.replace(/[^A-Za-z0-9 &'.\-]/g, "").trim();
    if (clean.length < 4 || clean.length > 42) continue;
    if (NOISE.test(clean)) continue;
    if (!/[A-Za-z]{3}/.test(clean)) continue;
    store = clean;
    break;
  }

  return {
    id: Date.now() + "" + Math.floor(Math.random() * 999),
    store: store,
    city: "",
    invoice: invoice,
    date: date,
    amount: amount,
    returned: "",
    check: "",
    paid: "",
    note: ""
  };
}

/* ---------- review ---------- */

function money2(v) {
  const n = parseFloat(String(v || "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function renderReview() {
  load;
  const box = $("cards");
  box.innerHTML = "";
  rows.forEach((r, i) => {
    const needs = !r.check || !r.paid || !r.amount || !r.store;
    const div = document.createElement("div");
    div.className = "card" + (needs ? " needs" : "");
    div.innerHTML =
      '<div class="cardtop"><span class="store">' + (r.store || "sheet " + (i + 1)) + "</span>" +
      '<button class="x" data-x="' + r.id + '">&times;</button></div>' +
      '<div class="meta">' + [r.invoice, r.date].filter(Boolean).join(" · ") + "</div>" +
      (needs ? '<span class="tag warn">needs your pen fields</span>' : '<span class="tag ok">complete</span>') +
      '<div class="fields">' +
      field(r, "store", "Store") + field(r, "city", "City") +
      field(r, "invoice", "Invoice no") + field(r, "date", "Date") +
      field(r, "amount", "Invoice amount") + field(r, "returned", "Returned value") +
      field(r, "check", "Check no (pen)") + field(r, "paid", "Amount paid (pen)") +
      "</div>";
    box.appendChild(div);
  });

  box.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", e => {
      const r = rows.find(x => x.id === e.target.dataset.id);
      if (r) { r[e.target.dataset.k] = e.target.value; save(); renderBox(); }
    });
    inp.addEventListener("blur", renderReview);
  });
  box.querySelectorAll("[data-x]").forEach(b => {
    b.addEventListener("click", e => {
      rows = rows.filter(x => x.id !== e.target.dataset.x);
      save(); renderReview();
    });
  });

  const total = rows.reduce((s, r) => s + money2(r.paid || r.amount), 0);
  $("total").textContent = total ? "$" + total.toFixed(2) : "";
  updateStatus();
  renderBox();
  $("review").classList.toggle("hidden", rows.length === 0);
}

function field(r, k, label) {
  const v = (r[k] || "").replace(/"/g, "&quot;");
  const blank = v ? "" : " blank";
  return '<div><label>' + label + '</label><input class="' + blank + '" data-id="' + r.id +
    '" data-k="' + k + '" value="' + v + '"></div>';
}

const COLS = ["store", "city", "invoice", "date", "amount", "returned", "check", "paid", "note"];
const HEAD = ["Store", "City", "Invoice", "Date", "Amount", "Returned", "Check no", "Paid", "Note"];

function tsv() {
  return HEAD.join("\t") + "\n" + rows.map(r => COLS.map(k => r[k] || "").join("\t")).join("\n");
}

function renderBox() { $("box").textContent = tsv(); }

async function copyText(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => { btn.textContent = old; }, 1600);
}

function claudeBlock() {
  return "Route sheets scanned " + new Date().toLocaleDateString() +
    ". Blank check and paid fields were not readable on the phone. Match by customer name and amount, not the printed invoice number. Returns come off at full price, no restocking fee. Part-paid invoices take the remaining balance only. Cash to Petty Cash, checks and money orders to Undeposited Funds. Show me the confirm list before posting to Zoho.\n\n" + tsv();
}

/* ---------- photo fallback ---------- */

async function handleFiles(files) {
  for (const f of files) {
    sheets++;
    $("count").textContent = sheets;
    const url = await new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(f);
    });
    await queueRead(url);
  }
}

/* ---------- wiring ---------- */

$("btnStart").addEventListener("click", async () => {
  const ok = await startCamera();
  if (!ok) return;
  $("start").classList.add("hidden");
  $("stage").classList.remove("hidden");
});

$("btnPick").addEventListener("click", () => $("filePick").click());
$("filePick").addEventListener("change", async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  $("start").classList.add("hidden");
  await handleFiles(files);
  renderReview();
});

$("tapArea").addEventListener("click", onTap);

$("btnTorch").addEventListener("click", toggleTorch);

$("btnUndo").addEventListener("click", () => {
  if (rows.length) rows.pop();
  if (sheets > 0) sheets--;
  $("count").textContent = sheets;
  save(); renderReview();
});

$("btnDone").addEventListener("click", () => {
  stopCamera();
  $("stage").classList.add("hidden");
  renderReview();
  window.scrollTo(0, 0);
});

$("btnMore").addEventListener("click", async () => {
  const ok = await startCamera();
  if (!ok) return;
  $("stage").classList.remove("hidden");
});

$("btnCopy").addEventListener("click", e => copyText(tsv(), e.target));
$("btnCopyClaude").addEventListener("click", e => copyText(claudeBlock(), e.target));

$("btnClear").addEventListener("click", () => {
  rows = []; sheets = 0;
  $("count").textContent = "0";
  save(); renderReview();
  $("review").classList.add("hidden");
  $("start").classList.remove("hidden");
});

load();
if (rows.length) { sheets = rows.length; renderReview(); $("start").classList.remove("hidden"); }

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
