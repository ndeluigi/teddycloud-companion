"use strict";
// Storie PWA — served from the engine itself, so all API calls are same-origin.
// Landing page = kid-facing player (tap a figurine, tap a tile). Everything
// administrative (add / rename / manual UID / unknown scans) lives in the ☰ menu.

const $ = (id) => document.getElementById(id);
const player = $("player");
let toastTimer;
let library = [];          // [{uid,title,has_cover,kind,chapters,...}]
let meta = {};             // box, box_unknown, backup (from tc_sync's state, via /library)
// Inside the Android app: window.StorieApp (NFC + background player); see android/README.md
const NATIVE = !!window.StorieApp;
let GUEST = false;         // guest session: play only, no menu
let nativeState = { connected: false, playing: false, position: 0, duration: 0, uid: "", ended: false };
const LANG_NAMES = { "it-it": "Italiano", "de-ch": "Svizzero tedesco", "de-de": "Tedesco", "fr-fr": "Francese", "en-gb": "Inglese", "en-us": "Inglese" };
let currentUid = null;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function setStatus(msg) { $("status").textContent = msg; }
function normUid(s) { return (s || "").toUpperCase().replace(/[^0-9A-F]/g, ""); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  s = Math.floor(s);
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}
// Stable pastel colour per figurine, for tiles without a cover.
function hue(uid) { let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function artHtml(f, big) {
  if (f.has_cover) return `<img src="/cover/${f.uid}" alt="" loading="lazy">`;
  const emojis = ["📖", "🐻", "🦊", "🐙", "🦁", "🐸", "🦄", "🐧"];
  const e = emojis[hue(f.uid) % emojis.length];
  return `<span style="background:hsl(${hue(f.uid)} 60% 62%);width:100%;height:100%;display:grid;place-items:center;font-size:${big ? 72 : 48}px">${e}</span>`;
}

// ---- playback -----------------------------------------------------------

async function playUid(rawUid, { fromScan = false } = {}) {
  const uid = normUid(rawUid);
  if (!uid) return;
  setStatus("Cerco la storia…");
  try {
    const r = await fetch(`/resolve/${uid}`);
    if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    if (r.status === 404) {
      setStatus(`Statuina sconosciuta (${uid}).`);
      if (GUEST) { toast("Questa statuina non è tra le storie"); return; }
      $("fUid").value = uid;
      openSheet("add");
      toast("Statuina nuova: aggiungi la sua storia");
      return;
    }
    if (r.status === 403) { toast("Solo ascolto"); return; }
    if (!r.ok) { setStatus(`Errore del server (${r.status}).`); return; }
    const data = await r.json();
    currentUid = uid;
    const lib = library.find((x) => x.uid === uid) || {};
    showNow({ uid, title: data.title, has_cover: data.has_cover, chapters: lib.chapters || [] });
    if (NATIVE) {
      StorieApp.play(`${location.origin}/stream/${uid}`, data.title, data.has_cover ? `${location.origin}/cover/${uid}` : "", uid, lib.skip_seconds || 0);
      setStatus(`In riproduzione: ${data.title}`);
      return;
    }
    player.src = `/stream/${uid}`;   // same-origin: always HTTPS, no mixed content
    if (lib.skip_seconds) player.addEventListener("loadedmetadata", () => { player.currentTime = lib.skip_seconds; }, { once: true });
    try {
      await player.play();
      setStatus(`In riproduzione: ${data.title}`);
    } catch (_) {
      setStatus(`Pronto: ${data.title} — premi ▶`);   // autoplay blocked
    }
  } catch (_) {
    setStatus("Non riesco a raggiungere il server.");
  }
}

function showNow(f) {
  $("nowTitle").textContent = f.title;
  $("nowArt").innerHTML = artHtml(f, true);
  $("now").classList.add("show");
  $("seek").value = 0; $("tCur").textContent = "0:00"; $("tDur").textContent = "0:00";
  document.querySelectorAll(".fig").forEach((b) => b.classList.toggle("playing", b.dataset.uid === f.uid));
  renderChapters(f.chapters || []);
  $("now").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
let currentChapters = [];
function renderChapters(ch) {
  currentChapters = ch;
  const box = $("chapters");
  box.hidden = ch.length < 2;
  box.innerHTML = ch.map((s, i) => `<button data-t="${s}">Cap. ${i + 1}</button>`).join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    seekTo(Number(b.dataset.t));
    if (NATIVE) StorieApp.resume(); else player.play().catch(() => {});
  }));
}
function highlightChapter() {
  if (currentChapters.length < 2) return;
  let idx = 0;
  const p = pos();
  currentChapters.forEach((s, i) => { if (p >= s) idx = i; });
  $("chapters").querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === idx));
}

function pos() { return NATIVE ? nativeState.position : player.currentTime; }
function dur() { return NATIVE ? nativeState.duration : (player.duration || 0); }
function seekTo(t) { if (NATIVE) StorieApp.seek(t); else player.currentTime = t; }
$("play").addEventListener("click", () => {
  if (NATIVE) {
    if (!nativeState.uid && !currentUid) { toast("Scegli una storia"); return; }
    if (nativeState.playing) StorieApp.pause(); else if (nativeState.uid) StorieApp.resume(); else playUid(currentUid);
    return;
  }
  if (!player.src) { toast("Scegli una storia"); return; }
  if (player.paused) player.play().catch(() => {}); else player.pause();
});
$("back").addEventListener("click", () => { seekTo(Math.max(0, pos() - 15)); });
$("fwd").addEventListener("click", () => { seekTo(Math.min(dur(), pos() + 15)); });
player.addEventListener("play", () => { $("play").textContent = "❚❚"; });
player.addEventListener("pause", () => { $("play").textContent = "▶"; });
player.addEventListener("ended", () => { $("play").textContent = "▶"; setStatus("Fine della storia. Scegline un'altra!"); });
player.addEventListener("timeupdate", () => {
  if (!seeking && player.duration) $("seek").value = Math.round(player.currentTime / player.duration * 1000);
  $("tCur").textContent = fmtTime(player.currentTime);
  highlightChapter();
});
player.addEventListener("durationchange", () => { $("tDur").textContent = fmtTime(player.duration); });
let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; $("tCur").textContent = fmtTime($("seek").value / 1000 * dur()); });
$("seek").addEventListener("change", () => { seeking = false; if (dur()) seekTo($("seek").value / 1000 * dur()); });
if (NATIVE) {
  // the app publishes player state; mirror it into the same controls the browser uses
  setInterval(() => {
    let s; try { s = JSON.parse(StorieApp.state()); } catch (_) { return; }
    nativeState = s;
    if (!s.connected) return;
    $("play").textContent = s.playing ? "❚❚" : "▶";
    if (!seeking && s.duration) $("seek").value = Math.round(s.position / s.duration * 1000);
    $("tCur").textContent = fmtTime(s.position);
    $("tDur").textContent = fmtTime(s.duration);
    highlightChapter();
    if (s.uid && s.uid !== currentUid) {   // resumed from the notification after the page reloaded
      const f = library.find((x) => x.uid === s.uid);
      if (f) { currentUid = s.uid; showNow(f); }
    }
    if (s.ended && $("play").dataset.ended !== s.uid) { $("play").dataset.ended = s.uid; setStatus("Fine della storia. Scegline un'altra!"); }
  }, 400);
}

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => player.play());
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  navigator.mediaSession.setActionHandler("seekbackward", () => { player.currentTime -= 15; });
  navigator.mediaSession.setActionHandler("seekforward", () => { player.currentTime += 15; });
  player.addEventListener("play", () => {
    const f = library.find((x) => x.uid === currentUid);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: f ? f.title : "Storie", artist: "Storie",
      artwork: f && f.has_cover ? [{ src: `/cover/${f.uid}` }] : [],
    });
  });
}

// ---- library grid -------------------------------------------------------

async function loadLibrary() {
  try {
    const r = await fetch("/library");
    if (r.status === 401) { location.href = "/login?next=%2F"; return; }
    const data = await r.json();
    library = data.figurines || [];
    GUEST = data.role === "guest";
    document.body.classList.toggle("guest", GUEST);
    $("guestLogout").hidden = !GUEST;
    meta = { box: data.box || {}, box_unknown: data.box_unknown || [], backup: data.backup || {} };
    renderBoxBar();
    renderNameBanner();
    const grid = $("grid");
    grid.innerHTML = "";
    $("gridEmpty").hidden = library.length > 0;
    for (const f of library.filter((x) => x.kind !== "coin")) {
      const b = document.createElement("button");
      b.className = "fig" + (f.uid === currentUid ? " playing" : "");
      b.dataset.uid = f.uid;
      b.innerHTML = `<div class="art">${artHtml(f, false)}</div><span>${escapeHtml(f.title)}</span>`;
      b.onclick = () => playUid(f.uid);
      grid.appendChild(b);
    }
    if (!currentUid) setStatus(library.length ? "Tocca una storia, o avvicina la statuina." : "Nessuna storia ancora.");
    if ($("panel-coins").classList.contains("show")) { renderCoins(); renderBoxUnknown(); }
    if ($("panel-viaggio").classList.contains("show")) renderTravel();
    if ($("panel-toniebox").classList.contains("show")) renderBoxPanel();
  } catch (_) {
    setStatus("Offline: mostro l'app salvata. Collegati per vedere le storie.");
  }
}

// ---- Web NFC (Tonie tags are ISO 15693: only the UID is readable) --------

let nfcReader = null;
let nfcTarget = null;   // when set, the next tag read goes here instead of playing
window.StorieNative = {
  onTag(uid) {
    uid = normUid(uid);
    if (!uid) return;
    if (nfcTarget) { const t = nfcTarget; nfcTarget = null; t(uid); return; }
    toast(`Letta ${uid}`);
    playUid(uid, { fromScan: true });
  },
};
async function startNfc() {
  if (NATIVE) {
    if (!StorieApp.hasNfc()) { toast("Questo telefono non ha l'NFC: usa le storie qui sotto"); return; }
    nfcReader = true;
    $("tap").classList.add("listening");
    $("tapLabel").textContent = "Avvicina la statuina al telefono";
    return;
  }
  if (!("NDEFReader" in window)) { toast("Questo browser non legge NFC: usa le storie qui sotto"); return; }
  if (nfcReader) { if (!nfcTarget) toast("Sto già ascoltando: avvicina la statuina"); return; }
  try {
    const reader = new NDEFReader();
    await reader.scan();
    nfcReader = reader;
    $("tap").classList.add("listening");
    $("tapLabel").textContent = "In ascolto… avvicina la statuina";
    setStatus("Tieni la statuina contro il retro del telefono.");
    reader.onreading = (event) => {
      const uid = normUid(event.serialNumber || "");
      if (uid && nfcTarget) { const t = nfcTarget; nfcTarget = null; t(uid); return; }
      if (uid) { toast(`Letta ${uid}`); playUid(uid, { fromScan: true }); }
      else setStatus("Statuina rilevata ma il browser non espone il codice.");
    };
    reader.onreadingerror = () => setStatus("Non riesco a leggere questa statuina: tocca una storia qui sotto.");
  } catch (e) {
    setStatus(`NFC non disponibile: ${e.message}`);
  }
}
$("tap").addEventListener("click", startNfc);
if (NATIVE) startNfc(); else if (!("NDEFReader" in window)) $("tap").hidden = true;

// ---- menu sheet -----------------------------------------------------------

const PANEL_TITLES = { menu: "Menu", add: "Aggiungi una storia", coins: "Gettoni", viaggio: "Pronti per il viaggio?", toniebox: "Toniebox", edit: "Storie", uid: "Riproduci un UID", unknown: "Statuine sconosciute" };
function showPanel(name) {
  document.querySelectorAll(".sheet .panel").forEach((p) => p.classList.remove("show"));
  (name === "menu" ? $("menu") : $(`panel-${name}`)).classList.add("show");
  $("sheetTitle").textContent = PANEL_TITLES[name] || "Menu";
  $("sheetBack").hidden = name === "menu";
  setTab(name);
  if (name === "edit") renderEditList();
  if (name === "edit") { clearInterval(editPoll); editPoll = setInterval(async () => { if (!$("panel-edit").classList.contains("show")) { clearInterval(editPoll); return; } await loadLibrary(); renderEditList(); }, 10000); }
  if (name === "unknown") renderUnknown();
  if (name === "coins") coinReset();
  if (name === "viaggio") renderTravel();
  if (name === "toniebox") renderBoxPanel();
  if (name !== "coins") nfcTarget = null;
}
function openSheet(panel = "menu") {
  if (GUEST) return;
  showPanel(panel);
  $("sheet").classList.add("show");
  $("overlay").classList.add("show");
  setTab(panel);
}
function closeSheet() {
  $("sheet").classList.remove("show");
  $("overlay").classList.remove("show");
  nfcTarget = null;
  setTab("home");
}
function setTab(name) {
  const tabs = ["home", "coins", "viaggio", "toniebox"];
  const active = tabs.includes(name) ? name : "menu";
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === active));
}
document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => {
  const t = b.dataset.tab;
  if (t === "home") { closeSheet(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else openSheet(t);
}));
// Android back button: close the sheet first (the app calls this before browser history)
window.StorieBack = () => {
  if ($("sheet").classList.contains("show")) {
    if ($("sheetBack").hidden) closeSheet(); else showPanel("menu");
    return true;
  }
  return false;
};
$("menuBtn").addEventListener("click", () => openSheet("menu"));
$("sheetClose").addEventListener("click", closeSheet);
$("overlay").addEventListener("click", closeSheet);
$("sheetBack").addEventListener("click", () => showPanel("menu"));
document.querySelectorAll("#menu button[data-panel]").forEach((b) => b.addEventListener("click", () => showPanel(b.dataset.panel)));

// add a figurine
$("enrollForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const uid = normUid($("fUid").value);
  if (!uid) { toast("Inserisci il codice"); return; }
  const audio = $("fAudio").files[0];
  if (!audio) { toast("Scegli un file audio"); return; }
  const fd = new FormData();
  fd.append("uid", uid);
  fd.append("title", $("fTitle").value.trim());
  fd.append("audio", audio);
  const cover = $("fCover").files[0];
  if (cover) fd.append("cover", cover);
  toast("Caricamento…");
  try {
    const r = await fetch("/enroll", { method: "POST", body: fd });
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || `Caricamento fallito (${r.status})`); return; }
    toast("Salvata! La Toniebox la riceverà tra qualche minuto.");
    $("enrollForm").reset();
    closeSheet();
    await loadLibrary();
    playUid(uid);
  } catch (_) { toast("Caricamento fallito: errore di rete"); }
});

// rename / cover
function tcBadge(state) {
  if (state === "ok") return '<span class="badge ok">Toniebox ✓</span>';
  if (state === "encoding") return '<span class="badge pending">⏳ preparo l\'audio per la Toniebox…</span>';
  if (state === "pending") return '<span class="badge pending">⏳ in attesa della Toniebox</span>';
  if (state && state.startsWith("error")) return `<span class="badge err">${escapeHtml(state.slice(6).trim())}</span>`;
  return "";
}
function renderEditList() {
  const box = $("editList");
  const stories = library.filter((f) => f.kind !== "coin");
  if (!stories.length) { box.innerHTML = '<p class="hint">Nessuna storia da modificare.</p>'; return; }
  box.innerHTML = stories.map((f) => `
    <form class="card" data-uid="${f.uid}">
      <div class="row">
        <div class="thumb">${artHtml(f, false)}</div>
        <div style="flex:1;min-width:0">
          <input type="text" name="title" value="${escapeHtml(f.title)}" required>
          <div class="uid">${f.uid}</div>${tcBadge(f.tc_state)} ${f.downloaded ? '<span class="badge ok">scaricata sulla box</span>' : ""}
        </div>
      </div>
      ${versionChips(f)}
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div style="flex:1;min-width:160px"><label>Copertina (facoltativa)</label><input type="file" name="cover" accept="image/*"></div>
        <div><label>Salta i primi secondi</label><input type="number" name="skip_seconds" min="0" step="1" value="${f.skip_seconds || 0}" style="width:6.5rem;padding:11px;border:1px solid var(--line);border-radius:12px;font:inherit"></div>
      </div>
      ${f.chapters && f.chapters.length > 1 ? `<div class="hint" style="margin-top:6px">${f.chapters.length} capitoli</div>` : ""}
      <div style="display:flex;gap:8px;margin-top:10px"><button class="primary" style="flex:1">Salva</button><button type="button" class="ghost" data-remove>Rimuovi</button></div>
    </form>`).join("");
  box.querySelectorAll("button[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    const form = b.closest("form");
    const f = library.find((x) => x.uid === form.dataset.uid);
    const coins = library.filter((x) => x.alias_of === f.uid).length;
    if (!confirm(`Rimuovere «${f.title}» dall'app e dalla Toniebox${coins ? ` (e ${coins} gettone/i)` : ""}?`)) return;
    const fd = new FormData(); fd.append("uid", f.uid);
    const r = await fetch("/story/remove", { method: "POST", body: fd });
    toast(r.ok ? "Storia rimossa" : "Errore");
    if (currentUid === f.uid) { player.pause(); $("now").classList.remove("show"); currentUid = null; }
    await loadLibrary(); renderEditList();
  }));
  box.querySelectorAll(".chips button[data-lang]").forEach((b) => b.addEventListener("click", async () => {
    const uid = b.closest("form").dataset.uid;
    const fd = new FormData(); fd.append("uid", uid); fd.append("lang", b.dataset.lang);
    const r = await fetch("/version", { method: "POST", body: fd });
    toast(r.ok ? "Cambio lingua avviato: la Toniebox e il telefono si aggiornano tra poco" : "Errore");
    await loadLibrary(); renderEditList();
  }));
  box.querySelectorAll("form").forEach((form) => form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData();
    fd.append("uid", form.dataset.uid);
    fd.append("title", form.title.value.trim());
    fd.append("skip_seconds", form.skip_seconds.value || "0");
    if (form.cover.files[0]) fd.append("cover", form.cover.files[0]);
    try {
      const r = await fetch("/rename", { method: "POST", body: fd });
      if (!r.ok) { toast(`Salvataggio fallito (${r.status})`); return; }
      toast("Salvato");
      await loadLibrary();
      renderEditList();
      if (form.dataset.uid === currentUid) showNow(library.find((x) => x.uid === currentUid));
    } catch (_) { toast("Salvataggio fallito: errore di rete"); }
  }));
}

// ---- coins wizard ---------------------------------------------------------
// A coin is a blank SLIX-L tag that replays an existing story. The box puts the tag
// into privacy mode on first contact, so the phone must read it BEFORE the box does.

let editPoll = null;
let coinUid = null;
let coinPoll = null;
const COIN_RE = /^E00403[0-9A-F]{10}$/;

function coinStep(n) {
  [1, 2, 3].forEach((i) => {
    $(`coinStep${i}`).hidden = i !== n;
    $(`st${i}`).className = i === n ? "on" : (i < n ? "done" : "");
  });
}
function coinReset() {
  coinUid = null; nfcTarget = null;
  clearInterval(coinPoll); coinPoll = null;
  $("coinStep1Msg").textContent = "";
  $("coinUidInput").value = "";
  $("coinScan").classList.remove("listening");
  $("coinScanLabel").textContent = "Avvicina il gettone al telefono";
  coinStep(1);
  renderCoins();
  renderBoxUnknown();
}
function renderBoxUnknown() {
  const box = $("boxUnknown");
  const items = meta.box_unknown || [];
  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="card"><div style="font-weight:700;margin-bottom:6px">👀 Visti dalla Toniebox</div>
    <p class="hint" style="margin:0 0 8px">Gettoni o statuine appoggiati sulla Toniebox senza una storia. Puoi collegarli da qui anche se il telefono non li legge più.</p>` +
    items.map((u) => `<div class="coin" style="margin-top:8px"><div style="flex:1"><div style="font-weight:600">${u.creative ? "🎨 Tonie creativa" : "🪙 Gettone"}</div>
      <div class="uid">${u.uid.replace(/(..)/g, "$1 ").trim()}</div><div class="hint">${new Date(u.last_seen * 1000).toLocaleString("it-CH")}</div></div>
      <button class="primary" data-uid="${u.uid}" style="padding:10px 14px">Collega</button></div>`).join("") + "</div>";
  box.querySelectorAll("button[data-uid]").forEach((b) => b.addEventListener("click", () => { nfcTarget = null; coinGotUid(b.dataset.uid); }));
}
function coinGotUid(raw) {
  const uid = normUid(raw);
  const msg = $("coinStep1Msg");
  $("coinScan").classList.remove("listening");
  $("coinScanLabel").textContent = "Avvicina il gettone al telefono";
  if (!COIN_RE.test(uid)) {
    msg.textContent = `Codice ${uid || "vuoto"}: non sembra un gettone compatibile (16 caratteri, inizia con E0 04 03).`;
    return;
  }
  const known = library.find((f) => f.uid === uid);
  if (known && known.kind !== "coin") {
    msg.textContent = `Questa è la statuina originale «${known.title}», non un gettone.`;
    return;
  }
  coinUid = uid;
  $("coinUidShow").textContent = uid.replace(/(..)/g, "$1 ").trim();
  msg.textContent = known ? `Il gettone racconta già «${known.title}»: scegli la nuova storia.` : "";
  const pick = $("coinPick");
  pick.innerHTML = "";
  for (const f of library.filter((x) => x.kind !== "coin")) {
    const b = document.createElement("button");
    b.className = "fig";
    b.innerHTML = `<div class="art">${artHtml(f, false)}</div><span>${escapeHtml(f.title)}</span>`;
    b.onclick = () => coinAssign(f);
    pick.appendChild(b);
  }
  coinStep(2);
}
async function coinAssign(story) {
  const fd = new FormData();
  fd.append("uid", coinUid);
  fd.append("source", story.uid);
  try {
    const r = await fetch("/coin", { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { toast(data.detail || `Errore (${r.status})`); return; }
    $("coinDoneArt").innerHTML = artHtml(story, false);
    $("coinDoneTitle").textContent = story.title;
    $("coinDoneUid").textContent = coinUid.replace(/(..)/g, "$1 ").trim();
    coinStep(3);
    coinShowState(data.tc_state);
    await loadLibrary();
    clearInterval(coinPoll);
    coinPoll = setInterval(async () => {
      await loadLibrary();
      const c = library.find((f) => f.uid === coinUid);
      if (!c) return;
      coinShowState(c.tc_state);
      if (c.tc_state && c.tc_state !== "pending") clearInterval(coinPoll);
    }, 5000);
  } catch (_) { toast("Errore di rete"); }
}
function coinShowState(state) {
  const el = $("coinDoneState");
  if (state === "ok") el.innerHTML = '<span class="badge ok">✅ Pronto per la Toniebox</span>';
  else if (state && state.startsWith("error")) el.innerHTML = `<span class="badge err">⚠️ ${escapeHtml(state.slice(6).trim())}</span>`;
  else el.innerHTML = '<span class="badge pending">⏳ Salvato. Sto avvisando la Toniebox (circa un minuto)…</span>';
}
function renderCoins() {
  const box = $("coinList");
  const coins = library.filter((f) => f.kind === "coin");
  if (!coins.length) { box.innerHTML = '<p class="hint">Nessun gettone collegato.</p>'; return; }
  box.innerHTML = coins.map((c) => {
    const st = c.tc_state === "ok" ? '<span class="badge ok">Toniebox ✓</span>'
      : (c.tc_state || "").startsWith("error") ? `<span class="badge err">${escapeHtml(c.tc_state.slice(6).trim())}</span>`
      : '<span class="badge pending">in attesa della Toniebox</span>';
    return `<div class="card coin-card" data-uid="${c.uid}"><div class="coin">
      <div class="thumb">${artHtml(c, false)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700">${escapeHtml(c.title)}</div>
        <div class="uid">${c.uid.replace(/(..)/g, "$1 ").trim()}</div>${st}
        <div class="actions"><button class="ghost" data-act="play">▶ Ascolta</button>
          <button class="ghost" data-act="change">Cambia storia</button>
          <button class="ghost" data-act="remove">Rimuovi</button></div></div></div></div>`;
  }).join("");
  box.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const uid = b.closest(".coin-card").dataset.uid;
    if (b.dataset.act === "play") { closeSheet(); playUid(uid); return; }
    if (b.dataset.act === "change") { coinGotUid(uid); window.scrollTo(0, 0); return; }
    if (!confirm("Scollegare questo gettone? Sulla Toniebox smetterà di funzionare.")) return;
    const fd = new FormData(); fd.append("uid", uid);
    const r = await fetch("/coin/remove", { method: "POST", body: fd });
    toast(r.ok ? "Gettone rimosso" : "Errore");
    await loadLibrary(); renderCoins();
  }));
}
$("coinScan").addEventListener("click", async () => {
  if (!NATIVE && !("NDEFReader" in window)) { toast("Questo telefono non legge NFC dal browser: scrivi il codice a mano"); return; }
  nfcTarget = coinGotUid;
  await startNfc();
  if (nfcReader) {
    $("coinScan").classList.add("listening");
    $("coinScanLabel").textContent = "In ascolto… avvicina il gettone";
  }
});
$("coinManual").addEventListener("submit", (ev) => { ev.preventDefault(); nfcTarget = null; coinGotUid($("coinUidInput").value); });
$("coinBack1").addEventListener("click", () => { coinStep(1); $("coinStep1Msg").textContent = ""; });
$("coinAnother").addEventListener("click", coinReset);

function versionChips(f) {
  if (!f.versions || f.versions.length < 2) return "";
  return `<div class="chips">` + f.versions.map((v) =>
    `<button type="button" data-lang="${v.lang}" class="${v.lang === f.version ? "on" : ""}">${LANG_NAMES[v.lang] || v.lang}</button>`).join("") + `</div>`;
}

// ---- box bar / new-story banner / travel / toniebox panel ----------------------

function ago(ts) {
  if (!ts) return "mai";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return "adesso";
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return new Date(ts * 1000).toLocaleDateString("it-CH");
}
function renderBoxBar() {
  const b = meta.box || {};
  const bar = $("boxBar");
  if (!b.name && !b.last_seen) { bar.hidden = true; return; }
  bar.hidden = false;
  const last = b.last_tag && b.last_tag.title ? ` · ultima storia: ${escapeHtml(b.last_tag.title)} (${ago(b.last_tag.at)})` : "";
  bar.innerHTML = `<span class="dot ${b.online ? "on" : ""}"></span><span>${escapeHtml(b.name || "Toniebox")}: ${b.online ? "in contatto" : "non in contatto, ultima volta " + ago(b.last_seen)}${last}</span>`;
}
function renderNameBanner() {
  const f = library.find((x) => x.needs_title && x.kind !== "coin");
  const el = $("nameBanner");
  el.hidden = !f;
  if (f) { $("nameForm").uid.value = f.uid; $("nameForm").title.placeholder = f.title; }
}
$("nameForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(); fd.append("uid", $("nameForm").uid.value); fd.append("title", $("nameForm").title.value.trim());
  const r = await fetch("/rename", { method: "POST", body: fd });
  toast(r.ok ? "Titolo salvato" : "Errore");
  $("nameForm").reset();
  await loadLibrary();
});
function renderTravel() {
  const box = $("travelList");
  const items = library;
  if (!items.length) { box.innerHTML = '<p class="hint">Nessuna storia.</p>'; return; }
  const missing = items.filter((f) => !f.downloaded).length;
  box.innerHTML = `<p style="font-weight:700">${missing ? `⚠️ ${missing} da scaricare` : "✅ Tutto pronto: la Toniebox ha tutte le storie"}</p>` +
    items.map((f) => `<div class="card travel"><div class="thumb">${artHtml(f, false)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700">${escapeHtml(f.title)}</div>
        <div class="hint">${f.kind === "coin" ? "gettone" : "statuina"} · ${f.uid.replace(/(..)/g, "$1 ").trim()}</div></div>
      <div>${f.downloaded ? '<span class="badge ok">✓ sulla box</span>' : '<span class="badge pending">da appoggiare</span>'}</div></div>`).join("");
}
function renderBoxPanel() {
  const b = meta.box || {};
  $("boxCard").innerHTML = `<div style="font-weight:700;font-size:17px">📦 ${escapeHtml(b.name || "Toniebox")}</div>
    <div class="hint">${b.model ? "modello " + b.model + " · " : ""}${b.id ? "ID " + b.id : ""}</div>
    <p style="margin:8px 0 0"><span class="dot ${b.online ? "on" : ""}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${b.online ? "#2ecc71" : "#aaa"}"></span>
    ${b.online ? "In contatto con teddycloud" : "Non in contatto"} · ultimo contatto: ${ago(b.last_seen)}</p>
    ${b.last_tag && b.last_tag.title ? `<p class="hint" style="margin:4px 0 0">Ultima storia sulla box: ${escapeHtml(b.last_tag.title)} (${ago(b.last_tag.at)})</p>` : ""}`;
  $("ledSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", String(b.led ?? 0) === x.dataset.led));
  const bk = meta.backup || {};
  $("backupInfo").textContent = bk.running ? "Backup in corso…" :
    bk.last ? `Ultimo backup: ${new Date(bk.last * 1000).toLocaleString("it-CH")} (${bk.size || ""}${bk.status === "ok" ? "" : " · " + bk.status})` : "Nessun backup ancora. Ogni notte alle 3:30 parte da solo.";
}
$("ledSeg").querySelectorAll("button").forEach((x) => x.addEventListener("click", async () => {
  const fd = new FormData(); fd.append("mode", x.dataset.led);
  const r = await fetch("/box/led", { method: "POST", body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.detail || "Errore"); return; }
  meta.box.led = d.led; renderBoxPanel(); toast("Impostazione salvata: la Toniebox la applica al prossimo contatto");
}));
$("backupBtn").addEventListener("click", async () => {
  const r = await fetch("/backup", { method: "POST" });
  toast(r.ok ? "Backup richiesto: parte entro un minuto" : "Errore");
  meta.backup.running = Date.now() / 1000; renderBoxPanel();
});
// keep box status fresh while the app is open
setInterval(() => { if (document.visibilityState === "visible") loadLibrary(); }, 30000);

// manual UID
$("uidForm").addEventListener("submit", (ev) => { ev.preventDefault(); closeSheet(); playUid($("mUid").value); });

// unknown scans
async function renderUnknown() {
  const box = $("unknownList");
  try {
    const r = await fetch("/unknown");
    const data = await r.json();
    const items = data.unknown || [];
    if (!items.length) { box.innerHTML = '<p class="hint">Nessun codice sconosciuto: tutte le statuine lette hanno una storia.</p>'; return; }
    box.innerHTML = items.map((u) => `
      <div class="card"><div class="row">
        <div style="flex:1"><div class="uid">${u.uid}</div>
          <div class="hint">${new Date(u.last_seen * 1000).toLocaleString("it-CH")}</div></div>
        <button class="ghost" data-uid="${u.uid}">Aggiungi</button>
      </div></div>`).join("");
    box.querySelectorAll("button[data-uid]").forEach((b) => b.addEventListener("click", () => {
      $("fUid").value = b.dataset.uid; showPanel("add");
    }));
  } catch (_) { box.textContent = "Non riesco a leggere l'elenco."; }
}

// ---- boot -----------------------------------------------------------------

$("about").textContent = `Storie · ${location.host}` + (NATIVE ? ` · app ${StorieApp.version()}` : "");
if (NATIVE) {
  $("apkLink").hidden = true;
  $("updateBtn").hidden = false;
  $("appVersion").textContent = `Versione installata: ${StorieApp.version()}`;
  $("updateBtn").addEventListener("click", () => StorieApp.checkUpdate());
}
loadLibrary();

// Deep link: /?uid=XXXX auto-plays (from a QR code or a native scanner app).
const _qUid = new URLSearchParams(location.search).get("uid");
if (_qUid) playUid(_qUid, { fromScan: true });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=3").catch(() => {});
}
