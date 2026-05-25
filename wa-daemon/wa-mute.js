// Manage the wa-groups-block.json file that triage.js consults to skip
// known-noisy group chats.
//
// Usage:
//   node wa-mute.js add <chat-jid|chat-name-substring> [reason]
//   node wa-mute.js list
//   node wa-mute.js remove <chat-jid>
//
// Resolves chat-name substrings against chats.json so the user can mute
// groups by name without pasting the JID.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOCK_PATH = path.join(__dirname, 'wa-groups-block.json');
const CHATS_PATH = path.join(__dirname, 'chats.json');

function load() {
  if (!fs.existsSync(BLOCK_PATH)) return { blocked: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(BLOCK_PATH, 'utf8'));
    if (!Array.isArray(raw.blocked)) raw.blocked = [];
    return raw;
  } catch {
    return { blocked: [] };
  }
}

function save(obj) {
  fs.writeFileSync(BLOCK_PATH, JSON.stringify(obj, null, 2));
}

function loadChats() {
  if (!fs.existsSync(CHATS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CHATS_PATH, 'utf8')); } catch { return {}; }
}

function resolveJid(arg) {
  if (arg.endsWith('@g.us') || arg.endsWith('@s.whatsapp.net') || arg.endsWith('@lid')) return [arg];
  const chats = loadChats();
  const matches = Object.entries(chats).filter(([jid, name]) =>
    name && jid.endsWith('@g.us') && name.toLowerCase().includes(arg.toLowerCase())
  );
  return matches;
}

const cmd = process.argv[2];
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage:');
  console.log('  node wa-mute.js add <chat-jid|chat-name-substring> [reason]');
  console.log('  node wa-mute.js list');
  console.log('  node wa-mute.js remove <chat-jid>');
  process.exit(0);
}

const obj = load();

if (cmd === 'list') {
  if (!obj.blocked.length) { console.log('(none blocked)'); process.exit(0); }
  for (const b of obj.blocked) {
    console.log(`${b.jid}  ->  ${b.name || '(no name)'}${b.reason ? ' — ' + b.reason : ''}`);
  }
  process.exit(0);
}

if (cmd === 'remove') {
  const target = process.argv[3];
  if (!target) { console.error('Need a chat-jid to remove'); process.exit(1); }
  const before = obj.blocked.length;
  obj.blocked = obj.blocked.filter((b) => b.jid !== target);
  if (obj.blocked.length === before) {
    console.log(`(${target} not in block list)`);
    process.exit(0);
  }
  save(obj);
  console.log(`removed ${target}`);
  process.exit(0);
}

if (cmd === 'add') {
  const arg = process.argv[3];
  const reason = process.argv.slice(4).join(' ') || null;
  if (!arg) { console.error('Need a chat-jid or chat-name substring'); process.exit(1); }

  const matches = resolveJid(arg);
  if (Array.isArray(matches[0])) {
    if (matches.length === 0) {
      console.error(`No group found matching "${arg}". Pass the @g.us JID directly, or run "wa-mute.js list" to inspect existing chats.`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`"${arg}" matches ${matches.length} groups:`);
      for (const [jid, name] of matches) console.error(`  ${jid}  ->  ${name}`);
      console.error('Be more specific or pass the JID.');
      process.exit(1);
    }
    const [jid, name] = matches[0];
    if (obj.blocked.some((b) => b.jid === jid)) {
      console.log(`(${jid} already blocked)`);
      process.exit(0);
    }
    obj.blocked.push({ jid, name, reason, addedAt: new Date().toISOString() });
    save(obj);
    console.log(`muted ${jid}  ->  ${name}${reason ? ' — ' + reason : ''}`);
    process.exit(0);
  }

  const jid = matches[0];
  if (obj.blocked.some((b) => b.jid === jid)) {
    console.log(`(${jid} already blocked)`);
    process.exit(0);
  }
  const chats = loadChats();
  const name = chats[jid] || null;
  obj.blocked.push({ jid, name, reason, addedAt: new Date().toISOString() });
  save(obj);
  console.log(`muted ${jid}${name ? '  ->  ' + name : ''}${reason ? ' — ' + reason : ''}`);
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(1);
