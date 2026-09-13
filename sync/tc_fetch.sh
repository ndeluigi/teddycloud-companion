#!/bin/bash
# Fetch the CURRENT cloud version of a figurine through teddycloud, exactly as the box would,
# so teddycloud caches it to the library and points the record at it. Uses the box's client
# certificate (the one you extracted for teddycloud) against teddycloud's box endpoint.
#
# usage: tc_fetch.sh <rUID> <cloud_auth> [<rUID> <cloud_auth> ...]
#   rUID / cloud_auth: from the record json (cloud_ruid / cloud_auth) once the box placed the tag.
# env: TEDDYCLOUD_BOX_IP  IP where teddycloud answers on :443 for the box (default: 127.0.0.1;
#                         with a macvlan the host itself cannot reach it - run this from another
#                         machine on the LAN, or point it at the container's bridge IP)
#      BOX_CERT_PEM / BOX_KEY_PEM  client cert + key in PEM (default: ./box-client.pem / ./box-private.pem)
ip=${TEDDYCLOUD_BOX_IP:-127.0.0.1}
crt=${BOX_CERT_PEM:-./box-client.pem}
key=${BOX_KEY_PEM:-./box-private.pem}
while [ $# -ge 2 ]; do
  ruid=$1; auth=$2; shift 2
  echo "--- fetching $ruid ---"
  curl -sk --cert "$crt" --key "$key" --resolve "prod.de.tbs.toys:443:$ip" \
    -H "Authorization: BD $auth" -o /dev/null \
    -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}s\n' -m 600 \
    "https://prod.de.tbs.toys/v2/content/$ruid"
done
