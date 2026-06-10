#!/usr/bin/env bash
# Install systemd reliability units/drop-ins for the current checkout.
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUN_USER="${TVCLONE_RUN_USER:-$(id -un)}"
APP_SERVICE="${TVCLONE_SERVICE:-tvclone-prod.service}"
ORG_SERVICE="${ORGANIZER_SERVICE:-tvclone-organizer.service}"
DOCKER_SERVICE="${DOCKER_MEDIA_SERVICE:-docker-media.service}"
MEDIA_DIRS="${TVCLONE_REQUIRED_MEDIA_DIRS:-/mnt/media/Movies,/mnt/media/TV}"
DOWNLOAD_DIR="${TVCLONE_DOWNLOAD_DIR:-/mnt/media/Share}"
MOUNTS="$(printf '%s,%s' "$MEDIA_DIRS" "$DOWNLOAD_DIR" | tr ',' ' ')"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -n "$0" "$REPO_DIR"
fi

install -d /etc/tvclone
install -d "/etc/systemd/system/$APP_SERVICE.d" "/etc/systemd/system/$ORG_SERVICE.d" "/etc/systemd/system/$DOCKER_SERVICE.d"

cat >/etc/tvclone/tvclone.env <<EOF
PORT=4800
TVCLONE_SERVICE=$APP_SERVICE
ORGANIZER_SERVICE=$ORG_SERVICE
DOCKER_MEDIA_SERVICE=$DOCKER_SERVICE
TVCLONE_REPO_DIR=$REPO_DIR
TVCLONE_REQUIRED_MEDIA_DIRS=$MEDIA_DIRS
TVCLONE_DOWNLOAD_DIR=$DOWNLOAD_DIR
TVCLONE_DOCKER_CONTAINERS=gluetun,qbittorrent
TVCLONE_BACKUP_ROOT=$REPO_DIR/data_backups
ORGANIZER_LOG=$REPO_DIR/media-organizer/media-organizer.log
QBT_URL=http://127.0.0.1:8080
EOF

cat >"/etc/systemd/system/$APP_SERVICE.d/reliability.conf" <<EOF
[Unit]
Wants=network-online.target $DOCKER_SERVICE
After=network-online.target local-fs.target $DOCKER_SERVICE
RequiresMountsFor=$MOUNTS

[Service]
EnvironmentFile=-/etc/tvclone/tvclone.env
ExecStartPre=/usr/bin/node $REPO_DIR/scripts/tvclone-reliability.js preflight --repo $REPO_DIR
Restart=always
RestartSec=10
TimeoutStartSec=180
TimeoutStopSec=45
MemoryHigh=5G
MemoryMax=6G
MemorySwapMax=2G
TasksMax=512
EOF

cat >"/etc/systemd/system/$ORG_SERVICE.d/reliability.conf" <<EOF
[Unit]
Wants=network-online.target
After=network-online.target local-fs.target $APP_SERVICE
RequiresMountsFor=$MOUNTS

[Service]
EnvironmentFile=-/etc/tvclone/tvclone.env
Environment=TVCLONE_REPO_DIR=$REPO_DIR
Environment=TVCLONE_ORGANIZER_SCRIPT=$REPO_DIR/media-organizer/movie_renamer.py
ExecStart=
ExecStart=$REPO_DIR/scripts/run-organizer-safe.sh
Restart=always
RestartSec=10
TimeoutStartSec=120
MemoryHigh=1G
MemoryMax=2G
EOF

cat >"/etc/systemd/system/$DOCKER_SERVICE.d/reliability.conf" <<EOF
[Unit]
Wants=network-online.target
After=network-online.target docker.service snap.docker.dockerd.service
StartLimitIntervalSec=180
StartLimitBurst=3

[Service]
Restart=on-failure
RestartSec=15
TimeoutStartSec=180
EOF

cat >/etc/systemd/system/tvclone-boot-repair.service <<EOF
[Unit]
Description=TV-Clone Boot Repair
Wants=network-online.target
After=network-online.target local-fs.target $DOCKER_SERVICE
RequiresMountsFor=$MOUNTS

[Service]
Type=oneshot
User=root
EnvironmentFile=-/etc/tvclone/tvclone.env
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/node $REPO_DIR/scripts/tvclone-reliability.js boot-repair --repo $REPO_DIR
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/tvclone-watchdog.service <<EOF
[Unit]
Description=TV-Clone Watchdog
Wants=network-online.target
After=network-online.target local-fs.target

[Service]
Type=oneshot
User=root
EnvironmentFile=-/etc/tvclone/tvclone.env
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/node $REPO_DIR/scripts/tvclone-reliability.js watchdog --repo $REPO_DIR
TimeoutStartSec=180
EOF

cat >/etc/systemd/system/tvclone-watchdog.timer <<EOF
[Unit]
Description=Run TV-Clone Watchdog Every Minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
Persistent=true
Unit=tvclone-watchdog.service

[Install]
WantedBy=timers.target
EOF

cat >/etc/systemd/system/tvclone-backup.service <<EOF
[Unit]
Description=TV-Clone Data Backup
After=local-fs.target

[Service]
Type=oneshot
User=$RUN_USER
EnvironmentFile=-/etc/tvclone/tvclone.env
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/node $REPO_DIR/scripts/tvclone-reliability.js backup --repo $REPO_DIR
TimeoutStartSec=300
EOF

cat >/etc/systemd/system/tvclone-backup.timer <<EOF
[Unit]
Description=Back Up TV-Clone Data Daily

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=15min
Persistent=true
Unit=tvclone-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable "$APP_SERVICE" "$ORG_SERVICE" "$DOCKER_SERVICE" tvclone-boot-repair.service tvclone-watchdog.timer tvclone-backup.timer >/dev/null
systemctl restart "$APP_SERVICE" "$ORG_SERVICE"
systemctl start tvclone-watchdog.timer tvclone-backup.timer

echo "[tvclone] systemd reliability installed for $REPO_DIR"
