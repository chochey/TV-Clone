#!/usr/bin/env bash
# Compatibility entrypoint for verified application-state backups. Media and
# generated artwork/sprites are excluded; SKIP_SPRITES is no longer necessary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${1:-$REPO_DIR/data_backups}"
node - "$REPO_DIR" "$BACKUP_ROOT" <<'NODE'
const path = require('path');
const [repoDir, backupRoot] = process.argv.slice(2);
require(path.join(repoDir, 'lib', 'reliability')).backup({ repoDir, backupRoot }).then(result => {
  console.log(result.ok ? `[backup] Verified ${result.fileCount} files at ${result.target}`
    : `[backup] Failed (${result.error}); previous snapshots preserved.`);
  process.exitCode = result.ok ? 0 : 2;
}).catch(() => { console.error('[backup] Failed; previous snapshots preserved.'); process.exitCode = 2; });
NODE
