// Minimal .env loader. No external deps. Handles:
//   - KEY=value
//   - KEY="value with spaces and =signs"
//   - KEY='single quoted'
//   - export KEY=value (bash-style prefix)
//   - # comments (full line and inline, but not inside quotes)
//   - blank lines
//
// Does NOT handle: multi-line values, variable interpolation ($OTHER), escapes.
const fs = require('fs');

function parseLine(line) {
  // Strip optional "export " prefix
  line = line.replace(/^\s*export\s+/, '');
  // Must start with a valid identifier followed by =
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2];

  // Quoted value: take everything up to the matching quote, ignore trailing comment.
  const firstChar = value.trimStart()[0];
  if (firstChar === '"' || firstChar === "'") {
    const trimmed = value.trimStart();
    const end = trimmed.indexOf(firstChar, 1);
    if (end === -1) return null; // unterminated quote
    return { key, value: trimmed.slice(1, end) };
  }

  // Unquoted: strip inline # comments and trailing whitespace.
  const hashIdx = value.indexOf('#');
  if (hashIdx !== -1) value = value.slice(0, hashIdx);
  return { key, value: value.trim() };
}

function load(envFile) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf-8'); } catch { return 0; }
  let loaded = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (!(parsed.key in process.env)) {
      process.env[parsed.key] = parsed.value;
      loaded++;
    }
  }
  return loaded;
}

module.exports = { load, parseLine };
