#!/usr/bin/env bash
# Convert a teddycloud .taf to .opus and enroll it into the Storie PWA library,
# so the same ripped audio plays on BOTH the Toniebox and the phone/PWA.
#
#   ./import_to_storie.sh <file.taf> "<UID>" "<title>" [cover.(jpg|png)]
#
# A .taf is: [4 bytes big-endian header length L][L-byte protobuf header][Ogg Opus].
# We strip the header to recover the Opus stream, remux it clean with a throwaway
# ffmpeg container (no system ffmpeg needed), then POST to the storie /enroll API.
set -euo pipefail

TAF="${1:?path to .taf}"; UID_ARG="${2:?figurine UID}"; TITLE="${3:?title}"; COVER="${4:-}"
STORIE="${COMPANION_URL:?set COMPANION_URL, e.g. https://storie.example.com}"
FFMPEG_IMG="mwader/static-ffmpeg:latest"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cp "$TAF" "$work/in.taf"

# header length L = first 4 bytes, big-endian
L=$(od -An -N4 -tu1 "$work/in.taf" | awk '{print ($1*16777216)+($2*65536)+($3*256)+$4}')
offset=$((4 + L))
echo "TAF header length: $L bytes; Opus starts at offset $offset"
dd if="$work/in.taf" of="$work/raw.opus" bs=1 skip="$offset" status=none

# remux to a clean Ogg/Opus file (copy, no re-encode)
docker run --rm -v "$work:/work" "$FFMPEG_IMG" \
  -hide_banner -loglevel error -i /work/raw.opus -c:a copy /work/out.opus
echo "converted -> $(du -h "$work/out.opus" | cut -f1) opus"

# enroll into storie
args=(-s -X POST "$STORIE/enroll" -H "X-Storie-Password: ${COMPANION_PASSWORD:-}"
      -F "uid=$UID_ARG" -F "title=$TITLE"
      -F "audio=@$work/out.opus;type=audio/ogg")
[ -n "$COVER" ] && args+=(-F "cover=@$COVER")
echo "enrolling into $STORIE …"
curl "${args[@]}" | sed 's/.*/  &/'
echo
echo "Done. Tap the figurine on the phone (or its blank travel tag) to play."
