#!/usr/bin/env bash
# Install the cron jobs for tc_sync.py on the teddycloud host:
#   every minute (under flock, so a long run never overlaps) and a nightly backup at 03:30.
# Run from the repository root after filling in .env (COMPANION_DIR must point here).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
py=$(command -v python3)
for tool in docker flock rsync; do command -v $tool >/dev/null || echo "warning: $tool not found"; done
mkdir -p "$root/media" "$root/state" "$root/apps"
[ -f "$root/library.json" ] || printf '{\n  "figurines": []\n}\n' > "$root/library.json"
chmod +x "$here"/*.sh
line1="* * * * * COMPANION_DIR=$root flock -n /tmp/tc_sync.lock $py $here/tc_sync.py >/dev/null 2>>$root/tc_sync.err # teddycloud companion sync"
line2="30 3 * * * COMPANION_DIR=$root flock -w 600 /tmp/tc_sync.lock $py $here/tc_sync.py --backup >/dev/null 2>>$root/tc_sync.err # teddycloud companion backup"
( crontab -l 2>/dev/null | grep -v "teddycloud companion"; echo "$line1"; echo "$line2" ) | crontab -
echo "installed:"; crontab -l | grep "teddycloud companion"
echo "first run:"; COMPANION_DIR=$root $py "$here/tc_sync.py"
