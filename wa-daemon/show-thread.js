#!/usr/bin/env node
// Print the last N messages for a WA chat from message-store.jsonl.
// Output: one line per message, format: "<arrow> HH:MM <text>"
//   arrow = "→" for outgoing (fromMe=true), "←" for incoming
//
// Usage:
//   node show-thread.js --jid <chatJid> [--limit N] [--since-unix N] [--with-sender]
//
// Defaults: --limit 4 (last 4 messages, oldest-first).
// --since-unix N: only print messages with timestamp >= N (unix seconds).
//   When set, --limit is ignored unless explicitly given alongside (then both apply: filter by since first, then tail-limit).
// --with-sender: for incoming msgs, prefix the text with "<pushName>: " (falls back to senderJid last6).
//   Mandatory for group displays in /triage so the reader can tell who said what.
//
// Used by the /triage skill (step 5) to render WA DM snippets so captured
// OUT msgs are visible at a glance — spot "I already replied" without
// trusting repliedSinceLastIncoming.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.join(__dirname, 'message-store.jsonl');

function parseArgs(argv) {
  const out = { jid: null, limit: null, sinceUnix: null, limitExplicit: false, withSender: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jid') out.jid = argv[++i];
    else if (a === '--limit') { out.limit = parseInt(argv[++i], 10) || 4; out.limitExplicit = true; }
    else if (a === '--since-unix') out.sinceUnix = parseInt(argv[++i], 10) || null;
    else if (a === '--with-sender') out.withSender = true;
  }
  if (out.limit === null) out.limit = 4;
  return out;
}

const { jid, limit, sinceUnix, limitExplicit, withSender } = parseArgs(process.argv);

if (!jid) {
  console.error('usage: node show-thread.js --jid <chatJid> [--limit N] [--since-unix N]');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(storePath, 'utf8');
} catch (err) {
  console.error(`could not read ${storePath}: ${err.message}`);
  process.exit(1);
}

const lines = raw.trim().split('\n');
const hits = [];
for (const line of lines) {
  try {
    const m = JSON.parse(line);
    if (m.chatJid === jid) hits.push(m);
  } catch {
    // skip malformed
  }
}

let filtered = hits;
if (sinceUnix !== null) {
  filtered = filtered.filter(h => (h.timestamp || 0) >= sinceUnix);
}
const last = (sinceUnix !== null && !limitExplicit) ? filtered : filtered.slice(-limit);
for (const h of last) {
  const t = new Date((h.timestamp || 0) * 1000);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const arrow = h.fromMe ? '→' : '←';
  const text = (h.text || '').replace(/\n/g, ' ');
  let prefix = '';
  if (withSender && !h.fromMe) {
    const name = h.pushName && h.pushName.trim()
      ? h.pushName
      : (h.senderJid ? h.senderJid.split('@')[0].slice(-6) : 'unknown');
    prefix = `${name}: `;
  }
  console.log(`${arrow} ${hh}:${mm} ${prefix}${text}`);
}
