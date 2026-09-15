"""
teddycloud companion — the phone side of a teddycloud setup. Maps a Tonie figurine UID to
an audio file and streams it, serves the "Storie" PWA (tap a figurine, play its story) and
the admin features that make the companion the front door of teddycloud (coins, uploads,
travel checklist, box status...). tc_sync.py on the teddycloud host keeps both in sync.

The figurine (NXP ICODE SLIX-L, ISO 15693) carries only an 8-byte UID; no audio.
A client (the PWA or the native Android app) reads that UID and asks this server
for the matching story.

Run:  python main.py    (serves on 0.0.0.0:8080)

Endpoints:
  GET  /                    -> the Storie PWA
  GET  /manifest.webmanifest, /sw.js, /static/*  -> PWA assets
  GET  /health              -> {"ok": true}
  GET  /library             -> all enrolled figurines (for the grid)
  GET  /resolve/{uid}       -> metadata + stream_url for a figurine, or 404
  GET  /stream/{uid}        -> the audio bytes (supports HTTP Range / seeking)
  GET  /cover/{uid}         -> cover image, or a 1x1 placeholder
  POST /enroll              -> multipart: uid,title,audio[,cover] -> map a figurine; the audio
                               is also pushed to teddycloud (library/storie/*.taf) so the
                               Toniebox gets it too (TEDDYCLOUD_URL, default http://teddycloud:80)
  POST /rename              -> multipart: uid,title[,cover] -> retitle / re-cover a figurine
  POST /coin                -> form: uid,source -> link a blank coin (SLIX-L) to an existing story
  POST /coin/remove         -> form: uid -> unlink a coin
  POST /story/remove        -> form: uid -> remove a story (and its coins) from app and box
  POST /version             -> form: uid,lang -> switch a story to another language TAF
  POST /backup              -> ask tc_sync.py for a NAS backup
  POST /box/led             -> form: mode (0 on, 1 off, 2 dimmed) -> Toniebox LED via teddycloud
  state/tc_state.json       -> written by tc_sync.py on the server: box status, downloads,
                               unknown tags, language versions, last backup (merged into /library)
  GET  /unknown             -> UIDs that were scanned but aren't in the library yet
  POST /reload              -> re-read library.json without restarting
  GET  /status              -> tiny HTML status page
  GET/POST /login, /logout  -> password gate (see STORIE_PASSWORD below)

Access control: if the COMPANION_PASSWORD environment variable is set, every route except
the PWA assets (/static/*, /manifest.webmanifest, /sw.js) and /health requires either the
session cookie set by /login or the header X-Storie-Password (used by tc_sync.py on the
server). Without the variable the engine is open (LAN-only use).
A second password, COMPANION_GUEST_PASSWORD, opens a guest session for friends:
guests can list and play the stories (and install the app) but nothing else - every admin
route answers 403 and /library hides coins, box status and the rest.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import shutil
import time
from urllib.parse import quote, urlencode
import urllib.request
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
MEDIA = BASE / "media"
STATIC = BASE / "static"
LIBRARY_FILE = BASE / "library.json"
STATE_FILE = BASE / "state" / "tc_state.json"
APPS_DIR = BASE / "apps"          # storie.apk + storie.apk.json, published by scripts/publish_storie.ps1

app = FastAPI(title="Storie engine")


@app.middleware("http")
async def no_store_shell(request: Request, call_next):
    """Keep Cloudflare (which caches .js/.png by default) from caching the app
    shell and API responses — otherwise a redeploy can be shadowed by stale
    edge copies. Audio streams are left cacheable."""
    resp = await call_next(request)
    if not request.url.path.startswith("/stream/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp

# ---- password gate ----------------------------------------------------------
# Passwords: the environment seeds them; config/auth.json (written by the Settings panel)
# overrides it, so they can be changed from the app without a redeploy. tc_sync.py reads the
# same file for its X-Storie-Password header.
AUTH_FILE = BASE / "config" / "auth.json"
AUTH = {
    "admin": (os.environ.get("COMPANION_PASSWORD") or os.environ.get("STORIE_PASSWORD") or "").strip(),
    "guest": (os.environ.get("COMPANION_GUEST_PASSWORD") or os.environ.get("STORIE_GUEST_PASSWORD") or "").strip(),
}
try:
    _saved = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    for k in ("admin", "guest"):
        if isinstance(_saved.get(k), str):
            AUTH[k] = _saved[k].strip()
except Exception:
    pass
PASSWORD = AUTH["admin"]        # "" = engine open (LAN-only use)


def _save_auth() -> None:
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps(AUTH, indent=1), encoding="utf-8")


# Cookie values derived from the passwords: changing a password logs that group out.
def _session_for(role: str) -> str:
    pw = AUTH.get(role, "")
    if not pw:
        return ""
    return hashlib.sha256(f"{'storie-session' if role == 'admin' else 'storie-guest'}:{pw}".encode()).hexdigest()


_COOKIE = "storie_session"
_PUBLIC = {"/login", "/logout", "/health", "/manifest.webmanifest", "/sw.js"}
# what a guest session may touch: the stories, and the app itself
_GUEST_OK = {"/", "/library", "/logout", "/storie.apk", "/storie.apk.json"}
_GUEST_PREFIXES = ("/resolve/", "/stream/", "/cover/")


def _role(request: Request) -> str | None:
    """'admin', 'guest' or None (not logged in)."""
    if not AUTH["admin"]:
        return "admin"
    cookie = request.cookies.get(_COOKIE, "")
    if cookie and hmac.compare_digest(cookie, _session_for("admin")):
        return "admin"
    guest = _session_for("guest")
    if cookie and guest and hmac.compare_digest(cookie, guest):
        return "guest"
    header = request.headers.get("x-storie-password", "")
    if header and hmac.compare_digest(header, AUTH["admin"]):
        return "admin"
    return None


def _authed(request: Request) -> bool:
    return _role(request) is not None


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    path = request.url.path
    if path in _PUBLIC or path.startswith("/static/"):
        return await call_next(request)
    role = _role(request)
    if role == "admin":
        return await call_next(request)
    if role == "guest":
        if path in _GUEST_OK or path.startswith(_GUEST_PREFIXES):
            return await call_next(request)
        if "text/html" in request.headers.get("accept", ""):
            return RedirectResponse("/", status_code=302)
        return JSONResponse({"detail": _msg(request, "Solo ascolto: questa funzione è riservata alla famiglia.")}, status_code=403)
    if "text/html" in request.headers.get("accept", ""):   # browser navigation -> login page
        nxt = path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(nxt, safe='')}", status_code=302)
    return JSONResponse({"detail": "login required"}, status_code=401)


def _msg(request: Request, text: str) -> str:
    """Server-side messages shown by the app as toasts, in the language the app chose."""
    lang = request.cookies.get("storie_lang", "")
    return (_MSG_T.get(text) or {}).get(lang, text)


def _safe_next(nxt: str) -> str:
    return nxt if nxt.startswith("/") and not nxt.startswith("//") else "/"


_LOGIN_T = {
    "it": ("Inserisci la parola segreta per ascoltare le storie.", "Parola segreta", "Entra", "Parola segreta sbagliata.", "Storie"),
    "de": ("Gib das geheime Wort ein, um die Geschichten zu hören.", "Geheimes Wort", "Los", "Falsches geheimes Wort.", "Geschichten"),
    "fr": ("Saisis le mot secret pour écouter les histoires.", "Mot secret", "Entrer", "Mot secret incorrect.", "Histoires"),
    "en": ("Enter the secret word to listen to the stories.", "Secret word", "Enter", "Wrong secret word.", "Stories"),
}
_MSG_T = {
    "Storia non trovata.": {"de": "Geschichte nicht gefunden.", "fr": "Histoire introuvable.", "en": "Story not found."},
    "Gettone non trovato.": {"de": "Münze nicht gefunden.", "fr": "Jeton introuvable.", "en": "Coin not found."},
    "Versione non disponibile.": {"de": "Version nicht verfügbar.", "fr": "Version indisponible.", "en": "Version not available."},
    "Toniebox non ancora vista da teddycloud.": {"de": "Toniebox von teddycloud noch nicht gesehen.", "fr": "Toniebox pas encore vue par teddycloud.", "en": "Toniebox not seen by teddycloud yet."},
    "APK non ancora pubblicato.": {"de": "APK noch nicht veröffentlicht.", "fr": "APK pas encore publié.", "en": "APK not published yet."},
    "Questo codice è un gettone: scollegalo prima dai Gettoni.": {"de": "Dieser Code ist eine Münze: löse sie zuerst unter Münzen.", "fr": "Ce code est un jeton : dissocie-le d'abord dans Jetons.", "en": "This code is a coin: unlink it first under Coins."},
    "Questo codice appartiene a una statuina originale, non a un gettone.": {"de": "Dieser Code gehört zu einer Originalfigur, nicht zu einer Münze.", "fr": "Ce code appartient à une figurine originale, pas à un jeton.", "en": "This code belongs to an original figurine, not a coin."},
    "Il codice non sembra un gettone compatibile: deve avere 16 caratteri e iniziare con E0 04 03.": {"de": "Der Code sieht nicht nach einer kompatiblen Münze aus: 16 Zeichen, beginnt mit E0 04 03.", "fr": "Le code ne ressemble pas à un jeton compatible : 16 caractères, commence par E0 04 03.", "en": "The code does not look like a compatible coin: 16 characters, starting with E0 04 03."},
    "Solo ascolto: questa funzione è riservata alla famiglia.": {"de": "Nur zuhören: diese Funktion ist der Familie vorbehalten.", "fr": "Écoute seule : cette fonction est réservée à la famille.", "en": "Listen only: this feature is for the family."},
    "Parola segreta attuale sbagliata.": {"de": "Aktuelles geheimes Wort ist falsch.", "fr": "Mot secret actuel incorrect.", "en": "Current secret word is wrong."},
    "Almeno 6 caratteri.": {"de": "Mindestens 6 Zeichen.", "fr": "Au moins 6 caractères.", "en": "At least 6 characters."},
    "Almeno 4 caratteri.": {"de": "Mindestens 4 Zeichen.", "fr": "Au moins 4 caractères.", "en": "At least 4 characters."},
    "Deve essere diversa da quella degli amici.": {"de": "Muss sich vom Wort der Freunde unterscheiden.", "fr": "Doit être différent de celui des amis.", "en": "Must differ from the friends' word."},
}


def _lang(request: Request) -> str:
    q = request.query_params.get("lang", "")
    if q in _LOGIN_T:
        return q
    c = request.cookies.get("storie_lang", "")
    if c in _LOGIN_T:
        return c
    for part in request.headers.get("accept-language", "").lower().split(","):
        code = part.strip()[:2]
        if code in _LOGIN_T:
            return code
    return "en"


def _login_html(error: str = "", nxt: str = "/", lang: str = "it") -> str:
    intro, placeholder, enter, _, title = _LOGIN_T.get(lang, _LOGIN_T["it"])
    err = f'<p class="err">{error}</p>' if error else ""
    langs = " · ".join(
        (f"<b>{name}</b>" if code == lang else f'<a href="/login?lang={code}&next={quote(nxt, safe="")}">{name}</a>')
        for code, name in (("it", "IT"), ("de", "DE"), ("fr", "FR"), ("en", "EN")))
    return f"""<!doctype html><html lang=it><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=theme-color content="#0e7c86">
<link rel=manifest href="/manifest.webmanifest?v=3"><link rel=icon href="/static/icon-192.png?v=3">
<title>{title}</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e7c86;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}}
form{{background:#fff;border-radius:22px;padding:28px 24px;width:min(90vw,340px);box-shadow:0 10px 30px rgba(0,0,0,.25)}}
h1{{margin:0 0 6px;font-size:26px;color:#14202a}}p{{margin:0 0 18px;color:#6b7a82;font-size:14px}}
input{{width:100%;box-sizing:border-box;font:inherit;font-size:18px;padding:13px;border:1px solid #d9e0e2;border-radius:12px}}
button{{width:100%;margin-top:12px;font:inherit;font-size:17px;font-weight:700;padding:14px;border:0;border-radius:12px;background:#0e7c86;color:#fff}}
.err{{color:#c0392b;font-weight:600}}.langs{{margin:14px 0 0;font-size:13px;text-align:center}}.langs a{{color:#0e7c86;text-decoration:none}}</style>
<form method=post action=/login>
<h1>&#128218; {title}</h1><p>{intro}</p>{err}
<input type=hidden name=next value="{nxt}">
<input type=hidden name=lang value="{lang}">
<input type=password name=password placeholder="{placeholder}" autofocus autocomplete=current-password required>
<button>{enter}</button><p class="langs">{langs}</p></form></html>"""


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if not AUTH["admin"]:
        return RedirectResponse("/", status_code=302)
    lang = _lang(request)
    resp = HTMLResponse(_login_html(nxt=_safe_next(request.query_params.get("next", "/")), lang=lang))
    if request.query_params.get("lang") in _LOGIN_T:
        resp.set_cookie("storie_lang", lang, max_age=365 * 24 * 3600, samesite="lax", path="/")
    return resp


@app.post("/login")
async def login(password: str = Form(...), next: str = Form("/"), lang: str = Form("it")):
    typed = password.strip()
    relaxed = "".join(typed.split()).casefold()      # guests: spaces and case do not matter
    session = None
    if AUTH["admin"] and hmac.compare_digest(typed, AUTH["admin"]):
        session = _session_for("admin")
    elif AUTH["guest"] and hmac.compare_digest(relaxed, "".join(AUTH["guest"].split()).casefold()):
        session = _session_for("guest")
    if session:
        resp = RedirectResponse(_safe_next(next), status_code=303)
        resp.set_cookie(_COOKIE, session, max_age=365 * 24 * 3600, httponly=True,
                        secure=True, samesite="lax", path="/")
        return resp
    await asyncio.sleep(1.5)   # slow down guessing
    lang = lang if lang in _LOGIN_T else "it"
    return HTMLResponse(_login_html(_LOGIN_T[lang][3], _safe_next(next), lang), status_code=401)


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie(_COOKIE, path="/")
    return resp


@app.post("/settings/password")
async def change_password(request: Request, kind: str = Form(...), current: str = Form(...), new: str = Form(...)):
    """Change the family (admin) or friends (guest) password. Always needs the current family
    password. Changing the family password logs every other device out; this one gets the new
    cookie. Changing the friends' phrase logs the friends out until they type the new one."""
    if kind not in ("admin", "guest"):
        raise HTTPException(status_code=400, detail="kind")
    if not AUTH["admin"] or not hmac.compare_digest(current.strip(), AUTH["admin"]):
        await asyncio.sleep(1.5)
        raise HTTPException(status_code=403, detail=_msg(request, "Parola segreta attuale sbagliata."))
    new = new.strip()
    if kind == "admin" and len(new) < 6:
        raise HTTPException(status_code=400, detail=_msg(request, "Almeno 6 caratteri."))
    if kind == "guest" and new and len(new) < 4:
        raise HTTPException(status_code=400, detail=_msg(request, "Almeno 4 caratteri."))
    if kind == "admin" and new == AUTH["guest"]:
        raise HTTPException(status_code=400, detail=_msg(request, "Deve essere diversa da quella degli amici."))
    AUTH[kind] = new
    _save_auth()
    resp = JSONResponse({"ok": True, "kind": kind, "guest_enabled": bool(AUTH["guest"])})
    if kind == "admin":
        resp.set_cookie(_COOKIE, _session_for("admin"), max_age=365 * 24 * 3600, httponly=True,
                        secure=True, samesite="lax", path="/")
    return resp


# uid (normalized) -> entry dict ; loaded from library.json
_library: dict[str, dict] = {}
# other top-level keys of library.json ("removed", "requests") shared with tc_sync.py
_extra: dict = {}
_state_cache: tuple[float, dict] = (0.0, {})


def tc_state() -> dict:
    """State written by tc_sync.py (box status, downloads, unknown tags, versions, backup)."""
    global _state_cache
    try:
        m = STATE_FILE.stat().st_mtime
        if m != _state_cache[0]:
            _state_cache = (m, json.loads(STATE_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return _state_cache[1]
# uids seen that we couldn't resolve, newest first: {uid: last_seen_epoch}
_unknown: dict[str, float] = {}


def normalize_uid(uid: str) -> str:
    """Uppercase hex, strip spaces/colons/dashes. UIDs are matched in this form."""
    return "".join(c for c in uid.upper() if c in "0123456789ABCDEF")


def reversed_uid(uid: str) -> str:
    """Byte-reversed form. Readers disagree on ISO 15693 UID byte order, so we
    accept either orientation when matching a scan against the library."""
    u = normalize_uid(uid)
    return "".join(reversed([u[i:i + 2] for i in range(0, len(u), 2)]))


def load_library() -> int:
    """(Re)load library.json into memory. Returns the number of entries."""
    global _library, _extra
    lib: dict[str, dict] = {}
    if LIBRARY_FILE.exists():
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        _extra = {k: v for k, v in data.items() if k != "figurines"}
        for entry in data.get("figurines", []):
            uid = normalize_uid(entry["uid"])
            lib[uid] = {
                "uid": uid,
                "title": entry.get("title", "Untitled"),
                "file": entry.get("file", ""),
                "cover": entry.get("cover"),
            }
            # coins: kind="coin", alias_of=<source uid>, tc_state="pending"|"ok"|"error: ..."
            for k in ("kind", "alias_of", "tc_state", "tc_source", "series", "created", "version",
                      "chapters", "chapters_of", "media_of", "skip_seconds", "needs_title"):
                if entry.get(k) is not None:
                    lib[uid][k] = entry[k]
    _library = lib
    return len(lib)


def save_library() -> None:
    """Persist the in-memory library back to library.json (bind-mounted, so this
    survives container restarts). Called after /enroll."""
    payload = {
        **_extra,
        "figurines": [
            {k: v for k, v in e.items() if k != "cover" or v}
            for e in _library.values()
        ],
    }
    LIBRARY_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _effective(entry: dict) -> dict:
    """A coin plays its source story: title/file/cover always follow the source."""
    src = _library.get(entry.get("alias_of") or "")
    if src:
        return {**entry, "title": src["title"], "file": src["file"], "cover": src.get("cover"),
                "chapters": src.get("chapters"), "skip_seconds": src.get("skip_seconds")}
    return entry


def find_entry(scanned_uid: str) -> dict | None:
    """Match a scanned UID against the library, trying both byte orientations."""
    for candidate in (normalize_uid(scanned_uid), reversed_uid(scanned_uid)):
        if candidate in _library:
            return _effective(_library[candidate])
    return None


@app.on_event("startup")
def _startup() -> None:
    MEDIA.mkdir(exist_ok=True)
    n = load_library()
    print(f"[engine] loaded {n} figurine(s) from {LIBRARY_FILE.name}")


@app.get("/health")
def health():
    return {"ok": True, "figurines": len(_library)}


@app.post("/reload")
def reload():
    return {"ok": True, "figurines": load_library()}


@app.get("/unknown")
def unknown():
    items = sorted(_unknown.items(), key=lambda kv: kv[1], reverse=True)
    return {"unknown": [{"uid": u, "last_seen": ts} for u, ts in items]}


@app.get("/resolve/{uid}")
def resolve(uid: str, request: Request):
    entry = find_entry(uid)
    if entry is None:
        _unknown[normalize_uid(uid)] = time.time()
        raise HTTPException(status_code=404, detail="unknown figurine UID")
    _unknown.pop(normalize_uid(uid), None)
    base = str(request.base_url).rstrip("/")
    return {
        "uid": entry["uid"],
        "title": entry["title"],
        "stream_url": f"{base}/stream/{entry['uid']}",
        "cover_url": f"{base}/cover/{entry['uid']}",
        "has_cover": bool(entry.get("cover")),
    }


def _media_path(entry: dict) -> Path:
    p = (MEDIA / entry["file"]).resolve()
    # keep serving confined to the media directory
    if not str(p).startswith(str(MEDIA.resolve())) or not p.is_file():
        raise HTTPException(status_code=404, detail="audio file missing on server")
    return p


# MediaPlayer-friendly content types
_CONTENT_TYPES = {
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".wav": "audio/wav",
}


def _parse_range(range_header: str, size: int) -> tuple[int, int] | None:
    """Parse a single 'bytes=start-end' range. Returns (start, end) inclusive,
    None if absent/unparseable, or raises 416 for an unsatisfiable range."""
    if not range_header or "=" not in range_header:
        return None
    units, _, spec = range_header.partition("=")
    if units.strip().lower() != "bytes":
        return None
    start_s, _, end_s = spec.strip().split(",")[0].partition("-")
    try:
        if start_s == "":                       # suffix range: bytes=-N (last N bytes)
            start, end = max(0, size - int(end_s)), size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    return start, end


@app.get("/stream/{uid}")
def stream(uid: str, request: Request):
    entry = find_entry(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown figurine UID")
    path = _media_path(entry)
    media_type = _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    size = path.stat().st_size

    rng = _parse_range(request.headers.get("range", ""), size)
    if rng is None:
        start, end, status = 0, size - 1, 200
    else:
        start, end, status = rng[0], rng[1], 206

    length = end - start + 1
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(length)}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    def body(chunk: int = 64 * 1024):
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(body(), status_code=status, headers=headers, media_type=media_type)


# 1x1 transparent PNG used when a figurine has no cover art
_PLACEHOLDER_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000b4944415478da636000020000050001e9fadcd80000000049454e44ae426082"
)


@app.get("/cover/{uid}")
def cover(uid: str):
    entry = find_entry(uid)
    if entry and entry.get("cover"):
        p = (MEDIA / entry["cover"]).resolve()
        if str(p).startswith(str(MEDIA.resolve())) and p.is_file():
            return FileResponse(p)
    return Response(content=_PLACEHOLDER_PNG, media_type="image/png")


@app.get("/library")
def library(request: Request):
    """All enrolled figurines, for the PWA grid."""
    base = str(request.base_url).rstrip("/")
    st = tc_state()
    status = st.get("status") or {}
    versions = st.get("versions") or {}
    if _role(request) == "guest":
        return {
            "role": "guest",
            "figurines": [
                {
                    "uid": e["uid"], "title": e["title"], "kind": "figurine",
                    "stream_url": f"{base}/stream/{e['uid']}",
                    "cover_url": f"{base}/cover/{e['uid']}",
                    "has_cover": bool(e.get("cover")),
                    "chapters": e.get("chapters") or [],
                    "skip_seconds": int(e.get("skip_seconds") or 0),
                }
                for e in map(_effective, _library.values()) if e.get("kind", "figurine") != "coin"
            ],
        }
    return {
        "role": "admin",
        "figurines": [
            {
                "uid": e["uid"],
                "title": e["title"],
                "stream_url": f"{base}/stream/{e['uid']}",
                "cover_url": f"{base}/cover/{e['uid']}",
                "has_cover": bool(e.get("cover")),
                "kind": e.get("kind", "figurine"),
                "alias_of": e.get("alias_of"),
                "tc_state": e.get("tc_state"),
                "chapters": e.get("chapters") or [],
                "skip_seconds": int(e.get("skip_seconds") or 0),
                "needs_title": bool(e.get("needs_title")),
                "version": e.get("version") or (versions.get(e["uid"]) or {}).get("current"),
                "versions": (versions.get(e["uid"]) or {}).get("available") or [],
                "downloaded": bool((status.get(e["uid"]) or {}).get("current")),
            }
            for e in map(_effective, _library.values())
        ],
        "box": st.get("box") or {},
        "box_unknown": st.get("box_unknown") or [],
        "backup": st.get("backup") or {},
        "history": st.get("history") or [],
        "settings": _extra.get("settings") or {},
        "state_updated": st.get("updated"),
    }


# ---- coins (blank SLIX-L tags that replay an existing story) -----------------
# Tonie-compatible tags: ICODE SLIX-L, 8-byte UID starting E0 04 03. The Toniebox puts
# the tag into privacy mode the first time it sees it, so the phone must read the UID
# BEFORE the coin ever touches the box. tc_sync.py on the server mirrors coins into
# teddycloud content records (tc_state pending -> ok).
_COIN_UID = re.compile(r"^E00403[0-9A-F]{10}$")


@app.post("/coin")
async def coin_assign(uid: str = Form(...), source: str = Form(...)):
    u, s = normalize_uid(uid), normalize_uid(source)
    if not _COIN_UID.match(u):
        raise HTTPException(status_code=400, detail="Il codice non sembra un gettone compatibile: "
                            "deve avere 16 caratteri e iniziare con E0 04 03.")
    src = _library.get(s)
    if not src or src.get("kind") == "coin":
        raise HTTPException(status_code=404, detail="Storia non trovata.")
    if u in _library and _library[u].get("kind") != "coin":
        raise HTTPException(status_code=409, detail="Questo codice appartiene a una statuina originale, non a un gettone.")
    entry = {"uid": u, "title": src["title"], "file": src["file"], "cover": src.get("cover"),
             "kind": "coin", "alias_of": s, "tc_state": "pending", "created": int(time.time())}
    _library[u] = entry
    _unknown.pop(u, None)
    save_library()
    return {"ok": True, **{k: v for k, v in entry.items() if v is not None}}


@app.post("/coin/remove")
async def coin_remove(uid: str = Form(...)):
    u = normalize_uid(uid)
    e = _library.get(u)
    if not e or e.get("kind") != "coin":
        raise HTTPException(status_code=404, detail="Gettone non trovato.")
    del _library[u]
    save_library()
    return {"ok": True, "uid": u}


@app.post("/story/remove")
async def story_remove(uid: str = Form(...)):
    """Remove a story from the app, its coins with it. tc_sync.py then removes the box records
    and the uploaded audio in teddycloud (the box's own rips stay in the library)."""
    u = normalize_uid(uid)
    e = _library.get(u)
    if not e or e.get("kind") == "coin":
        raise HTTPException(status_code=404, detail="Storia non trovata.")
    gone = [u] + [c for c, ce in _library.items() if ce.get("alias_of") == u]
    for g in gone:
        ent = _library.pop(g)
        if ent.get("kind") != "coin":
            for name in (ent.get("file"), ent.get("cover")):
                if name:
                    try:
                        (MEDIA / name).unlink()
                    except FileNotFoundError:
                        pass
    _extra.setdefault("removed", []).extend(gone)
    save_library()
    return {"ok": True, "removed": gone}


@app.post("/version")
async def set_version(uid: str = Form(...), lang: str = Form(...)):
    """Switch a story to another language version listed in tc_state.json (versions.json on
    the server). tc_sync.py rewrites the box record and rebuilds the phone audio."""
    u = normalize_uid(uid)
    e = _library.get(u)
    if not e or e.get("kind") == "coin":
        raise HTTPException(status_code=404, detail="Storia non trovata.")
    avail = ((tc_state().get("versions") or {}).get(u) or {}).get("available") or []
    src = next((a["source"] for a in avail if a["lang"] == lang), None)
    if not src:
        raise HTTPException(status_code=404, detail="Versione non disponibile.")
    e["tc_source"] = src
    e["version"] = lang
    e["tc_state"] = "pending"
    save_library()
    return {"ok": True, "uid": u, "version": lang}


@app.post("/backup")
async def backup_request():
    _extra.setdefault("requests", {})["backup"] = int(time.time())
    save_library()
    return {"ok": True, "requested": _extra["requests"]["backup"]}


@app.post("/box/schedule")
async def box_schedule(enabled: str = Form("0"), off_at: str = Form("19:00"), on_at: str = Form("07:00"), mode: str = Form("2")):
    """Bedtime schedule for the Toniebox LED, enforced by tc_sync.py every minute."""
    for v in (off_at, on_at):
        if not re.match(r"^\d\d:\d\d$", v):
            raise HTTPException(status_code=400, detail="time must be HH:MM")
    if mode not in ("1", "2"):
        raise HTTPException(status_code=400, detail="mode must be 1 or 2")
    _extra.setdefault("settings", {})["led_schedule"] = {
        "enabled": enabled in ("1", "true", "on"), "off_at": off_at, "on_at": on_at, "mode": int(mode)}
    save_library()
    return {"ok": True, "led_schedule": _extra["settings"]["led_schedule"]}


@app.post("/box/led")
async def box_led(mode: str = Form(...)):
    """Toniebox LED: 0 on, 1 off, 2 dimmed. Applied by the box at its next contact."""
    if mode not in ("0", "1", "2"):
        raise HTTPException(status_code=400, detail="mode must be 0, 1 or 2")
    box_id = (tc_state().get("box") or {}).get("id")
    if not box_id:
        raise HTTPException(status_code=503, detail="Toniebox non ancora vista da teddycloud.")
    req = urllib.request.Request(f"{TEDDYCLOUD}/api/settings/set/toniebox.led?overlay={box_id}",
                                 data=mode.encode(), method="POST",
                                 headers={"Content-Type": "text/plain"})
    try:
        await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=15).read())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"teddycloud: {e}")
    return {"ok": True, "led": int(mode)}


_ALLOWED_AUDIO = {".opus", ".ogg", ".oga", ".mp3", ".m4a", ".aac", ".wav", ".webm"}   # .webm: phone recordings
_ALLOWED_IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _ext(filename: str, allowed: set[str], default: str = "") -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in allowed else default


# ---- teddycloud hand-off ------------------------------------------------------
# Every uploaded story is also encoded into a TAF inside teddycloud's library
# (library/storie/<uid>-<ts>.taf) by teddycloud's own ffmpeg. tc_sync.py on the server then
# creates the box-side content record and reports tc_state back ("ok").
# TEDDYCLOUD_URL: teddycloud's web port as seen from this container (docker network name or IP).
TEDDYCLOUD = os.environ.get("TEDDYCLOUD_URL", "http://teddycloud:80").rstrip("/")


def _tc_push(u: str, path: Path) -> str:
    """Upload `path` to teddycloud's library and encode it to a TAF. Returns the lib:// source.
    Blocking (encoding a 40-minute story takes a while) - run as a background task."""
    name = f"{u}-{int(time.time())}"
    src_name = f"{name}{path.suffix.lower()}"
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{src_name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{TEDDYCLOUD}/api/fileUpload?special=library&path=/storie", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    urllib.request.urlopen(req, timeout=600).read()
    data = urlencode({"target": f"/storie/{name}.taf", "source": f"/storie/{src_name}"}).encode()
    req = urllib.request.Request(f"{TEDDYCLOUD}/api/fileEncode?special=library", data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    msg = urllib.request.urlopen(req, timeout=3600).read().decode(errors="replace")
    if "fail" in msg.lower() or "exist" in msg.lower():
        raise RuntimeError(msg.strip()[:120])
    return f"lib://storie/{name}.taf"


def _tc_job(u: str, path: Path) -> None:
    entry = _library.get(u)
    if not entry or not TEDDYCLOUD:
        return
    entry["tc_state"] = "encoding"
    save_library()
    try:
        entry["tc_source"] = _tc_push(u, path)
        entry["tc_state"] = "pending"          # tc_sync.py turns this into "ok"
        print(f"[engine] {u}: encoded into teddycloud as {entry['tc_source']}")
    except Exception as e:                     # teddycloud down, ffmpeg failure, ...
        entry["tc_state"] = f"error: teddycloud: {e}"
        print(f"[engine] {u}: teddycloud hand-off failed: {e}")
    save_library()


@app.post("/enroll")
async def enroll(
    request: Request,
    background: BackgroundTasks,
    uid: str = Form(...),
    title: str = Form(...),
    audio: UploadFile = File(...),
    cover: UploadFile | None = File(None),
    needs_title: str = Form(""),
):
    """Map a figurine UID to an uploaded audio file (and optional cover).
    Files are stored as media/<uid>.<ext> so re-enrolling overwrites cleanly."""
    u = normalize_uid(uid)
    if not u:
        raise HTTPException(status_code=400, detail="invalid or empty UID")
    ext = _ext(audio.filename, _ALLOWED_AUDIO)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported audio type; allowed: {', '.join(sorted(_ALLOWED_AUDIO))}",
        )
    MEDIA.mkdir(exist_ok=True)
    audio_name = f"{u}{ext}"
    with open(MEDIA / audio_name, "wb") as f:
        shutil.copyfileobj(audio.file, f)

    cover_name = None
    if cover is not None and cover.filename:
        cext = _ext(cover.filename, _ALLOWED_IMAGE)
        if cext:
            cover_name = f"{u}_cover{cext}"
            with open(MEDIA / cover_name, "wb") as f:
                shutil.copyfileobj(cover.file, f)

    entry = {"uid": u, "title": title.strip() or "Untitled", "file": audio_name}
    if cover_name:
        entry["cover"] = cover_name
    old = _library.get(u) or {}
    if old.get("kind") == "coin":
        raise HTTPException(status_code=409, detail="Questo codice è un gettone: scollegalo prima dai Gettoni.")
    if needs_title == "1":
        entry["needs_title"] = True
        entry["tc_state"] = "ok"          # rip coming from teddycloud: TAF already there
    else:
        entry["tc_state"] = "encoding"
    _library[u] = entry
    _unknown.pop(u, None)
    save_library()
    if needs_title != "1":
        background.add_task(_tc_job, u, MEDIA / audio_name)

    base = str(request.base_url).rstrip("/")
    return {
        "ok": True,
        "uid": u,
        "title": entry["title"],
        "stream_url": f"{base}/stream/{u}",
        "cover_url": f"{base}/cover/{u}",
    }


@app.post("/rename")
async def rename(
    request: Request,
    uid: str = Form(...),
    title: str = Form(...),
    cover: UploadFile | None = File(None),
    skip_seconds: str = Form(""),
):
    """Change the title (and optionally the cover) of an enrolled figurine.
    Titles typed here are what tc_sync.py pushes into teddycloud's tonies.custom.json."""
    u = normalize_uid(uid)
    entry = _library.get(u)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown UID")
    entry["title"] = title.strip() or entry["title"]
    entry.pop("needs_title", None)
    if skip_seconds.strip():
        try:
            entry["skip_seconds"] = max(0, int(float(skip_seconds)))
        except ValueError:
            pass
    if cover is not None and cover.filename:
        cext = _ext(cover.filename, _ALLOWED_IMAGE)
        if cext:
            cover_name = f"{u}_cover{cext}"
            with open(MEDIA / cover_name, "wb") as f:
                shutil.copyfileobj(cover.file, f)
            entry["cover"] = cover_name
    save_library()
    if "text/html" in request.headers.get("accept", ""):  # submitted from the /status form
        return RedirectResponse("/status", status_code=303)
    return {"ok": True, "uid": u, "title": entry["title"], "cover": entry.get("cover")}


@app.get("/status", response_class=HTMLResponse)
def status_page():
    def esc(t: str) -> str:
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    rows = "".join(
        f"<tr><td><img src='/cover/{e['uid']}' alt='' width=48 height=48></td>"
        f"<td><code>{e['uid']}</code><br><small>{esc(e['file'])}</small></td>"
        f"<td><form method=post action=/rename enctype=multipart/form-data>"
        f"<input type=hidden name=uid value='{e['uid']}'>"
        f"<input name=title value=\"{esc(e['title'])}\" required> "
        f"<input type=file name=cover accept='image/*'> "
        f"<button>Save</button></form></td></tr>"
        for e in _library.values()
    ) or "<tr><td colspan=3><em>library.json is empty</em></td></tr>"
    return f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Storie engine</title>
<style>body{{font-family:system-ui;margin:1rem;max-width:760px}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ccc;padding:.4rem .5rem;text-align:left;vertical-align:middle}}
img{{object-fit:cover;border-radius:6px;background:#eee}}input[name=title]{{width:14rem;max-width:100%}}form{{display:flex;flex-wrap:wrap;gap:.3rem}}</style>
<h1>Storie engine</h1>
<p>{len(_library)} figurine(s) loaded. App at <a href="/">/</a>,
unknown scans at <a href="/unknown">/unknown</a>. Titles and covers saved here are copied
to teddycloud by the sync job on the mini.</p>
<table><tr><th>Cover</th><th>UID / file</th><th>Title (edit and Save)</th></tr>{rows}</table>"""


# ---- Android app (behind the password; the app sends its session cookie) -------------

@app.get("/storie.apk")
def apk_download():
    p = APPS_DIR / "storie.apk"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="APK non ancora pubblicato.")
    return FileResponse(p, media_type="application/vnd.android.package-archive", filename="storie.apk")


@app.get("/storie.apk.json")
def apk_manifest():
    p = APPS_DIR / "storie.apk.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="APK non ancora pubblicato.")
    return Response(p.read_bytes(), media_type="application/json")


# ---- PWA (served from the engine itself) ---------------------------------

@app.get("/", response_class=HTMLResponse)
def pwa_index():
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Served at root so its scope covers the whole origin.
    return FileResponse(
        STATIC / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


# Static assets (app.js, icons). Mounted last so explicit routes win.
app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    # proxy_headers + trust all forwarded IPs: we sit behind cloudflared, which
    # sets X-Forwarded-Proto=https, so generated URLs use https not http.
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
