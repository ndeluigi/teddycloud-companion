# teddycloud companion

The phone side of a [teddycloud](https://github.com/toniebox-reverse-engineering/teddycloud)
setup: a small password‑protected web app (PWA) plus an Android app that turn your ripped
Tonies into a family story player, and make the phone the front door of teddycloud for the
everyday jobs — coins, uploads, "is everything on the box before we travel?", a night light
switch — so nobody has to open teddycloud's own admin page.

```
 phone (PWA / Android app)  ──HTTPS──▶  companion server (FastAPI, docker)
   tap a figurine / coin                 │  library.json + media/ (opus for the phone)
   play, chapters, lock‑screen           │  state/ (written by tc_sync.py)
   admin: coins, uploads, travel…        ▼
                              tc_sync.py (cron on the teddycloud host, every minute)
                                         │  reads/writes teddycloud content records,
                                         │  library TAFs, tonies.custom.json, docker logs
                                         ▼
                              teddycloud ◀──── Toniebox (unchanged)
```

## What it does

**For the kids**
- Home screen with big story tiles; tap a figurine (or a coin) on the phone to play its story.
  Web NFC in Chrome, or native NFC in the Android app.
- Player with chapters (from the TAF track markers), ±15 s, skip‑intro, covers. The Android app
  keeps playing with the screen off and shows lock‑screen controls.
- A second, listen‑only password for friends: stories and player, nothing else.

**For the parent (menu / bottom tabs)**
- **Coins** — link a blank SLIX‑L tag (or the Creative Tonie) to any story in three taps, before
  or after the box has seen it. tc_sync creates the teddycloud record; the box plays it.
- **Upload a story** — any audio file: the phone gets it immediately, teddycloud encodes it to
  a TAF, the box gets a record. Every story can go on a coin.
- **Travel checklist** — which stories the box has actually downloaded (from its own freshness
  reports), so the offline holiday works.
- **Toniebox** — online/last contact/last story, LED on/dimmed/off, backup to a NAS.
- **Stories** — rename, cover, language version chips (one figurine, several TAFs), skip‑intro
  seconds, remove (cleans the box record and uploads too).
- **Record a story** from the phone's microphone; **offline stories** on the phone (browser cache
  or the app's storage) for trips; **sleep timer**; resume where you left off; **kids lock**;
  printable **coin labels**; **listening history** from the box; **bedtime LED schedule**.
- New rips are announced with a "give it a name" banner; titles and covers flow back into
  teddycloud's `tonies.custom.json`, so both UIs show the same names and pictures.

## What you need

- teddycloud running in Docker with your Toniebox connected to it (certificates extracted,
  DNS redirected). This project does not do that part — the
  [teddycloud docs](https://tonies-wiki.revvox.de/docs/tools/teddycloud/) do.
- The teddycloud host runs the companion server (Docker) and `sync/tc_sync.py` (cron), and can
  see teddycloud's data directory and its container.
- HTTPS in front of the companion if you want it reachable from outside (any reverse proxy or
  tunnel; the login cookie is `Secure`).
- For the Android app: a PC with the Android SDK (see `android/README.md`).

## Quick start

```bash
git clone https://github.com/ndeluigi/teddycloud-companion ~/teddycloud-companion
cd ~/teddycloud-companion
cp .env.example .env && nano .env          # passwords, teddycloud dir/container, URL
docker compose up -d --build               # companion server on :8080 (put HTTPS in front)
./sync/install.sh                          # cron: tc_sync every minute + nightly backup
```

Open the site, log in, place a figurine on the box: within a minute it appears in the app
with its cover if the community catalog knows it, or with a "give it a name" banner.

Details, configuration keys and the coin/travel/language workflows: [docs/SETUP.md](docs/SETUP.md).
What the app does, feature by feature, in four languages: [docs/GUIDE.md](docs/GUIDE.md) (the same
text is available inside the app under Menu → Guide).

## Repository layout

| path | what |
|---|---|
| `server/` | FastAPI engine + PWA (`static/`). Docker image. |
| `sync/tc_sync.py` | the bridge between the companion and teddycloud (cron, idempotent) |
| `sync/tc_pin.sh`, `tc_fetch.sh`, `tc_rip_lang.sh`, `taf_ids.py`, `import_taf.sh` | helpers: pin a record to a TAF, pull the current cloud version of a figurine, rip another language version, print a tonies‑json id block, import a TAF |
| `android/` | Android app (WebView + native NFC + background player + self‑update) |
| `scripts/publish_apk.ps1` | build, sign, publish the APK to your server |
| `docs/` | setup guide, user guide (generated from the in-app guide), teddycloud macvlan example |
| `scripts/gen_guide_md.js` | regenerates `docs/GUIDE.md` from `server/static/guide.js` |

## Honest notes

- UI in Italian, German, French and English (menu → Settings, and on the login page; the
  browser language is the default). Translations live in `server/static/i18n.js`, keyed by
  the Italian source strings — adding a language is one more block there.
- No audio is included and none will be: TAF files are the copyrighted audio of the Tonies
  you own. The companion only moves your own rips between your own devices.
- Tested with a Toniebox 1 (CC3200) on original firmware. teddycloud's LED setting works on
  it; there is no volume cap on that firmware.

## License

MIT — see [LICENSE](LICENSE).
