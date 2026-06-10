#!/usr/bin/env node
const path = require('path');
const reliability = require('../lib/reliability');

function repoDirFromArgs(args) {
  const idx = args.indexOf('--repo');
  if (idx >= 0 && args[idx + 1]) return path.resolve(args[idx + 1]);
  return path.resolve(__dirname, '..');
}

function printHuman(result) {
  const ok = result.ok ? 'OK' : 'WARN';
  console.log(`[tvclone] ${ok}`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
  if (result.results?.length) {
    for (const step of result.results) {
      console.log(`  ${step.ok === false ? 'FAIL' : 'OK'} ${step.step}: ${step.message || step.stderr || step.error || step.count || ''}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const repoDir = repoDirFromArgs(args);
  const json = args.includes('--json');
  const options = { repoDir };

  let result;
  if (command === 'status' || command === 'doctor') result = await reliability.status(options);
  else if (command === 'repair') result = await reliability.repair(options);
  else if (command === 'boot-repair') result = await reliability.bootRepair(options);
  else if (command === 'watchdog') result = await reliability.watchdog(options);
  else if (command === 'backup') result = await reliability.backup(options);
  else if (command === 'preflight') {
    result = await reliability.status(options);
    const required = [...result.checks.media, ...result.checks.downloads];
    result.ok = required.every(c => c.exists && c.isDirectory && (!c.warnings || c.warnings.length === 0));
    result.warnings = required.flatMap(c => (c.warnings || []).map(w => `${c.path}: ${w}`));
  } else {
    console.error(`Usage: ${path.basename(process.argv[1])} [status|doctor|repair|boot-repair|watchdog|backup|preflight] [--json] [--repo DIR]`);
    process.exit(64);
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exit(result.ok ? 0 : 2);
}

main().catch(err => {
  console.error(`[tvclone] ${err.stack || err.message}`);
  process.exit(1);
});
