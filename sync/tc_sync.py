#!/usr/bin/env python3
"""Keep teddycloud (Toniebox) and the companion (phone PWA, "storie") in sync. Runs on the
teddycloud host from cron (every minute, under flock) and nightly with --backup.

Configuration: environment variables, or the companion's .env file (COMPANION_DIR/.env):
  COMPANION_DIR          data dir of the companion (library.json, media/, state/) [~/teddycloud-companion]
  TEDDYCLOUD_DIR         teddycloud data dir with config/, content/, library/, custom_img/ [~/teddycloud]
  TEDDYCLOUD_CONTAINER   docker container name of teddycloud [teddycloud]
  COMPANION_CONTAINER    docker container name of the companion server [companion]
  TEDDYCLOUD_API         teddycloud web API as seen from the host [http://localhost:8095]
  PUBLIC_URL             companion URL, used only if the container IP cannot be found
  BACKUP_TARGET          rsync target "host:path" (ssh alias); empty = backups disabled
  COMPANION_PASSWORD     the admin password (sent as X-Storie-Password header)

teddycloud -> storie : every figurine that teddycloud has ripped (content record with a
                       library TAF) but storie does not know yet is converted TAF->opus and
                       enrolled in storie (title from tonies.json if known, else a placeholder
                       flagged needs_title so the app asks for a name). The record is pinned
                       (nocloud) so the box keeps that version - set the language to Italian in
                       the Tonies app BEFORE placing a new figurine the first time.
uploads              : stories uploaded in the PWA are encoded by teddycloud into
                       library/storie/*.taf (storie calls teddycloud's API); this job then
                       creates the content record so the box plays them (tc_state -> ok).
coins                : storie entries of kind "coin" (blank SLIX-L, or a Creative Tonie, linked
                       to a story in the PWA) get a content record pointing at the source
                       story's TAF (nocloud). Removed coins lose their record (or get their
                       cloud content back if the tag is an original one).
versions             : COMPANION_DIR/versions.json maps UID -> {lang: lib://...taf}. When the app
                       switches a story's language the record and the phone's opus are rebuilt.
storie -> teddycloud : title + cover of every storie figurine are written to
                       teddycloud/config/tonies.custom.json and the record's tonie_model is set,
                       so the teddycloud UI shows the same title and picture as the phone.
state                : COMPANION_DIR/state/tc_state.json (read by the server): box status (from the
                       teddycloud log), what the box has downloaded, unknown tags the box saw,
                       language versions, last backup. chapters + skip_seconds are mirrored too.
removals / backup    : storie writes "removed" and "requests" into library.json; this job
                       deletes records/uploads and runs the NAS backup (rsync).

Idempotent; only writes when something changed. Log: COMPANION_DIR/tc_sync.log
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
STORIE_DIR = os.environ.get("COMPANION_DIR") or f"{HOME}/teddycloud-companion"


def _envfile():
    out = {}
    try:
        for line in open(f"{STORIE_DIR}/.env"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except Exception:
        pass
    return out


_ENV = _envfile()


def cfg(name, default=""):
    return os.environ.get(name) or _ENV.get(name) or default


TC = os.path.expanduser(cfg("TEDDYCLOUD_DIR", f"{HOME}/teddycloud"))
TC_CONTAINER = cfg("TEDDYCLOUD_CONTAINER", "teddycloud")
COMPANION_CONTAINER = cfg("COMPANION_CONTAINER", "companion")
COMPANION_URL = cfg("PUBLIC_URL", "").rstrip("/")
CONTENT = f"{TC}/content/default"
LIB = f"{TC}/library"
CUSTOM_IMG = f"{TC}/custom_img"
TONIES_JSON = f"{TC}/config/tonies.json"
CUSTOM_JSON = f"{TC}/config/tonies.custom.json"
TC_API = cfg("TEDDYCLOUD_API", "http://localhost:8095").rstrip("/")
STORIE_LIB = f"{STORIE_DIR}/library.json"
STORIE_MEDIA = f"{STORIE_DIR}/media"
STATE_DIR = f"{STORIE_DIR}/state"
STATE_FILE = f"{STATE_DIR}/tc_state.json"
VERSIONS_FILE = f"{STORIE_DIR}/versions.json"
COINS_STATE = f"{STORIE_DIR}/coins.json"     # coin UIDs whose teddycloud record we created
LOG = f"{STORIE_DIR}/tc_sync.log"
FFMPEG_IMG = "mwader/static-ffmpeg:latest"
LANG = "it-it"
BACKUP_TARGET = cfg("BACKUP_TARGET", "")     # "host:path" over ssh; empty = no backups
ONLINE_WINDOW = 15 * 60                      # box considered online if seen within 15 min
CUSTOM_OFFSET = 0x50000000                   # teddycloud adds this to audio ids of local TAFs


def _storie_password():
    """The admin password: config/auth.json (changed from the app) wins over .env / env."""
    try:
        pw = json.load(open(f"{STORIE_DIR}/config/auth.json")).get("admin", "")
        if pw:
            return pw
    except Exception:
        pass
    return cfg("COMPANION_PASSWORD") or cfg("STORIE_PASSWORD")


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def docker_write(container_path, data, container=None):
    container = container or TC_CONTAINER
    """Write a root-owned file inside a container."""
    subprocess.run(["docker", "exec", "-i", container, "sh", "-c", "cat > " + container_path],
                   input=data, check=True)


def ruid_to_uid(ruid):
    return bytes(reversed(bytes.fromhex(ruid))).hex().upper()


def uid_to_dir(uid):
    """UID E00403AABBCCDDEE -> content dir EEDDCCBB, file AA0304E0 (rUID split in two)."""
    ruid = bytes(reversed(bytes.fromhex(uid))).hex().upper()
    return ruid[:8], ruid[8:]


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return r, i


def taf_header(path):
    """(audio_id, sha1 hex, track page numbers) from the TAF header; None if not a TAF."""
    try:
        with open(path, "rb") as f:
            hl = struct.unpack(">I", f.read(4))[0]
            if hl > 65536:
                return None
            hdr = f.read(hl)
    except Exception:
        return None
    sha = aid = None
    pages = []
    i = 0
    while i < len(hdr):
        key, i = varint(hdr, i)
        fn, wt = key >> 3, key & 7
        if wt == 2:
            ln, i = varint(hdr, i)
            val = hdr[i:i + ln]
            i += ln
            if fn == 1:
                sha = val.hex()
            elif fn == 4:
                j = 0
                while j < len(val):
                    v, j = varint(val, j)
                    pages.append(v)
        elif wt == 0:
            v, i = varint(hdr, i)
            if fn == 3:
                aid = v
            elif fn == 4:
                pages.append(v)
        else:
            break
    return (aid, sha, pages) if aid and sha else None


def taf_chapters(path):
    """Start time (seconds) of each track, from the Ogg page granule positions."""
    info = taf_header(path)
    if not info:
        return []
    wanted = set(info[2])
    starts = []
    with open(path, "rb") as f:
        hl = struct.unpack(">I", f.read(4))[0]
        f.seek(4 + hl)
        audio = f.read()
    pos = 0
    while wanted:
        p = audio.find(b"OggS", pos)
        if p < 0:
            break
        gran = struct.unpack("<q", audio[p + 6:p + 14])[0]
        seq = struct.unpack("<I", audio[p + 18:p + 22])[0]
        if seq in wanted:
            starts.append(max(0, gran // 48000))
            wanted.discard(seq)
        nseg = audio[p + 26]
        pos = p + 27 + nseg + sum(audio[p + 27:p + 27 + nseg])
    return sorted(starts)


def storie_url():
    ip = subprocess.run(["docker", "inspect", COMPANION_CONTAINER, "--format",
                         "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],
                        capture_output=True, text=True).stdout.strip()
    return f"http://{ip}:8080" if ip else COMPANION_URL


def storie_post(path, data=b"", headers=None):
    h = {"X-Storie-Password": _storie_password()}
    h.update(headers or {})
    req = urllib.request.Request(f"{storie_url()}{path}", data=data, method="POST", headers=h)
    return urllib.request.urlopen(req, timeout=600).read()


def read_records():
    """teddycloud content records -> {uid: {dir, file, json, mtime, taf, audio_id, hash}}.
    The rUID is the directory name + json file name (records created by this job have an
    empty cloud_ruid until the box places the tag for the first time)."""
    recs = {}
    for d in sorted(os.listdir(CONTENT)):
        if not os.path.isdir(f"{CONTENT}/{d}") or d.startswith("0000"):
            continue
        for name in sorted(os.listdir(f"{CONTENT}/{d}")):
            if not name.endswith(".json") or len(name) != 13:
                continue
            ruid = (d + name[:-5]).lower()
            if len(ruid) != 16 or not all(ch in "0123456789abcdef" for ch in ruid):
                continue
            jp = f"{CONTENT}/{d}/{name}"
            try:
                c = json.load(open(jp))
            except Exception:
                continue
            src = c.get("source") or ""
            taf = f"{LIB}/{src[6:]}" if src.startswith("lib://") else None
            info = taf_header(taf) if taf and os.path.isfile(taf) else None
            recs[ruid_to_uid(ruid)] = {
                "dir": d, "file": name[:-5], "json": c, "mtime": os.path.getmtime(jp),
                "taf": taf if info else None,
                "audio_id": info[0] if info else None, "hash": info[1] if info else None,
            }
    return recs


def write_record(rec_dir, rec_file, data):
    subprocess.run(["docker", "exec", TC_CONTAINER, "mkdir", "-p",
                    f"/teddycloud/data/content/default/{rec_dir}"], check=True)
    docker_write(f"/teddycloud/data/content/default/{rec_dir}/{rec_file}.json",
                 json.dumps(data, indent=1).encode())


def tonies_title(audio_id):
    """Best-effort title from tonies.json for a known audio-id (None for unknowns)."""
    try:
        for t in json.load(open(TONIES_JSON)):
            if str(audio_id) in (t.get("audio_id") or []):
                series, ep = t.get("series"), t.get("episodes")
                if series and ep:
                    return f"{series} - {ep}"
                title = t.get("title") or ""
                return None if "None" in title or not title else title
    except Exception:
        pass
    return None


def taf_to_opus(taf, out):
    work = tempfile.mkdtemp()
    try:
        with open(taf, "rb") as f:
            hl = struct.unpack(">I", f.read(4))[0]
            f.seek(4 + hl)
            with open(f"{work}/raw.opus", "wb") as o:
                shutil.copyfileobj(f, o)
        subprocess.run(["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                        "-v", f"{work}:/work", FFMPEG_IMG,
                        "-hide_banner", "-loglevel", "error", "-i", "/work/raw.opus",
                        "-c:a", "copy", "/work/out.opus"], check=True)
        shutil.move(f"{work}/out.opus", out)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def enroll(uid, title, opus, needs_title):
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in (("uid", uid), ("title", title), ("needs_title", "1" if needs_title else "")):
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; "
             f"filename=\"{uid}.opus\"\r\nContent-Type: audio/ogg\r\n\r\n").encode()
    body += open(opus, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    return json.loads(storie_post("/enroll", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}))


def write_storie_library(storie):
    data = json.dumps(storie, indent=2, ensure_ascii=False)
    try:
        open(STORIE_LIB, "w", encoding="utf-8").write(data)
    except PermissionError:
        docker_write("/app/library.json", data.encode(), container=COMPANION_CONTAINER)
    try:
        storie_post("/reload")
    except Exception as e:
        log(f"WARN storie reload: {e}")


def load_state():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    state["updated"] = int(time.time())
    tmp = STATE_FILE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=1, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


# --------------------------------------------------------------------------- box / log
LOG_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+Z (.*)$")
FRESH = re.compile(r"process_freshness_check\|\s+uid: ([0-9A-F]{16}), nocloud: \d, live: \d, updated: (\d), "
                   r"audioid: ([0-9A-F]{8}) \(([^)]*)\)")
CONTENT_REQ = re.compile(r"/v2/content/([0-9a-f]{16})")


def parse_box_log(state):
    """Update state['box'] and state['downloads'] from the teddycloud container log."""
    since = state.get("log_cursor") or "720h"
    out = subprocess.run(["docker", "logs", "--timestamps", "--since", since, TC_CONTAINER],
                         capture_output=True, text=True, errors="replace")
    lines = (out.stdout + out.stderr).splitlines()
    box = state.setdefault("box", {})
    downloads = state.setdefault("downloads", {})
    last_ts = None
    for line in lines:
        m = LOG_TS.match(line)
        if not m:
            continue
        ts_iso, rest = m.groups()
        if "handler_cloud.c" not in rest:
            continue
        ts = int(datetime.strptime(ts_iso, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
        last_ts = ts_iso
        box["last_seen"] = max(box.get("last_seen") or 0, ts)
        f = FRESH.search(rest)
        if f:
            uid, updated, aid_hex, note = f.groups()
            aid = int(aid_hex, 16)
            if "custom" in note:
                aid -= CUSTOM_OFFSET
            d = downloads.setdefault(uid, {})
            d.update(box_audio_id=aid, reported=ts, box_says_outdated=(updated == "1"))
            continue
        c = CONTENT_REQ.search(rest)
        if c and "Serve" in rest:
            uid = ruid_to_uid(c.group(1))
            d = downloads.setdefault(uid, {})
            d["downloaded"] = ts
            box["last_tag"] = {"uid": uid, "at": ts}
            hist = state.setdefault("history", [])
            if not hist or hist[-1]["uid"] != uid or ts - hist[-1]["at"] > 120:
                hist.append({"uid": uid, "at": ts})
                del hist[:-300]
    if last_ts:
        state["log_cursor"] = last_ts   # docker --since accepts RFC3339
    return state


def box_info(state, figs):
    """Box identity + LED mode from teddycloud; online flag from last_seen."""
    box = state.setdefault("box", {})
    try:
        b = json.load(urllib.request.urlopen(f"{TC_API}/api/getBoxes", timeout=10))["boxes"][0]
        box.update(id=b["ID"], name=b.get("boxName") or "Toniebox", model=b.get("boxModel"))
        led = urllib.request.urlopen(f"{TC_API}/api/settings/get/toniebox.led?overlay={b['ID']}", timeout=10).read()
        box["led"] = int(led.strip() or 0)
    except Exception:
        box.setdefault("name", "Toniebox")
    box["online"] = bool(box.get("last_seen")) and time.time() - box["last_seen"] < ONLINE_WINDOW
    lt = box.get("last_tag")
    if lt:
        f = figs.get(lt["uid"])
        lt["title"] = f["title"] if f else None
    return box


def led_schedule(state, storie):
    """Bedtime schedule from the app (settings.led_schedule): set the LED mode teddycloud hands
    to the box at its next contact. 0 on, 1 off, 2 dimmed."""
    sched = (storie.get("settings") or {}).get("led_schedule") or {}
    box = state.get("box") or {}
    if not sched.get("enabled") or not box.get("id"):
        return
    now = time.strftime("%H:%M")
    off_at, on_at = sched.get("off_at", "19:00"), sched.get("on_at", "07:00")
    night = (now >= off_at or now < on_at) if off_at > on_at else (off_at <= now < on_at)
    desired = int(sched.get("mode", 2)) if night else 0
    if box.get("led") == desired:
        return
    try:
        req = urllib.request.Request(f"{TC_API}/api/settings/set/toniebox.led?overlay={box['id']}",
                                     data=str(desired).encode(), method="POST",
                                     headers={"Content-Type": "text/plain"})
        urllib.request.urlopen(req, timeout=15).read()
        box["led"] = desired
        log(f"led schedule: {'night' if night else 'day'} -> led={desired}")
    except Exception as e:
        log(f"WARN led schedule: {e}")


def download_status(state, figs, recs):
    """Per story: has the box got the current audio? Evidence: freshness report with the same
    audio id, or a content download after the record last changed."""
    downloads = state.setdefault("downloads", {})
    result = {}
    for uid, f in figs.items():
        rec = recs.get(uid)
        d = downloads.get(uid, {})
        cur = False
        if rec and rec["taf"]:
            if d.get("box_audio_id") == rec["audio_id"] and not d.get("box_says_outdated"):
                cur = True
            elif d.get("downloaded") and d["downloaded"] >= rec["mtime"] - 5:
                cur = True
        result[uid] = {"current": cur, "seen": d.get("reported") or d.get("downloaded")}
    return result


# --------------------------------------------------------------------------- records
def sync_records(storie, figs, recs):
    """Mirror storie entries into teddycloud content records and report tc_state back.
    - coin      -> record pointing at the source story's TAF
    - figurine with tc_source (upload encoded by teddycloud, or a chosen language version)
                -> record pointing at that TAF
    - figurine ripped by the box -> record already exists, just report "ok"
    Records of the box's own rips are never rewritten except for skip_seconds."""
    try:
        created = set(json.load(open(COINS_STATE)))
    except Exception:
        created = set()
    changed = False
    for uid, f in figs.items():
        kind = f.get("kind", "figurine")
        rec = recs.get(uid)
        want = None
        new_state = None
        if kind == "coin":
            src = recs.get((f.get("alias_of") or "").upper())
            if src and src["taf"]:
                want = src["json"]["source"]
            else:
                new_state = "error: la storia non è ancora nella Toniebox"
        else:
            tc_source = f.get("tc_source") or ""
            has_file = tc_source.startswith("lib://") and os.path.isfile(f"{LIB}/{tc_source[6:]}")
            if has_file and (not rec or rec["json"].get("source") != tc_source):
                want = tc_source
            elif rec and rec["taf"]:
                new_state = "ok"
            elif (f.get("tc_state") or "").startswith(("encoding", "error: teddycloud")):
                continue
            else:
                new_state = "error: audio non ancora nella Toniebox"
        if kind == "coin":
            skip = int((figs.get((f.get("alias_of") or "").upper()) or {}).get("skip_seconds") or 0)
        else:
            skip = int(f.get("skip_seconds") or 0)
        d, fn = uid_to_dir(uid)
        if want:
            cur = rec["json"] if rec else {}
            if cur.get("source") != want or not cur.get("nocloud") or int(cur.get("skip_seconds") or 0) != skip:
                model = f"storie-{uid}" if kind != "coin" else (recs[f["alias_of"].upper()]["json"].get("tonie_model") or "")
                newrec = {"live": False, "nocloud": True, "source": want, "skip_seconds": skip, "cache": False,
                          "cloud_ruid": cur.get("cloud_ruid") or "", "cloud_auth": cur.get("cloud_auth") or "",
                          "cloud_override": False, "tonie_model": cur.get("tonie_model") or model,
                          "hide": False, "claimed": False, "_version": 5}
                write_record(d, fn, newrec)
                log(f"{kind} {uid} -> {want} (record {d}/{fn})")
            if kind == "coin":
                created.add(uid)
            new_state = "ok"
        elif rec and int(rec["json"].get("skip_seconds") or 0) != skip:
            newrec = dict(rec["json"])
            newrec["skip_seconds"] = skip
            write_record(d, fn, newrec)
            log(f"{kind} {uid}: skip_seconds={skip}")
        if new_state and f.get("tc_state") != new_state:
            f["tc_state"] = new_state
            changed = True
    # coins removed from storie: drop the record we created (or give an original tag its cloud back)
    for uid in sorted(created - set(figs)):
        d, fn = uid_to_dir(uid)
        jp = f"{CONTENT}/{d}/{fn}.json"
        try:
            cur = json.load(open(jp))
        except Exception:
            cur = {}
        if cur.get("cloud_ruid"):
            cur.update(source="", nocloud=False, cache=False)
            write_record(d, fn, cur)
            log(f"coin {uid} removed from storie -> record {d} back to cloud content")
        else:
            subprocess.run(["docker", "exec", TC_CONTAINER, "rm", "-rf",
                            f"/teddycloud/data/content/default/{d}"], check=False)
            log(f"coin {uid} removed from storie -> record {d} deleted")
        created.discard(uid)
    json.dump(sorted(created), open(COINS_STATE, "w"))
    return changed


def sync_media_and_chapters(storie, figs, recs):
    """Phone audio follows the chosen TAF (language versions); chapters come from the TAF."""
    changed = False
    for uid, f in figs.items():
        if f.get("kind") == "coin":
            continue
        rec = recs.get(uid)
        taf = rec["taf"] if rec else None
        src = rec["json"]["source"] if rec else None
        if not taf:
            continue
        if f.get("version") and f.get("tc_source") and src == f["tc_source"] and f.get("media_of") != f["tc_source"]:
            out = tempfile.mktemp(suffix=".opus")
            try:
                taf_to_opus(taf, out)
                with open(out, "rb") as fh:
                    docker_write(f"/app/media/{uid}.opus", fh.read(), container=COMPANION_CONTAINER)
                f["file"] = f"{uid}.opus"
                f["media_of"] = f["tc_source"]
                f.pop("chapters_of", None)
                changed = True
                log(f"figurine {uid}: phone audio rebuilt from {src}")
            except Exception as e:
                log(f"ERROR rebuilding phone audio for {uid}: {e}")
            finally:
                try:
                    os.remove(out)
                except OSError:
                    pass
        if f.get("chapters_of") != src:
            f["chapters"] = taf_chapters(taf)
            f["chapters_of"] = src
            changed = True
    return changed


def versions_info(figs, recs):
    """COMPANION_DIR/versions.json: {UID: {lang: lib://...}} -> state.versions with current lang."""
    try:
        cfg = json.load(open(VERSIONS_FILE))
    except Exception:
        cfg = {}
    out = {}
    for uid, langs in cfg.items():
        uid = uid.upper()
        rec = recs.get(uid)
        cur_src = rec["json"].get("source") if rec else None
        avail = []
        for lang, src in langs.items():
            if src.startswith("lib://") and os.path.isfile(f"{LIB}/{src[6:]}"):
                avail.append({"lang": lang, "source": src})
        if avail:
            out[uid] = {"available": avail,
                        "current": next((a["lang"] for a in avail if a["source"] == cur_src), None)}
    return out


def unknown_tags(figs, recs):
    """Tags the box has seen that have no story: blank coins placed before being linked,
    the Creative Tonie, friends' figurines whose download failed."""
    out = []
    for uid, rec in recs.items():
        if uid in figs or rec["taf"]:
            continue
        if not rec["json"].get("cloud_ruid"):
            continue
        model = rec["json"].get("tonie_model") or ""
        out.append({"uid": uid, "last_seen": int(rec["mtime"]), "model": model,
                    "creative": model.startswith("09-")})
    return sorted(out, key=lambda x: -x["last_seen"])


def process_removals(storie, figs, recs):
    """storie's "removed" list: delete records + uploaded audio of removed stories/coins."""
    removed = storie.get("removed") or []
    if not removed:
        return False
    try:
        created = set(json.load(open(COINS_STATE)))
    except Exception:
        created = set()
    for uid in list(removed):
        uid = uid.upper()
        d, fn = uid_to_dir(uid)
        rec = recs.get(uid)
        if rec:
            if rec["json"].get("cloud_ruid") and uid in created:
                cur = dict(rec["json"])
                cur.update(source="", nocloud=False, cache=False)
                write_record(d, fn, cur)
            else:
                subprocess.run(["docker", "exec", TC_CONTAINER, "rm", "-rf",
                                f"/teddycloud/data/content/default/{d}"], check=False)
        subprocess.run(["docker", "exec", TC_CONTAINER, "sh", "-c",
                        f"rm -f /teddycloud/data/library/storie/{uid}-* /teddycloud/data/www/custom_img/{uid}_cover.*"],
                       check=False)
        created.discard(uid)
        log(f"removed {uid}: record and uploads deleted")
    json.dump(sorted(created), open(COINS_STATE, "w"))
    storie["removed"] = []
    return True


def run_backup(state, reason):
    """rsync storie + teddycloud data to the NAS."""
    b = state.setdefault("backup", {})
    if not BACKUP_TARGET or ":" not in BACKUP_TARGET:
        b.update(status="error: BACKUP_TARGET non configurato", reason=reason)
        return
    host, path = BACKUP_TARGET.split(":", 1)
    b["running"] = int(time.time())
    save_state(state)
    t0 = time.time()
    try:
        subprocess.run(["ssh", "-n", host, f"mkdir -p '{path}/companion' '{path}/teddycloud'"],
                       check=True, timeout=60, capture_output=True)
        subprocess.run(["rsync", "-a", "--delete", "--exclude", "state/", "--exclude", "*.log", "--exclude", "*.err",
                        f"{STORIE_DIR}/", f"{BACKUP_TARGET}/companion/"], check=True, timeout=3600, capture_output=True)
        subprocess.run(["rsync", "-a", "--delete",
                        f"{TC}/config", f"{TC}/content", f"{TC}/library", f"{TC}/custom_img", f"{TC}/certs",
                        f"{BACKUP_TARGET}/teddycloud/"], check=True, timeout=7200, capture_output=True)
        size = subprocess.run(["ssh", "-n", host, f"du -sh '{path}' | cut -f1"], capture_output=True,
                              text=True, timeout=120).stdout.strip()
        b.update(last=int(time.time()), status="ok", size=size, seconds=int(time.time() - t0), reason=reason)
        log(f"backup ok ({size}, {int(time.time() - t0)} s, {reason})")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace").strip().splitlines()
        b.update(status=("error: " + (err[-1] if err else str(e)))[:200], reason=reason)
        log(f"ERROR backup: {b['status']}")
    except Exception as e:
        b.update(status=f"error: {e}"[:200], reason=reason)
        log(f"ERROR backup: {e}")
    b.pop("running", None)


# --------------------------------------------------------------------------- main
def main():
    state = load_state()
    recs = read_records()
    storie = json.load(open(STORIE_LIB)) if os.path.isfile(STORIE_LIB) else {"figurines": []}
    figs = {f["uid"].upper(): f for f in storie["figurines"]}
    lib_changed = False

    # ---- removals requested by the app (write back right away: the list is cleared) -----
    if process_removals(storie, figs, recs):
        write_storie_library(storie)
        recs = read_records()

    # ---- teddycloud -> storie (new rips) ---------------------------------------------
    enrolled = False
    for uid, rec in recs.items():
        if uid in figs or not rec["taf"] or not rec["json"].get("cloud_ruid"):
            continue
        known = tonies_title(rec["audio_id"])
        title = known or f"Nuova storia {rec['audio_id']}"
        out = tempfile.mktemp(suffix=".opus")
        try:
            taf_to_opus(rec["taf"], out)
            r = enroll(uid, title, out, needs_title=not known)
            log(f"enrolled {uid} in storie as '{r.get('title')}' from {os.path.basename(rec['taf'])}")
            enrolled = True
        except Exception as e:
            log(f"ERROR enrolling {uid}: {e}")
        finally:
            try:
                os.remove(out)
            except OSError:
                pass
        if not rec["json"].get("nocloud"):
            try:
                c = dict(rec["json"])
                c.update(nocloud=True, live=False, cloud_override=False, cache=True)
                write_record(rec["dir"], rec["file"], c)
                log(f"pinned {rec['dir']} -> {os.path.basename(rec['taf'])} (nocloud)")
            except Exception as e:
                log(f"ERROR pinning {rec['dir']}: {e}")
    if enrolled:
        storie = json.load(open(STORIE_LIB))
        figs = {f["uid"].upper(): f for f in storie["figurines"]}

    # ---- records for coins / uploads / versions / skip seconds -----------------------
    if sync_records(storie, figs, recs):
        lib_changed = True
    recs = read_records()
    if sync_media_and_chapters(storie, figs, recs):
        lib_changed = True

    # ---- storie -> teddycloud (tonies.custom.json + tonie_model) ----------------------
    os.makedirs(CUSTOM_IMG, exist_ok=True)
    custom = []
    for n, (uid, f) in enumerate(sorted(figs.items())):
        rec = recs.get(uid)
        if f.get("kind") == "coin" or not rec or not rec["taf"]:
            continue
        title = f.get("title") or "Untitled"
        series = f.get("series") or "Storie"
        pic = ""
        cover = f.get("cover")
        if cover and os.path.isfile(f"{STORIE_MEDIA}/{cover}"):
            src, dst = f"{STORIE_MEDIA}/{cover}", f"{CUSTOM_IMG}/{cover}"
            if not os.path.isfile(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
                shutil.copy2(src, dst)
            pic = f"/custom_img/{cover}"
        model = f"storie-{uid}"
        custom.append({
            "no": str(n), "model": model,
            "audio_id": [str(rec["audio_id"])], "hash": [rec["hash"].upper()],
            "title": f"{series} - {title}", "series": series, "episodes": title, "tracks": [],
            "release": str(int(os.path.getmtime(rec["taf"]))), "language": f.get("version") or LANG,
            "category": "custom", "pic": pic,
        })
        if rec["json"].get("tonie_model", "") == "":
            c = dict(rec["json"])
            c["tonie_model"] = model
            write_record(rec["dir"], rec["file"], c)
            log(f"set tonie_model={model} on {rec['dir']}")
    try:
        old = json.load(open(CUSTOM_JSON))
    except Exception:
        old = None
    if old != custom:
        docker_write("/teddycloud/config/tonies.custom.json",
                     json.dumps(custom, indent=1, ensure_ascii=False).encode())
        try:
            urllib.request.urlopen(f"{TC_API}/api/toniesJsonReload", timeout=30).read()
        except Exception as e:
            log(f"WARN toniesJsonReload: {e}")
        log(f"tonies.custom.json updated ({len(custom)} entries): " + ", ".join(e["episodes"] for e in custom))

    # ---- state for the app -------------------------------------------------------------
    parse_box_log(state)
    state["box"] = box_info(state, figs)
    led_schedule(state, storie)
    state["status"] = download_status(state, figs, recs)
    state["versions"] = versions_info(figs, recs)
    state["box_unknown"] = unknown_tags(figs, recs)

    # ---- backup (requested from the app, or --backup from the nightly cron) ------------
    req = (storie.get("requests") or {}).get("backup")
    if "--backup" in sys.argv:
        run_backup(state, "nightly")
    elif req and req != state.get("backup", {}).get("request"):
        state.setdefault("backup", {})["request"] = req
        run_backup(state, "app")
    save_state(state)

    if lib_changed:
        write_storie_library(storie)


if __name__ == "__main__":
    main()
