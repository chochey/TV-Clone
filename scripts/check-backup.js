#!/usr/bin/env node
// Rehearses into a temporary private folder, then removes it. Never writes
// live application state or prints state contents.
const path = require('path');
const { checkRestore } = require('../lib/verified-backup');
const snapshot = process.argv[2];
if (!snapshot || process.argv.length !== 3) {
  console.error('Usage: node scripts/check-backup.js SNAPSHOT_DIRECTORY');
  process.exitCode = 64;
} else {
  const result = checkRestore(path.resolve(snapshot));
  console.log(result.ok ? `[backup] Restore check passed: ${result.fileCount} files, ${result.bytes} bytes.`
    : `[backup] Restore check failed: ${result.error}.`);
  process.exitCode = result.ok ? 0 : 2;
}
