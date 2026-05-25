// Thin send client. POSTs to the daemon's local HTTP send endpoint;
// does not open its own Baileys session.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const ALIASES_PATH = path.join(__dirname, 'aliases.json');

const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 4119;

const JID_RE = /@(s\.whatsapp\.net|lid|g\.us)$/;

function parseArgs(argv) {
  const args = { confirmed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') args.to = argv[++i];
    else if (a === '--jid') args.jid = argv[++i];
    else if (a === '--text') args.text = argv[++i];
    else if (a === '--confirmed') args.confirmed = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log('Usage:');
  console.log('  node send.js --to <name|+phone> --text "message"             # dry run, resolves via aliases.json then contacts.json');
  console.log('  node send.js --to <name|+phone> --text "message" --confirmed # actually send');
  console.log('  node send.js --jid <jid> --text "message"                    # direct JID, no lookup');
  console.log('  node send.js --jid <jid> --text "message" --confirmed        # actually send');
  console.log('');
  console.log('Phone format: E.164 with + prefix (e.g. +14155551234)');
  console.log('JID format:   <digits>@s.whatsapp.net, <digits>@lid, <digits>@g.us');
  console.log('');
  console.log(`Routes through daemon at http://${DAEMON_HOST}:${DAEMON_PORT}/send`);
}

function fold(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function phoneToJid(phone) {
  return phone.replace(/^\+/, '') + '@s.whatsapp.net';
}

async function tryResolveAlias(target) {
  if (!existsSync(ALIASES_PATH)) return null;
  const aliases = JSON.parse(await fs.readFile(ALIASES_PATH, 'utf8'));
  const keys = Object.keys(aliases).filter((k) => !k.startsWith('_'));
  const folded = fold(target);
  const exact = keys.find((k) => fold(k) === folded);
  if (!exact) return null;
  const value = aliases[exact];
  if (JID_RE.test(value)) return { jid: value, key: exact, kind: 'alias-jid' };
  if (/^\+\d{7,15}$/.test(value)) return { jid: phoneToJid(value), key: exact, kind: 'alias-phone' };
  throw new Error(`aliases.json entry "${exact}" has invalid value "${value}" (need JID or +E164).`);
}

async function resolvePhone(target) {
  if (/^\+\d{7,15}$/.test(target)) return { phone: target, key: target };
  if (!existsSync(CONTACTS_PATH)) {
    throw new Error(`"${target}" is not an E.164 phone and contacts.json is missing at ${CONTACTS_PATH}.`);
  }
  const contacts = JSON.parse(await fs.readFile(CONTACTS_PATH, 'utf8'));
  const keys = Object.keys(contacts).filter((k) => !k.startsWith('_'));
  const folded = fold(target);

  const exact = keys.find((k) => fold(k) === folded);
  if (exact) {
    const phone = contacts[exact];
    if (!/^\+\d{7,15}$/.test(phone)) throw new Error(`Phone for "${exact}" is not E.164: ${phone}`);
    return { phone, key: exact };
  }
  const matches = keys.filter((k) => fold(k).includes(folded));
  if (matches.length === 0) {
    throw new Error(`Contact "${target}" not found in contacts.json (${keys.length} entries).`);
  }
  if (matches.length === 1) {
    const k = matches[0];
    const phone = contacts[k];
    if (!/^\+\d{7,15}$/.test(phone)) throw new Error(`Phone for "${k}" is not E.164: ${phone}`);
    return { phone, key: k };
  }
  const shown = matches.slice(0, 20).map((k) => `  - ${k} -> ${contacts[k]}`).join('\n');
  const more = matches.length > 20 ? `\n  ... and ${matches.length - 20} more` : '';
  throw new Error(
    `Ambiguous: "${target}" matches ${matches.length} contacts:\n${shown}${more}\n` +
    `Pass a more specific name (or +phone directly).`
  );
}

function postSend(jid, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jid, text });
    const req = http.request(
      {
        host: DAEMON_HOST,
        port: DAEMON_PORT,
        method: 'POST',
        path: '/send',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || data}`));
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('daemon /send timed out (15s)')); });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        const startHint = process.platform === 'win32'
          ? `powershell -ExecutionPolicy Bypass -File ${path.join(__dirname, 'start.ps1')}`
          : `bash ${path.join(__dirname, 'start.sh')}`;
        reject(new Error(
          `daemon not reachable at ${DAEMON_HOST}:${DAEMON_PORT}. Start it: ${startHint}`
        ));
      } else reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function checkDaemonConnected() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, method: 'GET', path: '/health', timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'health timeout' }); });
    req.on('error', () => resolve({ ok: false, error: 'health unreachable' }));
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.text || (!args.to && !args.jid)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.to && args.jid) {
    console.error('ERROR: pass either --to or --jid, not both.');
    process.exit(1);
  }

  let jid;
  if (args.jid) {
    if (!JID_RE.test(args.jid)) {
      console.error(`ERROR: --jid must end with @s.whatsapp.net, @lid, or @g.us. Got: ${args.jid}`);
      process.exit(1);
    }
    jid = args.jid;
    console.log(`JID:      ${jid} (passed directly, no lookup)`);
  } else {
    const aliased = await tryResolveAlias(args.to);
    if (aliased) {
      jid = aliased.jid;
      console.log(`Resolved (alias): "${args.to}" -> ${aliased.key} (${jid})`);
    } else {
      const { phone, key } = await resolvePhone(args.to);
      jid = phoneToJid(phone);
      if (key !== phone) console.log(`Resolved: "${args.to}" -> ${key} (${phone})`);
      else console.log(`Resolved: "${args.to}" -> ${phone}`);
      console.log(`JID:      ${jid}`);
    }
  }
  console.log(`Message:  ${args.text}`);

  if (!args.confirmed) {
    console.log('\nDRY RUN. Re-run with --confirmed to actually send.');
    process.exit(0);
  }

  const health = await checkDaemonConnected();
  if (!health.ok || !health.connected) {
    console.error(`\nDaemon not connected to WhatsApp (health: ${JSON.stringify(health)}).`);
    const startHint = process.platform === 'win32'
      ? `powershell -ExecutionPolicy Bypass -File ${path.join(__dirname, 'start.ps1')}`
      : `bash ${path.join(__dirname, 'start.sh')}`;
    console.error('Start it:', startHint);
    process.exit(1);
  }

  const result = await postSend(jid, args.text);
  console.log(`\nSent. Message id: ${result.id}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
