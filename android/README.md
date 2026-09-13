# Android app

A Kotlin shell around your companion site. What it adds over the browser:

- **NFC** in reader mode (ISO 15693): every figurine or coin held to the phone is handed to the
  page as `StorieNative.onTag(uid)`. Android WebView has no Web NFC, so this is the only way
  the app can read tags.
- **Background audio**: the page plays through `StorieApp.play(...)`, which runs ExoPlayer in a
  media-session service — playback survives the screen turning off, with lock-screen and
  notification controls (±15 s), and pauses when headphones are unplugged. Requests carry the
  WebView's session cookie (the site is password-protected).
- **Self-update**: on launch the app fetches `/storie.apk.json` `{versionCode, versionName,
  sha256}`; if newer, it downloads `/storie.apk`, verifies the hash and opens the installer
  (one confirmation tap; first time Android asks to allow installs from the app).
- **System bars**: the app measures the window insets and hands them to the page as the CSS
  variables `--safetop/--safebot/--safeleft/--saferight` (the page defines them from
  `env(safe-area-inset-*)` for browsers), so header and tab bar never sit under Android's bars.

## Configure

```
cp companion.properties.example companion.properties     # gitignored
```

- `site` — your companion URL (baked in as `BuildConfig.SITE`)
- `applicationId` — the package name; pick it once and never change it
- `appName` — launcher label
- `deployHost`, `deployDir` — where `scripts/publish_apk.ps1` copies the APK (the directory the
  server serves `/storie.apk` from, i.e. `apps/` in the repo dir on the host)

Signing key: create `keystore/storie.keystore` + `keystore/keystore.properties`
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), both gitignored:

```
keytool -genkeypair -v -keystore keystore/storie.keystore -alias storie -keyalg RSA -keysize 2048 -validity 10000
```

**Back the key up.** Android only installs an update signed with the same key; a new key means
every phone uninstalls and starts over.

## Build & publish (Windows PC with the Android SDK, JDK 17+)

1. bump `versionCode` **and** `versionName` in `app/build.gradle.kts`
2. `powershell -ExecutionPolicy Bypass -File scripts\publish_apk.ps1`

The script builds the signed release, verifies the signer, writes the sidecar and copies both
to `deployHost:deployDir`. Phones are offered the update on their next launch. First install:
open the site in Chrome → menu "Altro" → "Scarica l'app Android".
