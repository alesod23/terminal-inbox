// Manually tag a LID with a display name.
// Usage:
//   node lid-tag.js <lid> "Display name"
//   node lid-tag.js list
//   node lid-tag.js remove <lid>
//
// LID can be the bare digits (e.g. 123456789012345) or full jid (123456789012345@lid).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, 'lid-overrides.json');

function load() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); } catch { return {}; }
}

function save(obj) {
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(obj, null, 2));
}

function normalizeLid(lid) {
  const trimmed = lid.trim();
  if (trimmed.endsWith('@lid')) return trimmed;
  if (/^\d+$/.test(trimmed)) return `${trimmed}@lid`;
  return trimmed;
}

const cmd = process.argv[2];
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage:');
  console.log('  node lid-tag.js <lid> "Display name"');
  console.log('  node lid-tag.js list');
  console.log('  node lid-tag.js remove <lid>');
  process.exit(0);
}

const obj = load();

if (cmd === 'list') {
  const entries = Object.entries(obj).filter(([k]) => !k.startsWith('_'));
  if (!entries.length) { console.log('(no overrides)'); process.exit(0); }
  for (const [lid, name] of entries) console.log(`${lid}  ->  ${name}`);
  process.exit(0);
}

if (cmd === 'remove') {
  const lid = normalizeLid(process.argv[3] || '');
  if (!lid) { console.error('Need a LID to remove'); process.exit(1); }
  if (!(lid in obj)) { console.log(`(${lid} not in overrides)`); process.exit(0); }
  delete obj[lid];
  save(obj);
  console.log(`removed ${lid}`);
  process.exit(0);
}

// add
const lid = normalizeLid(cmd);
const name = process.argv[3];
if (!name) { console.error('Need a display name as second arg'); process.exit(1); }
obj[lid] = name;
save(obj);
console.log(`tagged ${lid} -> ${name}`);
