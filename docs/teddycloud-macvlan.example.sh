#!/usr/bin/env bash
# Example: launch teddycloud with its own LAN IP (macvlan) next to the companion.
# Fill in the variables below for your network.
LAN_IF=eth0; LAN_SUBNET=192.168.0.0/24; LAN_GW=192.168.0.1; TC_IP=192.168.0.250
TEDDYCLOUD_DIR=$HOME/teddycloud; DOCKER_NET=companion_net
#
# Networking:
#   - ${DOCKER_NET} (bridge, shared with the companion): web UI published on 8095 (http) / 8443 (https-admin).
#     LAN/Tailscale only — teddycloud has NO login, never put it on the public tunnel.
#   - tonie_lan (macvlan on ${LAN_IF}): teddycloud gets its OWN LAN IP ${TC_IP} so it can
#     own :443 for the Toniebox without fighting a reverse proxy that already holds the host's 80/443.
#     Note: the host itself cannot reach a macvlan IP; test from another LAN device (e.g. the NAS).
#
# Data lives under ~/teddycloud (bind mounts) so it survives container recreation.
#   - --dns 1.1.1.1: the LAN Pi-holes redirect prod.de.tbs.toys to teddycloud itself (for the box);
#     teddycloud must resolve Boxine's REAL address for cloud passthrough, so it gets its own DNS.
set -e

docker network inspect tonie_lan >/dev/null 2>&1 || docker network create -d macvlan \
  --subnet=${LAN_SUBNET} --gateway=${LAN_GW} --ip-range=${TC_IP}/32 \
  -o parent=${LAN_IF} tonie_lan

docker rm -f teddycloud 2>/dev/null || true
docker run -d --name teddycloud --restart unless-stopped \
  --network ${DOCKER_NET} \
  -p 8095:80 \
  -p 8443:8443 \
  -v ${TEDDYCLOUD_DIR}/certs:/teddycloud/certs \
  -v ${TEDDYCLOUD_DIR}/config:/teddycloud/config \
  -v ${TEDDYCLOUD_DIR}/content:/teddycloud/data/content \
  -v ${TEDDYCLOUD_DIR}/library:/teddycloud/data/library \
  -v ${TEDDYCLOUD_DIR}/firmware:/teddycloud/data/firmware \
  -v ${TEDDYCLOUD_DIR}/custom_img:/teddycloud/data/www/custom_img \
  ghcr.io/toniebox-reverse-engineering/teddycloud:latest
docker network connect --ip ${TC_IP} tonie_lan teddycloud

echo "teddycloud up. Web UI: http://<host>:8095  |  box endpoint: ${TC_IP}:443"
