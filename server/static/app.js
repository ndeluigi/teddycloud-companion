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
const LOCALE = I18N_LOCALE[LANG] || "it-CH";
let currentUid = null;
// per-phone state
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};
let resumeMap = store.get("storie_resume", {});        // uid -> {pos, dur}
let phoneHistory = store.get("storie_phone_history", []);
let offlineSet = new Set();                            // uids available offline on this phone
let offlineProgress = {};                              // uid -> percent while downloading
const KIDS_LOCK = !!store.get("storie_kidslock", false);
document.body.classList.toggle("kidslock", KIDS_LOCK);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function setStatus(msg) { $("status").textContent = msg; }
function esc(s) { return escapeHtml(s); }
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
  setStatus(t("Cerco la storia…"));
  try {
    const r = await fetch(`/resolve/${uid}`);
    if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    if (r.status === 404) {
      setStatus(t("Statuina sconosciuta ({uid}).", { uid }));
      if (GUEST) { toast(t("Questa statuina non è tra le storie")); return; }
      $("fUid").value = uid;
      openSheet("add");
      toast(t("Statuina nuova: aggiungi la sua storia"));
      return;
    }
    if (r.status === 403) { toast(t("Solo ascolto")); return; }
    if (!r.ok) { setStatus(t("Errore del server ({s}).", { s: r.status })); return; }
    const data = await r.json();
    currentUid = uid;
    const lib = library.find((x) => x.uid === uid) || {};
    showNow({ uid, title: data.title, has_cover: data.has_cover, chapters: lib.chapters || [] });
    phoneHistory.push({ uid, at: Math.floor(Date.now() / 1000) }); phoneHistory = phoneHistory.slice(-100); store.set("storie_phone_history", phoneHistory);
    const rp = resumeMap[uid];
    const startAt = rp && rp.pos > 10 && (!rp.dur || rp.pos < rp.dur - 15) ? Math.floor(rp.pos) : (lib.skip_seconds || 0);
    $("restart").hidden = !(rp && startAt > (lib.skip_seconds || 0));
    if (NATIVE) {
      StorieApp.play(`${location.origin}/stream/${uid}`, data.title, data.has_cover ? `${location.origin}/cover/${uid}` : "", uid, startAt);
      setStatus(t("In riproduzione: {t}", { t: data.title }));
      return;
    }
    player.src = `/stream/${uid}`;   // same-origin: always HTTPS, no mixed content
    if (startAt) player.addEventListener("loadedmetadata", () => { player.currentTime = startAt; }, { once: true });
    try {
      await player.play();
      setStatus(t("In riproduzione: {t}", { t: data.title }));
    } catch (_) {
      setStatus(t("Pronto: {t} — premi ▶", { t: data.title }));   // autoplay blocked
    }
  } catch (_) {
    setStatus(t("Non riesco a raggiungere il server."));
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
  box.innerHTML = ch.map((s, i) => `<button data-t="${s}">${t("Cap. {n}", { n: i + 1 })}</button>`).join("");
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
    if (!nativeState.uid && !currentUid) { toast(t("Scegli una storia")); return; }
    if (nativeState.playing) StorieApp.pause(); else if (nativeState.uid) StorieApp.resume(); else playUid(currentUid);
    return;
  }
  if (!player.src) { toast(t("Scegli una storia")); return; }
  if (player.paused) player.play().catch(() => {}); else player.pause();
});
$("back").addEventListener("click", () => { seekTo(Math.max(0, pos() - 15)); });
$("fwd").addEventListener("click", () => { seekTo(Math.min(dur(), pos() + 15)); });
player.addEventListener("play", () => { $("play").textContent = "❚❚"; });
player.addEventListener("pause", () => { $("play").textContent = "▶"; });
player.addEventListener("ended", () => { $("play").textContent = "▶"; setStatus(t("Fine della storia. Scegline un'altra!")); if (currentUid) { delete resumeMap[currentUid]; store.set("storie_resume", resumeMap); } });
player.addEventListener("timeupdate", () => {
  if (!seeking && player.duration) $("seek").value = Math.round(player.currentTime / player.duration * 1000);
  $("tCur").textContent = fmtTime(player.currentTime);
  highlightChapter();
  rememberPosition(player.currentTime, player.duration || 0);
});
let lastRemember = 0;
function rememberPosition(pos, dur) {
  if (!currentUid || Date.now() - lastRemember < 5000) return;
  lastRemember = Date.now();
  if (dur && pos > dur - 15) { delete resumeMap[currentUid]; } else if (pos > 10) { resumeMap[currentUid] = { pos, dur }; }
  store.set("storie_resume", resumeMap);
}
$("restart").addEventListener("click", () => {
  const lib = library.find((x) => x.uid === currentUid) || {};
  delete resumeMap[currentUid]; store.set("storie_resume", resumeMap);
  seekTo(lib.skip_seconds || 0); $("restart").hidden = true;
  if (NATIVE) StorieApp.resume(); else player.play().catch(() => {});
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
    if (s.playing) rememberPosition(s.position, s.duration);
    if (s.ended && currentUid) { delete resumeMap[currentUid]; store.set("storie_resume", resumeMap); }
    if (s.uid && s.uid !== currentUid) {   // resumed from the notification after the page reloaded
      const f = library.find((x) => x.uid === s.uid);
      if (f) { currentUid = s.uid; showNow(f); }
    }
    if (s.ended && $("play").dataset.ended !== s.uid) { $("play").dataset.ended = s.uid; setStatus(t("Fine della storia. Scegline un'altra!")); }
  }, 400);
}

// ---- sleep timer -----------------------------------------------------------
let sleepUntil = 0, sleepChapterEnd = 0;
function isPlaying() { return NATIVE ? nativeState.playing : !player.paused; }
function pauseAll() { if (NATIVE) StorieApp.pause(); else player.pause(); }
function setSleep(kind) {
  sleepUntil = 0; sleepChapterEnd = 0;
  if (kind === "chapter") {
    const next = currentChapters.find((s) => s > pos() + 2);
    sleepChapterEnd = next || Infinity;
  } else if (Number(kind) > 0) {
    sleepUntil = Date.now() + Number(kind) * 60000;
  }
  $("sleepMenu").hidden = true;
  renderSleep();
}
function renderSleep() {
  const el = $("sleepInfo");
  if (sleepUntil) el.textContent = "💤 " + t("{n} min", { n: Math.max(1, Math.ceil((sleepUntil - Date.now()) / 60000)) });
  else if (sleepChapterEnd) el.textContent = "💤 " + t("fine del capitolo");
  else el.textContent = "";
  $("sleep").classList.toggle("on", !!(sleepUntil || sleepChapterEnd));
}
$("sleep").addEventListener("click", () => { $("sleepMenu").hidden = !$("sleepMenu").hidden; });
$("sleepMenu").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setSleep(b.dataset.min)));
setInterval(() => {
  if (sleepUntil && Date.now() >= sleepUntil) { pauseAll(); sleepUntil = 0; toast(t("💤 Timer: buonanotte")); }
  if (sleepChapterEnd && isPlaying() && (pos() >= sleepChapterEnd || (NATIVE ? nativeState.ended : player.ended))) { pauseAll(); sleepChapterEnd = 0; toast(t("💤 Timer: buonanotte")); }
  renderSleep();
}, 1000);

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
    $("guestFoot").hidden = !GUEST;
    meta = { box: data.box || {}, box_unknown: data.box_unknown || [], backup: data.backup || {}, history: data.history || [], settings: data.settings || {} };
    renderBoxBar();
    renderNameBanner();
    const grid = $("grid");
    grid.innerHTML = "";
    $("gridEmpty").hidden = library.length > 0;
    for (const f of library.filter((x) => x.kind !== "coin")) {
      const b = document.createElement("button");
      b.className = "fig" + (f.uid === currentUid ? " playing" : "");
      b.dataset.uid = f.uid;
      const rp = resumeMap[f.uid];
      const prog = rp && rp.dur ? `<i class="prog" style="width:${Math.min(100, Math.round(rp.pos / rp.dur * 100))}%"></i>` : "";
      const off = offlineSet.has(f.uid) ? `<span class="off" title="${t("Disponibile senza internet")}">📱</span>` : "";
      b.innerHTML = `<div class="art">${artHtml(f, false)}${prog}${off}</div><span>${escapeHtml(f.title)}</span>`;
      b.onclick = () => playUid(f.uid);
      grid.appendChild(b);
    }
    if (!currentUid) setStatus(library.length ? t("Tocca una storia, o avvicina la statuina.") : t("Nessuna storia ancora."));
    if ($("panel-coins").classList.contains("show")) { renderCoins(); renderBoxUnknown(); }
    if ($("panel-viaggio").classList.contains("show")) renderTravel();
    if ($("panel-toniebox").classList.contains("show")) renderBoxPanel();
  } catch (_) {
    setStatus(t("Offline: mostro l'app salvata. Collegati per vedere le storie."));
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
    toast(t("Letta {uid}", { uid }));
    playUid(uid, { fromScan: true });
  },
};
async function startNfc() {
  if (NATIVE) {
    if (!StorieApp.hasNfc()) { toast(t("Questo telefono non ha l'NFC: usa le storie qui sotto")); return; }
    nfcReader = true;
    $("tap").classList.add("listening");
    $("tapLabel").textContent = t("Avvicina la statuina al telefono");
    return;
  }
  if (!("NDEFReader" in window)) { toast(t("Questo browser non legge NFC: usa le storie qui sotto")); return; }
  if (nfcReader) { if (!nfcTarget) toast(t("Sto già ascoltando: avvicina la statuina")); return; }
  try {
    const reader = new NDEFReader();
    await reader.scan();
    nfcReader = reader;
    $("tap").classList.add("listening");
    $("tapLabel").textContent = t("In ascolto… avvicina la statuina");
    setStatus(t("Tieni la statuina contro il retro del telefono."));
    reader.onreading = (event) => {
      const uid = normUid(event.serialNumber || "");
      if (uid && nfcTarget) { const cb = nfcTarget; nfcTarget = null; cb(uid); return; }
      if (uid) { toast(t("Letta {uid}", { uid })); playUid(uid, { fromScan: true }); }
      else setStatus(t("Statuina rilevata ma il browser non espone il codice."));
    };
    reader.onreadingerror = () => setStatus(t("Non riesco a leggere questa statuina: tocca una storia qui sotto."));
  } catch (e) {
    setStatus(t("NFC non disponibile: {e}", { e: e.message }));
  }
}
$("tap").addEventListener("click", startNfc);
if (NATIVE) startNfc(); else if (!("NDEFReader" in window)) $("tap").hidden = true;

// ---- menu sheet -----------------------------------------------------------

const PANEL_TITLES = { menu: "Menu", add: "Aggiungi una storia", coins: "Gettoni", viaggio: "Pronti per il viaggio?", toniebox: "Toniebox", edit: "Storie", uid: "Riproduci un UID", unknown: "Statuine sconosciute", settings: "Impostazioni" };
function showPanel(name) {
  document.querySelectorAll(".sheet .panel").forEach((p) => p.classList.remove("show"));
  (name === "menu" ? $("menu") : $(`panel-${name}`)).classList.add("show");
  $("sheetTitle").textContent = t(PANEL_TITLES[name] || "Menu");
  $("sheetBack").hidden = name === "menu";
  setTab(name);
  if (name === "edit") renderEditList();
  if (name === "edit") { clearInterval(editPoll); editPoll = setInterval(async () => { if (!$("panel-edit").classList.contains("show")) { clearInterval(editPoll); return; } await loadLibrary(); renderEditList(); }, 10000); }
  if (name === "unknown") renderUnknown();
  if (name === "coins") coinReset();
  if (name === "viaggio") renderTravel();
  if (name === "toniebox") renderBoxPanel();
  if (name === "settings") $("langSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.lang === LANG));
  if (name !== "coins") nfcTarget = null;
}
function openSheet(panel = "menu", force = false) {
  if (GUEST) return;
  if (KIDS_LOCK && !force) { toast(t("Tieni premuto ☰ per 2 secondi per aprire il menu")); return; }
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
  const tab = b.dataset.tab;
  if (tab === "home") { closeSheet(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else if (KIDS_LOCK && pressTimer === null && tab === "menu") { /* handled by long press */ openSheet("menu"); }
  else openSheet(tab);
}));
longPress(document.querySelector('#tabbar button[data-tab="menu"]'));
$("kidsLock").checked = KIDS_LOCK;
$("kidsLock").addEventListener("change", () => { store.set("storie_kidslock", $("kidsLock").checked); toast($("kidsLock").checked ? t("Blocco bambini attivo") : t("Blocco bambini disattivato")); setTimeout(() => location.reload(), 600); });
// Android back button: close the sheet first (the app calls this before browser history)
window.StorieBack = () => {
  if ($("sheet").classList.contains("show")) {
    if ($("sheetBack").hidden) closeSheet(); else showPanel("menu");
    return true;
  }
  return false;
};
$("menuBtn").addEventListener("click", () => openSheet("menu"));
// kids lock: a 2-second press on ☰ (or the "Altro" tab) opens the menu anyway
let pressTimer = null;
function longPress(el) {
  el.addEventListener("pointerdown", () => { if (!KIDS_LOCK) return; pressTimer = setTimeout(() => { pressTimer = null; openSheet("menu", true); }, 2000); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }));
}
longPress($("menuBtn"));
$("sheetClose").addEventListener("click", closeSheet);
$("overlay").addEventListener("click", closeSheet);
$("sheetBack").addEventListener("click", () => showPanel("menu"));
document.querySelectorAll("#menu button[data-panel]").forEach((b) => b.addEventListener("click", () => showPanel(b.dataset.panel)));

// add a figurine
$("enrollForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const uid = normUid($("fUid").value);
  if (!uid) { toast(t("Inserisci il codice")); return; }
  const ext = recordedBlob && recordedBlob.type.includes("ogg") ? "ogg" : recordedBlob && recordedBlob.type.includes("mp4") ? "m4a" : "webm";
  const audio = $("fAudio").files[0] || (recordedBlob && new File([recordedBlob], `registrazione.${ext}`, { type: recordedBlob.type }));
  if (!audio) { toast(t("Scegli un file audio o registra una storia")); return; }
  const fd = new FormData();
  fd.append("uid", uid);
  fd.append("title", $("fTitle").value.trim());
  fd.append("audio", audio);
  const cover = $("fCover").files[0];
  if (cover) fd.append("cover", cover);
  toast(t("Caricamento…"));
  try {
    const r = await fetch("/enroll", { method: "POST", body: fd });
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.detail || t("Caricamento fallito ({s})", { s: r.status })); return; }
    toast(t("Salvata! La Toniebox la riceverà tra qualche minuto."));
    $("enrollForm").reset(); recordedBlob = null; $("recReady").hidden = true; $("recPreview").hidden = true; $("fAudio").required = true; $("recTime").textContent = "";
    closeSheet();
    await loadLibrary();
    playUid(uid);
  } catch (_) { toast(t("Caricamento fallito: errore di rete")); }
});

// rename / cover
function tcBadge(state) {
  if (state === "ok") return `<span class="badge ok">${t("Toniebox ✓")}</span>`;
  if (state === "encoding") return `<span class="badge pending">${t("⏳ preparo l'audio per la Toniebox…")}</span>`;
  if (state === "pending") return `<span class="badge pending">${t("⏳ in attesa della Toniebox")}</span>`;
  if (state && state.startsWith("error")) return `<span class="badge err">${escapeHtml(state.slice(6).trim())}</span>`;
  return "";
}
function renderEditList() {
  const box = $("editList");
  const stories = library.filter((f) => f.kind !== "coin");
  if (!stories.length) { box.innerHTML = `<p class="hint">${t("Nessuna storia da modificare.")}</p>`; return; }
  box.innerHTML = stories.map((f) => `
    <form class="card" data-uid="${f.uid}">
      <div class="row">
        <div class="thumb">${artHtml(f, false)}</div>
        <div style="flex:1;min-width:0">
          <input type="text" name="title" value="${escapeHtml(f.title)}" required>
          <div class="uid">${f.uid}</div>${tcBadge(f.tc_state)} ${f.downloaded ? `<span class="badge ok">${t("scaricata sulla box")}</span>` : ""}
        </div>
      </div>
      ${versionChips(f)}
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div style="flex:1;min-width:160px"><label>${t("Copertina (facoltativa)")}</label><input type="file" name="cover" accept="image/*"></div>
        <div><label>${t("Salta i primi secondi")}</label><input type="number" name="skip_seconds" min="0" step="1" value="${f.skip_seconds || 0}" style="width:6.5rem;padding:11px;border:1px solid var(--line);border-radius:12px;font:inherit"></div>
      </div>
      ${f.chapters && f.chapters.length > 1 ? `<div class="hint" style="margin-top:6px">${t("{n} capitoli", { n: f.chapters.length })}</div>` : ""}
      <div style="display:flex;gap:8px;margin-top:10px"><button class="primary" style="flex:1">${t("Salva")}</button><button type="button" class="ghost" data-remove>${t("Rimuovi")}</button></div>
    </form>`).join("");
  box.querySelectorAll("button[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    const form = b.closest("form");
    const f = library.find((x) => x.uid === form.dataset.uid);
    const coins = library.filter((x) => x.alias_of === f.uid).length;
    if (!confirm(t("Rimuovere «{t}» dall'app e dalla Toniebox{c}?", { t: f.title, c: coins ? t(" (e {n} gettone/i)", { n: coins }) : "" }))) return;
    const fd = new FormData(); fd.append("uid", f.uid);
    const r = await fetch("/story/remove", { method: "POST", body: fd });
    toast(r.ok ? t("Storia rimossa") : t("Errore"));
    if (currentUid === f.uid) { player.pause(); $("now").classList.remove("show"); currentUid = null; }
    await loadLibrary(); renderEditList();
  }));
  box.querySelectorAll(".chips button[data-lang]").forEach((b) => b.addEventListener("click", async () => {
    const uid = b.closest("form").dataset.uid;
    const fd = new FormData(); fd.append("uid", uid); fd.append("lang", b.dataset.lang);
    const r = await fetch("/version", { method: "POST", body: fd });
    toast(r.ok ? t("Cambio lingua avviato: la Toniebox e il telefono si aggiornano tra poco") : t("Errore"));
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
      if (!r.ok) { toast(t("Salvataggio fallito ({s})", { s: r.status })); return; }
      toast(t("Salvato"));
      await loadLibrary();
      renderEditList();
      if (form.dataset.uid === currentUid) showNow(library.find((x) => x.uid === currentUid));
    } catch (_) { toast(t("Salvataggio fallito: errore di rete")); }
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
  $("coinScanLabel").textContent = t("Avvicina il gettone al telefono");
  coinStep(1);
  renderCoins();
  renderBoxUnknown();
}
function renderBoxUnknown() {
  const box = $("boxUnknown");
  const items = meta.box_unknown || [];
  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="card"><div style="font-weight:700;margin-bottom:6px">${t("👀 Visti dalla Toniebox")}</div>
    <p class="hint" style="margin:0 0 8px">${t("Gettoni o statuine appoggiati sulla Toniebox senza una storia. Puoi collegarli da qui anche se il telefono non li legge più.")}</p>` +
    items.map((u) => `<div class="coin" style="margin-top:8px"><div style="flex:1"><div style="font-weight:600">${u.creative ? t("🎨 Tonie creativa") : t("🪙 Gettone")}</div>
      <div class="uid">${u.uid.replace(/(..)/g, "$1 ").trim()}</div><div class="hint">${new Date(u.last_seen * 1000).toLocaleString(LOCALE)}</div></div>
      <button class="primary" data-uid="${u.uid}" style="padding:10px 14px">${t("Collega")}</button></div>`).join("") + "</div>";
  box.querySelectorAll("button[data-uid]").forEach((b) => b.addEventListener("click", () => { nfcTarget = null; coinGotUid(b.dataset.uid); }));
}
function coinGotUid(raw) {
  const uid = normUid(raw);
  const msg = $("coinStep1Msg");
  $("coinScan").classList.remove("listening");
  $("coinScanLabel").textContent = t("Avvicina il gettone al telefono");
  if (!COIN_RE.test(uid)) {
    msg.textContent = t("Codice {uid}: non sembra un gettone compatibile (16 caratteri, inizia con E0 04 03).", { uid: uid || t("vuoto") });
    return;
  }
  const known = library.find((f) => f.uid === uid);
  if (known && known.kind !== "coin") {
    msg.textContent = t("Questa è la statuina originale «{t}», non un gettone.", { t: known.title });
    return;
  }
  coinUid = uid;
  $("coinUidShow").textContent = uid.replace(/(..)/g, "$1 ").trim();
  msg.textContent = known ? t("Il gettone racconta già «{t}»: scegli la nuova storia.", { t: known.title }) : "";
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
    if (!r.ok) { toast(data.detail || t("Errore ({s})", { s: r.status })); return; }
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
  } catch (_) { toast(t("Errore di rete")); }
}
function coinShowState(state) {
  const el = $("coinDoneState");
  if (state === "ok") el.innerHTML = `<span class="badge ok">${t("✅ Pronto per la Toniebox")}</span>`;
  else if (state && state.startsWith("error")) el.innerHTML = `<span class="badge err">⚠️ ${escapeHtml(state.slice(6).trim())}</span>`;
  else el.innerHTML = `<span class="badge pending">${t("⏳ Salvato. Sto avvisando la Toniebox (circa un minuto)…")}</span>`;
}
function renderCoins() {
  const box = $("coinList");
  const coins = library.filter((f) => f.kind === "coin");
  if (!coins.length) { box.innerHTML = `<p class="hint">${t("Nessun gettone collegato.")}</p>`; return; }
  box.innerHTML = coins.map((c) => {
    const st = c.tc_state === "ok" ? `<span class="badge ok">${t("Toniebox ✓")}</span>`
      : (c.tc_state || "").startsWith("error") ? `<span class="badge err">${escapeHtml(c.tc_state.slice(6).trim())}</span>`
      : `<span class="badge pending">${t("in attesa della Toniebox")}</span>`;
    return `<div class="card coin-card" data-uid="${c.uid}"><div class="coin">
      <div class="thumb">${artHtml(c, false)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700">${escapeHtml(c.title)}</div>
        <div class="uid">${c.uid.replace(/(..)/g, "$1 ").trim()}</div>${st}
        <div class="actions"><button class="ghost" data-act="play">${t("▶ Ascolta")}</button>
          <button class="ghost" data-act="change">${t("Cambia storia")}</button>
          <button class="ghost" data-act="remove">${t("Rimuovi")}</button></div></div></div></div>`;
  }).join("");
  box.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const uid = b.closest(".coin-card").dataset.uid;
    if (b.dataset.act === "play") { closeSheet(); playUid(uid); return; }
    if (b.dataset.act === "change") { coinGotUid(uid); window.scrollTo(0, 0); return; }
    if (!confirm(t("Scollegare questo gettone? Sulla Toniebox smetterà di funzionare."))) return;
    const fd = new FormData(); fd.append("uid", uid);
    const r = await fetch("/coin/remove", { method: "POST", body: fd });
    toast(r.ok ? t("Gettone rimosso") : t("Errore"));
    await loadLibrary(); renderCoins();
  }));
}
$("coinScan").addEventListener("click", async () => {
  if (!NATIVE && !("NDEFReader" in window)) { toast(t("Questo telefono non legge NFC dal browser: scrivi il codice a mano")); return; }
  nfcTarget = coinGotUid;
  await startNfc();
  if (nfcReader) {
    $("coinScan").classList.add("listening");
    $("coinScanLabel").textContent = t("In ascolto… avvicina il gettone");
  }
});
$("coinManual").addEventListener("submit", (ev) => { ev.preventDefault(); nfcTarget = null; coinGotUid($("coinUidInput").value); });
$("coinBack1").addEventListener("click", () => { coinStep(1); $("coinStep1Msg").textContent = ""; });
$("coinAnother").addEventListener("click", coinReset);

function versionChips(f) {
  if (!f.versions || f.versions.length < 2) return "";
  return `<div class="chips">` + f.versions.map((v) =>
    `<button type="button" data-lang="${v.lang}" class="${v.lang === f.version ? "on" : ""}">${t(LANG_NAMES[v.lang] || v.lang)}</button>`).join("") + `</div>`;
}

// ---- box bar / new-story banner / travel / toniebox panel ----------------------

function ago(ts) {
  if (!ts) return t("mai");
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return t("adesso");
  if (s < 3600) return t("{n} min fa", { n: Math.round(s / 60) });
  if (s < 86400) return t("{n} h fa", { n: Math.round(s / 3600) });
  return new Date(ts * 1000).toLocaleDateString(LOCALE);
}
function renderBoxBar() {
  const b = meta.box || {};
  const bar = $("boxBar");
  if (!b.name && !b.last_seen) { bar.hidden = true; return; }
  bar.hidden = false;
  const last = b.last_tag && b.last_tag.title ? " · " + t("ultima storia: {t} ({a})", { t: escapeHtml(b.last_tag.title), a: ago(b.last_tag.at) }) : "";
  bar.innerHTML = `<span class="dot ${b.online ? "on" : ""}"></span><span>${escapeHtml(b.name || "Toniebox")}: ${b.online ? t("in contatto") : t("non in contatto, ultima volta {a}", { a: ago(b.last_seen) })}${last}</span>`;
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
  toast(r.ok ? t("Titolo salvato") : t("Errore"));
  $("nameForm").reset();
  await loadLibrary();
});
function renderTravel() {
  const box = $("travelList");
  const items = library;
  if (!items.length) { box.innerHTML = `<p class="hint">${t("Nessuna storia.")}</p>`; return; }
  const missing = items.filter((f) => !f.downloaded).length;
  box.innerHTML = `<p style="font-weight:700">${missing ? t("⚠️ {n} da scaricare", { n: missing }) : t("✅ Tutto pronto: la Toniebox ha tutte le storie")}</p>` +
    items.map((f) => `<div class="card travel"><div class="thumb">${artHtml(f, false)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700">${escapeHtml(f.title)}</div>
        <div class="hint">${f.kind === "coin" ? t("gettone") : t("statuina")} · ${f.uid.replace(/(..)/g, "$1 ").trim()}</div></div>
      <div style="display:grid;gap:6px;justify-items:end">${f.downloaded ? `<span class="badge ok">${t("✓ sulla box")}</span>` : `<span class="badge pending">${t("da appoggiare")}</span>`}
        ${f.kind === "coin" ? "" : offlineSet.has(f.uid) ? `<button class="ghost small" data-off-remove="${f.uid}">📱 ✓ ${t("sul telefono")}</button>` : offlineProgress[f.uid] !== undefined ? `<span class="badge pending">📱 ${offlineProgress[f.uid]}%</span>` : `<button class="ghost small" data-off-add="${f.uid}">📱 ${t("Scarica sul telefono")}</button>`}</div></div>`).join("");
  box.querySelectorAll("button[data-off-add]").forEach((b) => b.addEventListener("click", () => offlineAdd(b.dataset.offAdd)));
  box.querySelectorAll("button[data-off-remove]").forEach((b) => b.addEventListener("click", () => offlineRemove(b.dataset.offRemove)));
}
function renderBoxPanel() {
  const b = meta.box || {};
  $("boxCard").innerHTML = `<div style="font-weight:700;font-size:17px">📦 ${escapeHtml(b.name || "Toniebox")}</div>
    <div class="hint">${b.model ? t("modello {m}", { m: b.model }) + " · " : ""}${b.id ? "ID " + b.id : ""}</div>
    <p style="margin:8px 0 0"><span class="dot ${b.online ? "on" : ""}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${b.online ? "#2ecc71" : "#aaa"}"></span>
    ${b.online ? t("In contatto con teddycloud") : t("Non in contatto")} · ${t("ultimo contatto: {a}", { a: ago(b.last_seen) })}</p>
    ${b.last_tag && b.last_tag.title ? `<p class="hint" style="margin:4px 0 0">${t("Ultima storia sulla box: {t} ({a})", { t: escapeHtml(b.last_tag.title), a: ago(b.last_tag.at) })}</p>` : ""}`;
  $("ledSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", String(b.led ?? 0) === x.dataset.led));
  renderSchedule(); renderHistory();
  const bk = meta.backup || {};
  $("backupInfo").textContent = bk.running ? t("Backup in corso…") :
    bk.last ? t("Ultimo backup: {d} ({s})", { d: new Date(bk.last * 1000).toLocaleString(LOCALE), s: (bk.size || "") + (bk.status === "ok" ? "" : " · " + bk.status) }) : t("Nessun backup ancora. Ogni notte alle 3:30 parte da solo.");
}
$("ledSeg").querySelectorAll("button").forEach((x) => x.addEventListener("click", async () => {
  const fd = new FormData(); fd.append("mode", x.dataset.led);
  const r = await fetch("/box/led", { method: "POST", body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.detail || t("Errore")); return; }
  meta.box.led = d.led; renderBoxPanel(); toast(t("Impostazione salvata: la Toniebox la applica al prossimo contatto"));
}));
$("backupBtn").addEventListener("click", async () => {
  const r = await fetch("/backup", { method: "POST" });
  toast(r.ok ? t("Backup richiesto: parte entro un minuto") : t("Errore"));
  meta.backup.running = Date.now() / 1000; renderBoxPanel();
});
// keep box status fresh while the app is open
setInterval(() => { if (document.visibilityState === "visible") loadLibrary(); }, 30000);

$("langSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
$("guestLangs").querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.lang === LANG); b.addEventListener("click", () => setLang(b.dataset.lang)); });
if (NATIVE) {
  $("guestApk").hidden = true;
  $("guestUpdate").hidden = false;
  $("guestUpdate").addEventListener("click", () => StorieApp.checkUpdate());
  $("guestVersion").textContent = t("Versione installata: {v}", { v: StorieApp.version() });
}

// password changes (Settings)
document.querySelectorAll("form.pwform").forEach((form) => form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const kind = form.dataset.kind;
  const fresh = form.new.value.trim();
  if (kind === "admin" && fresh !== form.repeat.value.trim()) { toast(t("Le due parole non coincidono")); return; }
  const fd = new FormData(); fd.append("kind", kind); fd.append("current", form.current.value); fd.append("new", fresh);
  try {
    const r = await fetch("/settings/password", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.detail || t("Errore")); return; }
    form.reset();
    toast(kind === "admin" ? t("Parola segreta cambiata") : (d.guest_enabled ? t("Parola segreta degli amici cambiata: comunicala agli amici") : t("Accesso degli amici disattivato")));
  } catch (_) { toast(t("Errore di rete")); }
}));

// ---- offline stories -----------------------------------------------------------
function swCall(msg) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { resolve({}); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data || {});
    navigator.serviceWorker.controller.postMessage(msg, [ch.port2]);
  });
}
async function refreshOffline() {
  try {
    if (NATIVE) {
      const o = JSON.parse(StorieApp.offline());
      offlineSet = new Set(o.uids || []); offlineProgress = o.progress || {};
    } else {
      const o = await swCall({ type: "offline-list" });
      offlineSet = new Set(o.uids || []);
    }
  } catch (_) { /* ignore */ }
}
async function offlineAdd(uid) {
  const f = library.find((x) => x.uid === uid) || {};
  toast(t("Scarico «{t}» sul telefono…", { t: f.title || uid }));
  if (NATIVE) { StorieApp.download(uid, `${location.origin}/stream/${uid}`, f.title || uid); offlineProgress[uid] = 0; renderTravel(); return; }
  offlineProgress[uid] = 0; renderTravel();
  const r = await swCall({ type: "offline-add", uid });
  delete offlineProgress[uid];
  toast(r.ok ? t("Salvata sul telefono") : t("Scaricamento fallito: {e}", { e: r.error || "?" }));
  await refreshOffline(); renderTravel(); loadLibrary();
}
async function offlineRemove(uid) {
  if (NATIVE) StorieApp.removeOffline(uid); else await swCall({ type: "offline-remove", uid });
  await refreshOffline(); renderTravel(); loadLibrary();
}
refreshOffline().then(() => loadLibrary());
if (NATIVE) setInterval(async () => { const before = JSON.stringify([...offlineSet]) + JSON.stringify(offlineProgress); await refreshOffline(); if (JSON.stringify([...offlineSet]) + JSON.stringify(offlineProgress) !== before && $("panel-viaggio").classList.contains("show")) renderTravel(); }, 1500);

// ---- listening history + bedtime schedule (Toniebox panel) --------------------------
function titleOf(uid) { const f = library.find((x) => x.uid === uid); return f ? f.title : uid; }
function renderHistory() {
  const box = $("historyList");
  const rows = [...(meta.history || []).map((h) => ({ ...h, where: "box" })), ...phoneHistory.map((h) => ({ ...h, where: "phone" }))]
    .sort((a, b) => b.at - a.at).slice(0, 40);
  if (!rows.length) { box.textContent = t("Nessun ascolto registrato."); return; }
  let day = "";
  box.innerHTML = rows.map((h) => {
    const d = new Date(h.at * 1000); const ds = d.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
    const head = ds !== day ? `<div style="font-weight:700;margin:8px 0 2px">${ds}</div>` : ""; day = ds;
    return head + `<div class="hist"><span>${h.where === "box" ? "📦" : "📱"} ${escapeHtml(titleOf(h.uid))}</span><span>${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}</span></div>`;
  }).join("");
}
function renderSchedule() {
  const s = (meta.settings || {}).led_schedule || {};
  const f = $("schedForm");
  f.enabled.checked = !!s.enabled; f.off_at.value = s.off_at || "19:00"; f.on_at.value = s.on_at || "07:00"; f.mode.value = String(s.mode || 2);
}
$("schedForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = $("schedForm"); const fd = new FormData();
  fd.append("enabled", f.enabled.checked ? "1" : "0"); fd.append("off_at", f.off_at.value); fd.append("on_at", f.on_at.value); fd.append("mode", f.mode.value);
  const r = await fetch("/box/schedule", { method: "POST", body: fd });
  toast(r.ok ? t("Orario salvato: la Toniebox lo applica al prossimo contatto") : t("Errore"));
  await loadLibrary();
});

// ---- record a story (MediaRecorder) ---------------------------------------------------
let recorder = null, recChunks = [], recStart = 0, recTimer = null, recordedBlob = null;
$("recBtn").addEventListener("click", async () => {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast(t("Questo telefono non può registrare dal browser")); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    recChunks = []; recordedBlob = null; $("recReady").hidden = true; $("recPreview").hidden = true;
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(recTimer);
      recordedBlob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      $("recPreview").src = URL.createObjectURL(recordedBlob); $("recPreview").hidden = false;
      $("recReady").hidden = false; $("fAudio").required = false;
      $("recBtn").textContent = t("● Registra di nuovo"); $("recBtn").classList.remove("recording");
    };
    recorder.start(1000);
    recStart = Date.now();
    $("recBtn").textContent = t("■ Ferma"); $("recBtn").classList.add("recording");
    recTimer = setInterval(() => { $("recTime").textContent = "🔴 " + fmtTime((Date.now() - recStart) / 1000); }, 500);
  } catch (e) { toast(t("Microfono non disponibile: {e}", { e: e.message })); }
});

// manual UID
$("uidForm").addEventListener("submit", (ev) => { ev.preventDefault(); closeSheet(); playUid($("mUid").value); });

// unknown scans
async function renderUnknown() {
  const box = $("unknownList");
  try {
    const r = await fetch("/unknown");
    const data = await r.json();
    const items = data.unknown || [];
    if (!items.length) { box.innerHTML = `<p class="hint">${t("Nessun codice sconosciuto: tutte le statuine lette hanno una storia.")}</p>`; return; }
    box.innerHTML = items.map((u) => `
      <div class="card"><div class="row">
        <div style="flex:1"><div class="uid">${u.uid}</div>
          <div class="hint">${new Date(u.last_seen * 1000).toLocaleString(LOCALE)}</div></div>
        <button class="ghost" data-uid="${u.uid}">${t("Aggiungi")}</button>
      </div></div>`).join("");
    box.querySelectorAll("button[data-uid]").forEach((b) => b.addEventListener("click", () => {
      $("fUid").value = b.dataset.uid; showPanel("add");
    }));
  } catch (_) { box.textContent = t("Non riesco a leggere l'elenco."); }
}

// ---- boot -----------------------------------------------------------------

$("about").textContent = `Storie · ${location.host}` + (NATIVE ? ` · app ${StorieApp.version()}` : "");
if (NATIVE) {
  $("apkLink").hidden = true;
  $("updateBtn").hidden = false;
  $("appVersion").textContent = t("Versione installata: {v}", { v: StorieApp.version() });
  $("updateBtn").addEventListener("click", () => StorieApp.checkUpdate());
}
loadLibrary();

// Deep link: /?uid=XXXX auto-plays (from a QR code or a native scanner app).
const _qUid = new URLSearchParams(location.search).get("uid");
if (_qUid) playUid(_qUid, { fromScan: true });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=3").catch(() => {});
}
