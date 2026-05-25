import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'message-store.jsonl');
const CHATS_PATH = path.join(__dirname, 'chats.json');
const CHATS_STATE_PATH = path.join(__dirname, 'chats-state.json');
const OVERRIDES_PATH = path.join(__dirname, 'lid-overrides.json');
const GROUPS_BLOCK_PATH = path.join(__dirname, 'wa-groups-block.json');
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const PID_PATH = path.join(__dirname, 'daemon.pid');
const HEARTBEAT_PATH = path.join(__dirname, 'heartbeat');

function readDaemonHealth() {
  // daemon_heartbeat_at: ISO of the last heartbeat timestamp written by the daemon
  //   while its WebSocket was open. Missing/old => daemon is NOT connected to WA.
  // daemon_pid_alive: whether the PID recorded in daemon.pid is still a live process.
  //   Together these distinguish "process running but disconnected" vs "fully dead".
  let heartbeatAt = null;
  let heartbeatAgeSec = null;
  if (fs.existsSync(HEARTBEAT_PATH)) {
    try {
      const raw = fs.readFileSync(HEARTBEAT_PATH, 'utf8').trim();
      const ms = Number(raw);
      if (Number.isFinite(ms) && ms > 0) {
        heartbeatAt = new Date(ms).toISOString();
        heartbeatAgeSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      }
    } catch {}
  }
  let pidAlive = false;
  let pid = null;
  if (fs.existsSync(PID_PATH)) {
    try {
      const raw = fs.readFileSync(PID_PATH, 'utf8').trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        pid = n;
        try { process.kill(n, 0); pidAlive = true; } catch { pidAlive = false; }
      }
    } catch {}
  }
  return { daemon_pid: pid, daemon_pid_alive: pidAlive, daemon_heartbeat_at: heartbeatAt, daemon_heartbeat_age_sec: heartbeatAgeSec };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--include-mine') args.includeMine = true;
    else if (a === '--include-reactions') args.includeReactions = true;
    else if (a === '--include-blocked') args.includeBlocked = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  args.hours ??= 2;
  return args;
}

function usage() {
  console.log('Usage: node triage.js [--hours 2] [--include-mine] [--include-reactions] [--include-blocked] [--json]');
  console.log('  --include-blocked: do not skip groups listed in wa-groups-block.json');
}

function loadContacts() {
  if (!fs.existsSync(CONTACTS_PATH)) return {};
  try {
    const c = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
    const map = {};
    for (const [name, phone] of Object.entries(c)) {
      if (name.startsWith('_') || typeof phone !== 'string') continue;
      const digits = phone.replace(/^\+/, '');
      if (!map[digits]) map[digits] = name;
    }
    return map;
  } catch {
    return {};
  }
}

function loadChatNames() {
  if (!fs.existsSync(CHATS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CHATS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadChatStateMap() {
  if (!fs.existsSync(CHATS_STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CHATS_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadLidOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function loadBlockedGroups() {
  if (!fs.existsSync(GROUPS_BLOCK_PATH)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(GROUPS_BLOCK_PATH, 'utf8'));
    const blocked = data.blocked || [];
    return new Set(blocked.map((b) => b.jid).filter(Boolean));
  } catch {
    return new Set();
  }
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

function buildJidPushNameMap(messages) {
  // Walk all messages, keep the most recent pushName per sender JID.
  const latestTs = new Map();
  const names = new Map();
  for (const m of messages) {
    if (!m.pushName || !m.senderJid || m.senderJid === 'me') continue;
    const prev = latestTs.get(m.senderJid) || 0;
    if (m.timestamp >= prev) {
      latestTs.set(m.senderJid, m.timestamp);
      names.set(m.senderJid, m.pushName);
    }
  }
  return names;
}

function buildJidPnMap(messages) {
  // Walk all messages, capture senderPn -> jid mapping.
  const map = new Map();
  for (const m of messages) {
    if (!m.senderPn || !m.senderJid || m.senderJid === 'me') continue;
    if (!map.has(m.senderJid)) map.set(m.senderJid, m.senderPn);
  }
  return map;
}

function jidToName(jid, ctx) {
  if (!jid) return null;
  // Manual override always wins.
  if (ctx.lidOverrides[jid]) return ctx.lidOverrides[jid];
  if (jid.endsWith('@s.whatsapp.net')) {
    const digits = jid.split('@')[0].split(':')[0];
    return ctx.phoneToName[digits] || ctx.jidToPushName.get(jid) || `+${digits}`;
  }
  if (jid.endsWith('@lid')) {
    // Try senderPn -> contact lookup first.
    const pn = ctx.jidToPn.get(jid);
    if (pn) {
      const digits = pn.replace(/^\+/, '').split('@')[0];
      const contactName = ctx.phoneToName[digits];
      if (contactName) return contactName;
    }
    const pushName = ctx.jidToPushName.get(jid);
    if (pushName) return pushName;
    const lidId = jid.split('@')[0];
    return `unknown (lid ${lidId.slice(-6)})`;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }

  const cutoff = Math.floor(Date.now() / 1000) - args.hours * 3600;
  const phoneToName = loadContacts();
  const chatNames = loadChatNames();
  const chatStateMap = loadChatStateMap();
  const lidOverrides = loadLidOverrides();
  const blockedGroups = loadBlockedGroups();
  const all = loadStore();
  const jidToPushName = buildJidPushNameMap(all);
  const jidToPn = buildJidPnMap(all);
  const ctx = { phoneToName, jidToPushName, jidToPn, lidOverrides };

  // Build per-chat reply state across ALL stored messages (not just window),
  // so that even an old outgoing reply correctly marks the chat as handled.
  const replyState = new Map();
  for (const m of all) {
    const s = replyState.get(m.chatJid) || {
      lastIn: null, lastOut: null, inCount: 0, outCount: 0,
    };
    if (m.fromMe) {
      s.outCount++;
      if (!s.lastOut || m.timestamp > s.lastOut.timestamp) s.lastOut = m;
    } else {
      s.inCount++;
      if (!s.lastIn || m.timestamp > s.lastIn.timestamp) s.lastIn = m;
    }
    replyState.set(m.chatJid, s);
  }
  let recent = all.filter((m) => m.timestamp >= cutoff);
  if (!args.includeMine) recent = recent.filter((m) => !m.fromMe);
  if (!args.includeReactions) recent = recent.filter((m) => !/^\[reaction:/.test(m.text || ''));
  if (!args.includeBlocked && blockedGroups.size > 0) {
    recent = recent.filter((m) => !blockedGroups.has(m.chatJid));
  }

  const byChat = new Map();
  const counts = new Map();
  for (const m of recent) {
    counts.set(m.chatJid, (counts.get(m.chatJid) || 0) + 1);
    const cur = byChat.get(m.chatJid);
    if (!cur || m.timestamp > cur.timestamp) byChat.set(m.chatJid, m);
  }

  const chatJids = [...byChat.keys()].sort((a, b) => byChat.get(b).timestamp - byChat.get(a).timestamp);
  const items = chatJids.map((jid, i) => {
    const m = byChat.get(jid);
    let label;
    if (m.isGroup) label = `group: ${chatNames[jid] || m.chatName || jid}`;
    else label = m.senderName || jidToName(jid, ctx) || jid;
    const time = new Date(m.timestamp * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const text = (m.text || '').replace(/\s+/g, ' ').slice(0, 160);
    const cnt = counts.get(jid) || 1;
    const s = replyState.get(jid) || {};
    const lastIn = s.lastIn ? {
      timestamp: s.lastIn.timestamp,
      iso: s.lastIn.iso,
      text: (s.lastIn.text || '').replace(/\s+/g, ' ').slice(0, 220),
    } : null;
    const lastOut = s.lastOut ? {
      timestamp: s.lastOut.timestamp,
      iso: s.lastOut.iso,
      text: (s.lastOut.text || '').replace(/\s+/g, ' ').slice(0, 220),
    } : null;
    const repliedSinceLastIncoming = !!(lastIn && lastOut && lastOut.timestamp > lastIn.timestamp);
    const readState = chatStateMap[jid] || null;
    return {
      n: i + 1, time, label, count: cnt, jid, text,
      fromMe: m.fromMe, isGroup: m.isGroup,
      lastIn, lastOut,
      repliedSinceLastIncoming,
      totalInCount: s.inCount || 0,
      totalOutCount: s.outCount || 0,
      // From chats-state.json (Baileys chats.update events). null if daemon
      // hasn't seen any chats.update for this jid yet (e.g., right after
      // restart). 0 = user has read on phone; >0 = unread on phone.
      unreadCount: readState?.unreadCount ?? null,
      unreadMentionCount: readState?.unreadMentionCount ?? null,
      unreadStateUpdatedAt: readState?.lastUpdatedAt ?? null,
    };
  });

  if (args.json) {
    const health = readDaemonHealth();
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      window_hours: args.hours,
      total_messages_in_window: recent.length,
      total_chats: items.length,
      ...health,
      items,
    }, null, 2));
    return;
  }

  if (!items.length) {
    console.log(`No qualifying messages in last ${args.hours}h.`);
    console.log(`Store has ${all.length} messages total.`);
    if (!all.length) console.log('Store is empty — has the daemon been running? (node daemon.js)');
    return;
  }

  console.log(`Last ${args.hours}h — ${recent.length} message(s) across ${items.length} chat(s):\n`);
  for (const it of items) {
    const cnt = it.count > 1 ? ` (${it.count} msgs)` : '';
    console.log(`${String(it.n).padStart(2)}. [${it.time}] ${it.label}${cnt}`);
    console.log(`    ${it.text}`);
  }
  console.log(`\nStore: ${all.length} messages total. Older messages outside window: ${all.length - recent.length}.`);
}

main();
