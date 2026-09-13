# Setup

## 0. Prerequisites

- teddycloud in Docker, your Toniebox talking to it (certificates extracted, DNS for
  `prod.de.tbs.toys` / `rtnl.bxcl.de` pointing at teddycloud). If teddycloud needs its own LAN
  IP because something else already holds the host's port 443, see
  [teddycloud-macvlan.example.sh](teddycloud-macvlan.example.sh).
- On the host: Docker, Python 3, `flock`, and `rsync` + an ssh alias if you want backups.
- The ffmpeg image `mwader/static-ffmpeg` is pulled on first use (TAF → opus for the phone).

## 1. Server

```bash
git clone https://github.com/ndeluigi/teddycloud-companion ~/teddycloud-companion
cd ~/teddycloud-companion
cp .env.example .env && nano .env
docker compose up -d --build
```

Keys in `.env`:

| key | meaning |
|---|---|
| `COMPANION_PASSWORD` | family password (full access) |
| `COMPANION_GUEST_PASSWORD` | optional listen-only password for friends |
| `TEDDYCLOUD_URL` | teddycloud's web port as seen from inside the companion container |
| `COMPANION_NETWORK` | docker network to join — use teddycloud's to reach it by name |
| `COMPANION_DIR`, `TEDDYCLOUD_DIR`, `TEDDYCLOUD_CONTAINER`, `TEDDYCLOUD_API` | for `tc_sync.py` on the host |
| `PUBLIC_URL` | your HTTPS address (used by helper scripts and as a fallback) |
| `BACKUP_TARGET` | `sshalias:path` for the backup button and the nightly backup |

Put HTTPS in front of port 8080 (Caddy, nginx, a Cloudflare tunnel…). The login cookie is
`Secure`, so plain HTTP only works for the header-based automation, not for browsers.
Never expose teddycloud's own web UI publicly: it has no login.

## 2. Sync job

```bash
./sync/install.sh
```

installs two cron lines (every minute under `flock`; nightly `--backup` at 03:30) and runs the
first sync. Log: `tc_sync.log` in the repo dir. What it does each minute:

1. **New rips** — a teddycloud record with a library TAF that the companion does not know yet
   is converted to opus and enrolled (title from `tonies.json` if the audio id is known,
   otherwise a placeholder flagged "needs a name"). The record is pinned (`nocloud`), so the box
   keeps that version — choose the language in the Tonies app *before* the first placement.
2. **Uploads / coins / language versions / skip‑intro** — mirrored into teddycloud records.
3. **Titles and covers** — written to `tonies.custom.json` and reloaded, so teddycloud's UI shows
   the same names and pictures.
4. **State for the app** — box status and downloads (parsed from teddycloud's docker log),
   unknown tags the box saw, language versions, last backup → `state/tc_state.json`.
5. **Removals / backup requests** coming from the app.

## 3. Phone

Open the site in Chrome, log in, "add to home screen" — or install the Android app
(menu → "Scarica l'app Android") for native NFC and background playback. See
[../android/README.md](../android/README.md) to build and publish it for your own domain.

## Workflows

**Coins (blank SLIX‑L tags, or the Creative Tonie).** Menu → Gettoni. Read the coin with the
phone *before* the box ever sees it (the box switches new tags into privacy mode, after which
phones cannot read them), pick a story, put it on the box. If the box saw it first, it shows up
under "Visti dalla Toniebox" and can be linked from there. Only tags with a UID starting
`E0 04 03` (ICODE SLIX‑L) work on a Toniebox.

**Language versions.** `versions.json` in the repo dir maps a figurine to its TAFs:

```json
{ "E00403AABBCCDDEE": { "it-it": "lib://by/audioID/123.taf", "fr-fr": "lib://other/456.taf" } }
```

The app shows chips; switching rewrites the box record and rebuilds the phone audio.
`sync/tc_rip_lang.sh` pulls another language version through teddycloud after you switched the
language in the Tonies app.

**Travel.** Menu → "Pronti per il viaggio?" lists what the box has downloaded. For anything
missing, place the figurine or coin on the box (hold the big ear 3 s to force a check).

**Contributing to tonies‑json.** `sync/taf_ids.py <file.taf>` prints the `ids:` block
(audio‑id, hash, size, tracks) the [community catalog](https://github.com/toniebox-reverse-engineering/tonies-json)
expects.
