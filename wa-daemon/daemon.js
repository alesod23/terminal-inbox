import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const makeWASocket = baileys.default ?? baileys;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth');

function platformBrowser() {
  if (process.platform === 'darwin') return Browsers.macOS('Chrome');
  if (process.platform === 'linux') return Browsers.ubuntu('Chrome');
  return Browsers.windows('Chrome');
}
const STORE_PATH = path.join(__dirname, 'message-store.jsonl');
const CHATS_PATH = path.join(__dirname, 'chats.json');
const CHATS_STATE_PATH = path.join(__dirname, 'chats-state.json');
const PID_PATH = path.join(__dirname, 'daemon.pid');
const HEARTBEAT_PATH = path.join(__dirname, 'heartbeat');
const HEARTBEAT_INTERVAL_MS = 60_000;
const SEND_PORT = 4119;

// Shared ref to the live Baileys socket so the HTTP send endpoint can reach
// it. Set in runOnce on connect, cleared on disconnect.
let currentSock = null;

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
};

function extractText(message) {
  const m = message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return `[image]${m.imageMessage.caption ? ' ' + m.imageMessage.caption : ''}`;
  if (m.videoMessage) return `[video]${m.videoMessage.caption ? ' ' + m.videoMessage.caption : ''}`;
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.documentMessage) return `[document: ${m.documentMessage.fileName || ''}]${m.documentMessage.caption ? ' ' + m.documentMessage.caption : ''}`;
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const inner = m.documentWithCaptionMessage.message.documentMessage;
    return `[document: ${inner.fileName || ''}]${inner.caption ? ' ' + inner.caption : ''}`;
  }
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage) return '[location]';
  if (m.contactMessage) return `[contact: ${m.contactMessage.displayName || ''}]`;
  if (m.protocolMessage) return null;
  if (m.reactionMessage) return `[reaction: ${m.reactionMessage.text || ''}]`;
  return null;
}

function summarize(msg) {
  const ts = Number(msg.messageTimestamp || 0);
  const fromMe = !!msg.key.fromMe;
  const remoteJid = msg.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');
  const participantJid = msg.key.participant || (isGroup ? '' : remoteJid);
  const senderJid = fromMe ? 'me' : participantJid;
  const text = extractText(msg.message);
  const senderPn =
    msg.key?.senderPn ||
    msg.key?.participantPn ||
    msg.senderPn ||
    msg.participantPn ||
    null;
  const participantAlt = msg.key?.participantAlt || null;
  return {
    id: msg.key.id,
    timestamp: ts,
    iso: new Date(ts * 1000).toISOString(),
    fromMe,
    chatJid: remoteJid,
    isGroup,
    senderJid,
    senderPn,
    participantAlt,
    pushName: msg.pushName || null,
    text,
  };
}

const seenIds = new Set();
let chatMap = {};
let chatState = {};

function loadChatMap() {
  if (!fs.existsSync(CHATS_PATH)) return;
  try {
    chatMap = JSON.parse(fs.readFileSync(CHATS_PATH, 'utf8'));
    log(`loaded ${Object.keys(chatMap).length} known chat names`);
  } catch (err) {
    log(`could not load chat map: ${err.message}`);
    chatMap = {};
  }
}

function saveChatMap() {
  try {
    fs.writeFileSync(CHATS_PATH, JSON.stringify(chatMap, null, 2));
  } catch (err) {
    log(`could not save chat map: ${err.message}`);
  }
}

function updateChatNames(items) {
  if (!items?.length) return 0;
  let count = 0;
  for (const c of items) {
    const id = c?.id || c?.jid;
    const name = c?.name || c?.subject;
    if (id && name && chatMap[id] !== name) {
      chatMap[id] = name;
      count++;
    }
  }
  if (count) saveChatMap();
  return count;
}

function loadChatState() {
  if (!fs.existsSync(CHATS_STATE_PATH)) return;
  try {
    chatState = JSON.parse(fs.readFileSync(CHATS_STATE_PATH, 'utf8'));
    log(`loaded ${Object.keys(chatState).length} chat read-state entries`);
  } catch (err) {
    log(`could not load chats-state.json: ${err.message}`);
    chatState = {};
  }
}

function saveChatState() {
  try {
    fs.writeFileSync(CHATS_STATE_PATH, JSON.stringify(chatState, null, 2));
  } catch (err) {
    log(`could not save chats-state.json: ${err.message}`);
  }
}

// Merge partial Baileys Conversation updates into chats-state.json.
// Baileys emits chats.update with a partial payload — only fields that
// actually changed are present. Preserve prior values for missing keys.
// `unreadCount: -1` is a Baileys sentinel ("conditionally unread during
// initial sync") — treat as unknown, do not overwrite a real prior value.
function updateChatReadState(items) {
  if (!items?.length) return 0;
  let count = 0;
  for (const c of items) {
    const id = c?.id || c?.jid;
    if (!id) continue;
    const prior = chatState[id] || {};
    const next = { ...prior };
    let changed = false;
    if (c.unreadCount !== undefined && c.unreadCount !== null && c.unreadCount !== -1) {
      if (next.unreadCount !== c.unreadCount) {
        next.unreadCount = c.unreadCount;
        changed = true;
      }
    }
    if (c.unreadMentionCount !== undefined && c.unreadMentionCount !== null && c.unreadMentionCount !== -1) {
      if (next.unreadMentionCount !== c.unreadMentionCount) {
        next.unreadMentionCount = c.unreadMentionCount;
        changed = true;
      }
    }
    if (changed) {
      next.lastUpdatedAt = new Date().toISOString();
      chatState[id] = next;
      count++;
    }
  }
  if (count) saveChatState();
  return count;
}

function loadSeenIds() {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const data = fs.readFileSync(STORE_PATH, 'utf8');
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id) seenIds.add(obj.id);
      } catch {}
    }
    log(`loaded ${seenIds.size} known message IDs from store`);
  } catch (err) {
    log(`could not load store: ${err.message}`);
  }
}

const writeQueue = [];
let writing = false;
async function flushQueue() {
  if (writing || !writeQueue.length) return;
  writing = true;
  const batch = writeQueue.splice(0);
  await fs.promises.appendFile(STORE_PATH, batch.join('\n') + '\n');
  writing = false;
  if (writeQueue.length) flushQueue();
}

function ingest(rawMsg) {
  const m = summarize(rawMsg);
  if (!m.id) return;
  if (seenIds.has(m.id)) return;
  if (!m.text) return;
  seenIds.add(m.id);
  writeQueue.push(JSON.stringify(m));
  flushQueue();
  // Outgoing-message fallback for read-state. Baileys' server_sync path
  // (markChatAsReadAction → chats.update with unreadCount:0) propagates
  // eventually but can lag minutes when WhatsApp batches app-state pushes.
  // An outgoing message in this chat is a STRONGER signal anyway: you can't
  // reply without having seen the incoming. Force unreadCount=0 immediately.
  if (m.fromMe && m.chatJid) {
    const prior = chatState[m.chatJid] || {};
    if (prior.unreadCount !== 0) {
      chatState[m.chatJid] = {
        ...prior,
        unreadCount: 0,
        lastUpdatedAt: new Date().toISOString(),
        readVia: 'outgoing-message-fallback',
      };
      saveChatState();
    }
  }
}

let stopped = false;
async function runOnce(state, saveCreds) {
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    browser: platformBrowser(),
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });
  sock.ev.on('creds.update', saveCreds);
  currentSock = sock;

  sock.ev.on('messages.upsert', ({ messages }) => {
    let count = 0;
    for (const m of messages) {
      const before = seenIds.size;
      ingest(m);
      if (seenIds.size > before) count++;
    }
    if (count) log(`captured ${count} new message(s) from messages.upsert`);
  });
  sock.ev.on('messaging-history.set', ({ messages, chats }) => {
    const chatCount = updateChatNames(chats);
    if (chatCount) log(`learned ${chatCount} chat name(s) from history.set`);
    const readCount = updateChatReadState(chats);
    if (readCount) log(`updated unreadCount for ${readCount} chat(s) from history.set`);
    if (!messages?.length) return;
    let count = 0;
    for (const m of messages) {
      const before = seenIds.size;
      ingest(m);
      if (seenIds.size > before) count++;
    }
    if (count) log(`captured ${count} new message(s) from history.set`);
  });
  sock.ev.on('chats.upsert', (chats) => {
    const c = updateChatNames(chats);
    if (c) log(`learned ${c} chat name(s) from chats.upsert`);
    const r = updateChatReadState(chats);
    if (r) log(`updated unreadCount for ${r} chat(s) from chats.upsert`);
  });
  sock.ev.on('chats.update', (chats) => {
    const c = updateChatNames(chats);
    if (c) log(`updated ${c} chat name(s) from chats.update`);
    const r = updateChatReadState(chats);
    if (r) log(`updated unreadCount for ${r} chat(s) from chats.update`);
  });
  sock.ev.on('groups.upsert', (groups) => {
    const c = updateChatNames(groups);
    if (c) log(`learned ${c} group name(s) from groups.upsert`);
  });
  sock.ev.on('groups.update', (groups) => {
    const c = updateChatNames(groups);
    if (c) log(`updated ${c} group name(s) from groups.update`);
  });

  let heartbeatTimer = null;
  const writeHeartbeat = () => {
    try { fs.writeFileSync(HEARTBEAT_PATH, String(Date.now())); } catch {}
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    try { fs.unlinkSync(HEARTBEAT_PATH); } catch {}
  };

  return new Promise((resolve) => {
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        log(`connected as ${sock.user?.id || 'unknown'}`);
        writeHeartbeat();
        heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
        try {
          const groups = await sock.groupFetchAllParticipating();
          const list = Object.entries(groups).map(([id, meta]) => ({ id, subject: meta.subject }));
          const c = updateChatNames(list);
          log(`bulk-fetched ${list.length} groups, learned ${c} new name(s)`);
        } catch (err) {
          log(`groupFetchAllParticipating failed: ${err.message}`);
        }
      }
      if (connection === 'close') {
        stopHeartbeat();
        currentSock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const codeName = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || 'unknown';
        log(`disconnected (code=${code} ${codeName})`);
        try { sock.end(undefined); } catch {}
        if (code === DisconnectReason.loggedOut) {
          log('LOGGED OUT — auth invalid. Wipe auth/ and re-pair.');
          stopped = true;
          resolve('loggedOut');
        } else {
          resolve('reconnect');
        }
      }
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // PID file for stop script
  fs.writeFileSync(PID_PATH, String(process.pid));
  process.on('SIGINT', () => { log('SIGINT received, exiting'); stopped = true; cleanup(); });
  process.on('SIGTERM', () => { log('SIGTERM received, exiting'); stopped = true; cleanup(); });
  // Swallow async Baileys timeouts so they don't kill the process. The reconnect
  // loop in runOnce only catches awaited errors; sendPassiveIq and similar fire
  // promises that bypass it. Without this handler, one unhandled rejection
  // exits node and the daemon dies silently (root cause of 2026-05-11 outage).
  process.on('unhandledRejection', (err) => {
    log(`unhandledRejection (swallowed): ${err?.message || err}`);
  });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException (swallowed): ${err?.message || err}`);
  });
  let sendServer = null;
  function cleanup() {
    try { fs.unlinkSync(PID_PATH); } catch {}
    try { fs.unlinkSync(HEARTBEAT_PATH); } catch {}
    try { sendServer?.close(); } catch {}
    process.exit(0);
  }

  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    log('no auth — run "node login.js +<phone>" first');
    process.exit(1);
  }

  // Local-only HTTP endpoint for outbound sends. Bind 127.0.0.1 so only
  // processes on this machine can reach it; we deliberately skip a shared
  // secret since auth/ on disk is already the trust boundary (anyone who
  // can read it can send WA messages anyway).
  sendServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connected: !!currentSock }));
      return;
    }
    if (req.method === 'POST' && req.url === '/resync') {
      // Force WhatsApp app-state resync. Pulls the latest read-state
      // (markChatAsReadAction) from the server even when no server_sync
      // notification has been pushed. Baileys then emits chats.update
      // events, which our handler routes into chats-state.json.
      if (!currentSock) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not connected to whatsapp' }));
        return;
      }
      try {
        const patches = ['regular', 'regular_high', 'regular_low'];
        await currentSock.resyncAppState(patches, false);
        log(`manual resync ok (patches: ${patches.join(',')})`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, patches }));
      } catch (err) {
        log(`manual resync failed: ${err?.message || err}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      const { jid, text } = payload;
      if (!jid || typeof jid !== 'string' || !text || typeof text !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'jid and text required (strings)' }));
        return;
      }
      if (!currentSock) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not connected to whatsapp' }));
        return;
      }
      try {
        const result = await currentSock.sendMessage(jid, { text });
        log(`sent to ${jid} (id=${result?.key?.id || '?'}, ${text.length} chars)`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: result?.key?.id || null }));
      } catch (err) {
        log(`send to ${jid} failed: ${err.message || err}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
      }
    });
  });
  sendServer.listen(SEND_PORT, '127.0.0.1', () => {
    log(`send endpoint listening on 127.0.0.1:${SEND_PORT}`);
  });

  loadSeenIds();
  loadChatMap();
  loadChatState();
  log(`store: ${STORE_PATH}`);
  log(`pid:   ${process.pid} (written to ${PID_PATH})`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let backoff = 5000;

  while (!stopped) {
    try {
      const result = await runOnce(state, saveCreds);
      if (result === 'loggedOut') break;
      backoff = 5000;
    } catch (err) {
      log(`loop error: ${err.message || err}`);
    }
    if (stopped) break;
    log(`reconnecting in ${backoff / 1000}s...`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
  cleanup();
}

main().catch((err) => {
  log(`fatal: ${err.message || err}`);
  try { fs.unlinkSync(PID_PATH); } catch {}
  process.exit(1);
});
