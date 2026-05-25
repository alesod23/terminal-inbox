// Search a WhatsApp chat by dumping its messages chronologically for the
// model to read. No embeddings, no infra — just structured text output that
// the LLM consumes for paraphrase/semantic search.
//
// Usage:
//   node search.js --chat "<name|jid>"
//   node search.js --chat "<name|jid>" --days 30
//   node search.js --chat "<name|jid>" --query "tuscany|toscana"
//   node search.js --chat "<name|jid>" --days 90 --max 1500
//   node search.js --chat "<name|jid>" --json
//
// Resolution order for --chat:
//   1. JID format (ends in @s.whatsapp.net, @lid, @g.us) -> use directly
//   2. Exact name match in contacts.json / chats.json / lid-overrides.json
//   3. Substring match across the same three sources
//   Ambiguous match -> list candidates, exit non-zero.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'message-store.jsonl');
const CHATS_PATH = path.join(__dirname, 'chats.json');
const OVERRIDES_PATH = path.join(__dirname, 'lid-overrides.json');
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');

const JID_RE = /@(s\.whatsapp\.net|lid|g\.us)$/;

function fold(s) {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chat') args.chat = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--force') args.force = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  args.max ??= 800;
  return args;
}

function usage() {
  console.log('Usage:');
  console.log('  node search.js --chat "<name|jid>" [--days N] [--query <regex>] [--max N] [--force] [--json]');
  console.log('');
  console.log('  --chat   Required. Contact name, group-name substring, or full JID.');
  console.log('  --days   Only include messages from the last N days. Default: all.');
  console.log('  --query  Optional case-insensitive regex pre-filter on message text.');
  console.log('  --max    Refuse to dump more than N messages without --force. Default: 800.');
  console.log('  --json   Output structured JSON instead of human-readable text.');
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  const out = [];
  const seen = new Set();
  for (const line of fs.readFileSync(STORE_PATH, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.id && !seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
      }
    } catch {}
  }
  return out;
}

function buildPhoneToName(contacts) {
  const map = {};
  for (const [name, phone] of Object.entries(contacts)) {
    if (name.startsWith('_') || typeof phone !== 'string') continue;
    const digits = phone.replace(/^\+/, '');
    if (!map[digits]) map[digits] = name;
  }
  return map;
}

function buildJidToPushName(messages) {
  const latest = new Map();
  const names = new Map();
  for (const m of messages) {
    if (!m.pushName || !m.senderJid || m.senderJid === 'me') continue;
    const prev = latest.get(m.senderJid) || 0;
    if (m.timestamp >= prev) {
      latest.set(m.senderJid, m.timestamp);
      names.set(m.senderJid, m.pushName);
    }
  }
  return names;
}

function jidToSenderLabel(jid, ctx) {
  if (!jid || jid === 'me') return 'me';
  if (ctx.lidOverrides[jid]) return ctx.lidOverrides[jid];
  if (jid.endsWith('@s.whatsapp.net')) {
    const digits = jid.split('@')[0].split(':')[0];
    return ctx.phoneToName[digits] || ctx.jidToPushName.get(jid) || `+${digits}`;
  }
  if (jid.endsWith('@lid')) {
    const pushName = ctx.jidToPushName.get(jid);
    if (pushName) return pushName;
    return `lid:${jid.split('@')[0].slice(-6)}`;
  }
  return jid;
}

function resolveCandidates(input, contacts, chatNames, lidOverrides) {
  if (JID_RE.test(input)) return [{ jids: [input], label: input, source: 'jid-direct' }];

  const folded = fold(input);
  const candidates = new Map();

  function add(label, jid, source, isExact) {
    if (!candidates.has(label)) candidates.set(label, { jids: new Set(), source: new Set(), isExact: false });
    const c = candidates.get(label);
    c.jids.add(jid);
    c.source.add(source);
    if (isExact) c.isExact = true;
  }

  for (const [name, phone] of Object.entries(contacts)) {
    if (name.startsWith('_') || typeof phone !== 'string') continue;
    const fname = fold(name);
    const isExact = fname === folded;
    const isSub = !isExact && fname.includes(folded);
    if (isExact || isSub) {
      const digits = phone.replace(/^\+/, '');
      add(name, `${digits}@s.whatsapp.net`, 'contacts', isExact);
    }
  }

  for (const [jid, name] of Object.entries(chatNames)) {
    if (!jid.endsWith('@g.us')) continue;
    const fname = fold(name);
    const isExact = fname === folded;
    const isSub = !isExact && fname.includes(folded);
    if (isExact || isSub) add(name, jid, 'chats', isExact);
  }

  for (const [jid, name] of Object.entries(lidOverrides)) {
    if (jid.startsWith('_')) continue;
    const fname = fold(name);
    const isExact = fname === folded;
    const isSub = !isExact && fname.includes(folded);
    if (isExact || isSub) add(name, jid, 'lid-override', isExact);
  }

  const all = Array.from(candidates.entries()).map(([label, v]) => ({
    label,
    jids: Array.from(v.jids),
    source: Array.from(v.source).join('+'),
    isExact: v.isExact,
  }));

  const exact = all.filter((c) => c.isExact);
  if (exact.length > 0) return exact;
  return all;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.chat) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const contacts = loadJson(CONTACTS_PATH, {});
  const chatNames = loadJson(CHATS_PATH, {});
  const overridesRaw = loadJson(OVERRIDES_PATH, {});
  const lidOverrides = {};
  for (const [k, v] of Object.entries(overridesRaw)) {
    if (!k.startsWith('_')) lidOverrides[k] = v;
  }

  const candidates = resolveCandidates(args.chat, contacts, chatNames, lidOverrides);
  if (!candidates.length) {
    console.error(`ERROR: no chat found matching "${args.chat}".`);
    console.error(`Pass a contact name, group-name substring, or full JID.`);
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(`Ambiguous: "${args.chat}" matches ${candidates.length} chats:`);
    for (const c of candidates) {
      console.error(`  - ${c.label}  [${c.source}]  jids: ${c.jids.join(', ')}`);
    }
    console.error(`Pass a more specific name (or the full JID) to disambiguate.`);
    process.exit(1);
  }

  const target = candidates[0];
  const jidSet = new Set(target.jids);

  const allMessages = loadStore();
  const phoneToName = buildPhoneToName(contacts);
  const jidToPushName = buildJidToPushName(allMessages);
  const ctx = { phoneToName, jidToPushName, lidOverrides };

  const cutoff = args.days ? Math.floor(Date.now() / 1000) - args.days * 86400 : 0;
  const re = args.query ? new RegExp(args.query, 'i') : null;

  let matched = allMessages.filter((m) => {
    if (!jidSet.has(m.chatJid)) return false;
    if (m.timestamp < cutoff) return false;
    if (re && !(m.text && re.test(m.text))) return false;
    return true;
  });
  matched.sort((a, b) => a.timestamp - b.timestamp);

  const totalInChat = allMessages.filter((m) => jidSet.has(m.chatJid)).length;
  const earliest = allMessages.filter((m) => jidSet.has(m.chatJid)).reduce((a, m) => Math.min(a, m.timestamp), Infinity);
  const latest = allMessages.filter((m) => jidSet.has(m.chatJid)).reduce((a, m) => Math.max(a, m.timestamp), 0);

  if (matched.length > args.max && !args.force) {
    console.error(`Match would dump ${matched.length} messages, exceeds --max ${args.max}.`);
    console.error(`Narrow scope: pass --days N (try ${Math.max(1, Math.floor(args.days || 30 / 2))}), --query <regex>, or pass --force to dump anyway.`);
    process.exit(2);
  }

  if (args.json) {
    console.log(JSON.stringify({
      chat: { label: target.label, jids: target.jids, source: target.source },
      window: {
        days: args.days || null,
        cutoff_iso: args.days ? new Date(cutoff * 1000).toISOString() : null,
        query: args.query || null,
      },
      stats: {
        total_in_chat: totalInChat,
        chat_first_iso: earliest === Infinity ? null : new Date(earliest * 1000).toISOString(),
        chat_last_iso: latest === 0 ? null : new Date(latest * 1000).toISOString(),
        matched: matched.length,
      },
      messages: matched.map((m) => ({
        iso: m.iso,
        timestamp: m.timestamp,
        fromMe: m.fromMe,
        sender: m.fromMe ? 'me' : jidToSenderLabel(m.senderJid, ctx),
        chatJid: m.chatJid,
        text: m.text,
      })),
    }, null, 2));
    return;
  }

  // Human-readable text
  console.log(`Chat:   ${target.label}`);
  console.log(`JID(s): ${target.jids.join(', ')}`);
  console.log(`Source: ${target.source}`);
  if (totalInChat > 0) {
    console.log(`Chat history in store: ${totalInChat} messages, ${new Date(earliest * 1000).toISOString().slice(0,10)} -> ${new Date(latest * 1000).toISOString().slice(0,10)}`);
  } else {
    console.log(`(No messages in store for this chat — daemon may not have been running long enough, or the chat has no recent activity.)`);
  }
  if (args.days) console.log(`Window: last ${args.days} days (since ${new Date(cutoff*1000).toISOString().slice(0,10)})`);
  if (args.query) console.log(`Query:  /${args.query}/i`);
  console.log(`Match:  ${matched.length} message(s)\n`);

  if (!matched.length) return;

  for (const m of matched) {
    const ts = m.iso.slice(0, 16).replace('T', ' ');
    const senderLabel = m.fromMe ? 'me' : jidToSenderLabel(m.senderJid, ctx);
    const text = (m.text || '').replace(/\r?\n/g, '\n          ');
    console.log(`${ts} [${senderLabel}] ${text}`);
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message || err);
  process.exit(1);
});
