#!/bin/bash
# Pin a figurine's teddycloud record to one library TAF and stop cloud refresh churn.
# usage: tc_pin.sh <contentDir e.g. EF6B602B> <audioId e.g. 522713252>
TC=${TEDDYCLOUD_DIR:-$HOME/teddycloud}
TC_CONTAINER=${TEDDYCLOUD_CONTAINER:-teddycloud}
d=$1; id=$2; j=$TC/content/default/$d/500304E0.json
[ -f "$j" ] || { echo "no record for $d"; exit 1; }
[ -f "$TC/library/by/audioID/$id.taf" ] || { echo "no TAF $id in the library"; exit 1; }
python3 - "$j" "$id" <<'PY' > /tmp/pin.json
import sys, json
j, id = sys.argv[1], sys.argv[2]
c = json.load(open(j))
c["source"] = f"lib://by/audioID/{id}.taf"; c["nocloud"] = True; c["live"] = False
c["cloud_override"] = False; c["cache"] = True
json.dump(c, sys.stdout, indent=1)
PY
docker exec -i "$TC_CONTAINER" sh -c "cat > /teddycloud/data/content/default/$d/500304E0.json" < /tmp/pin.json \
  && echo "pinned $d -> $id (nocloud=true)"
