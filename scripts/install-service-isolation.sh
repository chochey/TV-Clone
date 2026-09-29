#!/usr/bin/env bash
# Run as root after deploying the tested checkout. Does not restart the app.
set -euo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run this installer as root.' >&2; exit 1; fi
REPO_DIR="${1:?Pass the production checkout path}"
CONTROL_COMPOSE_DIR="${2:-/home/blue/Desktop/Repos/Docker-Media}"
RUN_USER=chocheytv
INSTALL_BACKUP="${3:-/var/backups/tvclone-isolation-$(date +%Y%m%d-%H%M%S)}"
if [[ -L "$REPO_DIR/data" || -L "$REPO_DIR/transcode_tmp" ]]; then echo "State directories must be regular directories" >&2; exit 1; fi
install -d -m 0700 "$INSTALL_BACKUP"
getfacl -Rp "$REPO_DIR/data" "$REPO_DIR/transcode_tmp" >"$INSTALL_BACKUP/access.acl"
getfacl -p /home/blue /media/blue "$REPO_DIR/media-organizer/config.py" "$REPO_DIR/media-organizer/organizer_aliases.json" >>"$INSTALL_BACKUP/access.acl"
cp -a /etc/systemd/system/tvclone-prod.service.d "$INSTALL_BACKUP/app-dropins"
cp -a "$REPO_DIR/config.json" "$INSTALL_BACKUP/config.json"
cp -a "$REPO_DIR/media-organizer/movie_renamer.py" "$INSTALL_BACKUP/movie_renamer.py"
getent group "$RUN_USER" >/dev/null || groupadd --system "$RUN_USER"
if id "$RUN_USER" >/dev/null 2>&1; then
  [[ $(getent passwd "$RUN_USER" | cut -d: -f6-7) == /nonexistent:/usr/sbin/nologin ]] || { echo "Existing account needs review" >&2; exit 1; }
else
  useradd --system --gid "$RUN_USER" --home-dir /nonexistent --shell /usr/sbin/nologin "$RUN_USER"
fi
# No sudo, login, Docker group or raw disk group membership.
usermod -G render,video "$RUN_USER"
setfacl -m "u:$RUN_USER:--x" /home/blue
setfacl -m "u:$RUN_USER:r-x" /media/blue
setfacl -Rm "u:$RUN_USER:rwX" "$REPO_DIR/data" "$REPO_DIR/transcode_tmp"
find "$REPO_DIR/data" "$REPO_DIR/transcode_tmp" -type d -exec setfacl -m "d:u:$RUN_USER:rwx,d:u:blue:rwx" {} +
setfacl -m "u:$RUN_USER:r--" "$REPO_DIR/media-organizer/config.py"
setfacl -m "u:$RUN_USER:rw-" "$REPO_DIR/media-organizer/organizer_aliases.json"
# Atomic config saves need a writable parent. Keep the familiar config path.
if [[ ! -L "$REPO_DIR/config.json" ]]; then
  cp -a "$REPO_DIR/config.json" "$REPO_DIR/data/config.json"
  setfacl -m "u:$RUN_USER:rw-" "$REPO_DIR/data/config.json"
  mv "$REPO_DIR/config.json" "$INSTALL_BACKUP/config.original.json"
  ln -s data/config.json "$REPO_DIR/config.json"
fi
install -d -m 0755 /usr/local/libexec/tvclone
install -m 0755 "$REPO_DIR/scripts/tvclone-control-helper.js" /usr/local/libexec/tvclone/control-helper.js
install -d -m 0700 /etc/tvclone
# Freeze the privileged compose input; the web account cannot edit it.
python3 - "$CONTROL_COMPOSE_DIR" <<'PY'
import json,subprocess,sys,os
from pathlib import Path
root=Path(sys.argv[1])
p=subprocess.run(['/usr/bin/docker','compose','config'],cwd=root,capture_output=True,text=True,check=True)
Path('/etc/tvclone/control-compose.yml').write_text(p.stdout)
os.chmod('/etc/tvclone/control-compose.yml',0o600)
block=json.loads(subprocess.check_output(['lsblk','-J','-dn','-o','NAME,TYPE']))
devices=['/dev/'+r['name'] for r in block['blockdevices'] if r['type']=='disk']
Path('/etc/tvclone/control.json').write_text(json.dumps({'docker':'/usr/bin/docker','compose':'/etc/tvclone/control-compose.yml','devices':devices}))
os.chmod('/etc/tvclone/control.json',0o600)
PY
# Dry-run previews should only log to their captured console, never to Desktop.
python3 - "$REPO_DIR/media-organizer/movie_renamer.py" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
needle='for _log_path in [_log_dir / "media-organizer.log", _desktop_dir / "media-organizer.log"]:\n'
if 'if os.environ.get("ORGANIZER_PREVIEW") == "1":' not in s:
    if needle not in s: raise SystemExit('Organizer logging changed; review needed')
    s=s.replace(needle,needle+'    if os.environ.get("ORGANIZER_PREVIEW") == "1":\n        break\n',1)
    p.write_text(s)
PY
cat >/etc/systemd/system/tvclone-control.service <<'UNIT'
[Unit]
Description=Restricted ChocheyTV system controls
After=docker.service
[Service]
Type=simple
User=root
Group=chocheytv
RuntimeDirectory=tvclone-control
RuntimeDirectoryMode=0750
ExecStart=/usr/bin/node /usr/local/libexec/tvclone/control-helper.js
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=/run/tvclone-control
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
[Install]
WantedBy=multi-user.target
UNIT
cat >"/etc/systemd/system/tvclone-prod.service.d/isolation.conf" <<UNIT
[Unit]
Wants=tvclone-control.service
After=tvclone-control.service
[Service]
User=$RUN_USER
Group=$RUN_USER
SupplementaryGroups=render video
Environment=TVCLONE_CONTROL_SOCKET=/run/tvclone-control/control.sock
Environment=TVCLONE_CONFIG_FILE=$REPO_DIR/data/config.json
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=yes
ProtectHome=read-only
ProtectSystem=strict
ReadOnlyPaths=$REPO_DIR
ReadWritePaths=$REPO_DIR/data $REPO_DIR/transcode_tmp /mnt/media/Movies /mnt/media/TV /mnt/media/Share "$REPO_DIR/media-organizer/organizer_aliases.json"
BindPaths=$REPO_DIR/data $REPO_DIR/transcode_tmp "$REPO_DIR/media-organizer/organizer_aliases.json"
InaccessiblePaths=-/home/blue/.ssh -/home/blue/.codex -/var/run/docker.sock
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
UMask=0007
UNIT
# Backups must be able to read private state created by the service account.
install -d -m 0700 -o root -g root "$REPO_DIR/data_backups"
install -d /etc/systemd/system/tvclone-backup.service.d
cat >/etc/systemd/system/tvclone-backup.service.d/isolation.conf <<'UNIT'
[Service]
User=root
UNIT
systemctl daemon-reload
systemctl enable --now tvclone-control.service >/dev/null
systemd-analyze verify tvclone-prod.service tvclone-control.service
printf 'Isolation prepared; recovery files: %s\n' "$INSTALL_BACKUP"
