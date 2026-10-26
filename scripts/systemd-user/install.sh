#!/bin/bash
# Installs the weekly container update as a user timer (no sudo) and records the current versions
# so the Dashboard has them right away. Safe to run again.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
install -m 644 "$here/chochey-container-update.service" "$here/chochey-container-update.timer" "$dest/"
systemctl --user daemon-reload
systemctl --user enable --now chochey-container-update.timer
DOCKER_HOST=unix:///var/run/docker.sock TVCLONE_DATA_DIR=/srv/chocheytv/data \
  /usr/bin/node /srv/chocheytv/app/scripts/update-containers.js --status
systemctl --user list-timers chochey-container-update.timer --no-pager
