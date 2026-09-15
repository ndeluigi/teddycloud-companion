#!/bin/bash
# Rip ONE language version of a figurine through teddycloud, then re-pin the figurine.
#
# Before running: in the Tonies app select the wanted language for that figurine
# (place the Pocket Tonie on the box, pick the language in the dropdown). The cloud then
# serves that version under a new audio-id.
#
# usage: tc_rip_lang.sh <contentDir e.g. 65EF4F2B> [<audioId to pin back afterwards>]
# Needs tc_fetch.sh, tc_pin.sh and taf_ids.py next to it. TEDDYCLOUD_DIR defaults to ~/teddycloud.
set -e
here=$(cd "$(dirname "$0")" && pwd)
TC=${TEDDYCLOUD_DIR:-$HOME/teddycloud}
TC_CONTAINER=${TEDDYCLOUD_CONTAINER:-teddycloud}
d=$1; pin=$2
j=$TC/content/default/$d/500304E0.json
lib=$TC/library/by/audioID
[ -f "$j" ] || { echo "no content record for $d"; exit 1; }
ruid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['cloud_ruid'])" "$j")
auth=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['cloud_auth'])" "$j")
before=$(ls "$lib")

# 1. let teddycloud go to the cloud again for this figurine
python3 - "$j" <<'PY' > /tmp/unpin.json
import sys,json
c=json.load(open(sys.argv[1])); c["nocloud"]=False; c["cache"]=True; c["live"]=False
json.dump(c,sys.stdout,indent=1)
PY
docker exec -i "$TC_CONTAINER" sh -c "cat > /teddycloud/data/content/default/$d/500304E0.json" < /tmp/unpin.json

# 2. fetch the current cloud version (as the box would); teddycloud caches it to the library
"$here/tc_fetch.sh" "$ruid" "$auth"
sleep 3

# 3. show the new TAF's id block
new=$(comm -13 <(echo "$before") <(ls "$lib"))
if [ -z "$new" ]; then
  echo "no new TAF appeared (same version as an existing one, or the download failed) - check: docker logs $TC_CONTAINER | tail -50"
else
  for f in $new; do python3 "$here/taf_ids.py" "$lib/$f"; done
fi

# 4. re-pin (nocloud) so the box keeps playing the chosen version
[ -n "$pin" ] && "$here/tc_pin.sh" "$d" "$pin"
