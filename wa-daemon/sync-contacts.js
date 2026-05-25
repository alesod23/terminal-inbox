import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, 'google-token.json');
// Reuse the Gmail OAuth client (sibling triage/ dir). Override with TRIAGE_CREDS.
const CREDS_PATH = process.env.TRIAGE_CREDS
  || path.join(__dirname, '..', 'triage', 'credentials.json');
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const PHONE_TYPE_PRIORITY = {
  mobile: 0, iphone: 0, main: 1, work: 2, home: 3, other: 4,
};

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') args.region = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.cmd) args.cmd = a;
  }
  args.region ??= process.env.TRIAGE_REGION || 'US';
  args.output ??= CONTACTS_PATH;
  return args;
}

function usage() {
  console.log('Usage:');
  console.log('  node sync-contacts.js auth                          # one-time OAuth (browser flow)');
  console.log('  node sync-contacts.js sync [--region IT] [--output path] [--dry-run]');
  console.log('');
  console.log('Default output: ' + CONTACTS_PATH);
  console.log('Default region for unqualified phones: US (override with --region, e.g. IT, GB, DE)');
}

async function loadSavedClient() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const content = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
    return google.auth.fromJSON(content);
  } catch {
    return null;
  }
}

async function persistClient(client) {
  const content = JSON.parse(await fs.readFile(CREDS_PATH, 'utf8'));
  const key = content.installed || content.web;
  await fs.writeFile(
    TOKEN_PATH,
    JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }, null, 2)
  );
}

async function authorize({ forceNew = false } = {}) {
  if (!forceNew) {
    const saved = await loadSavedClient();
    if (saved) return saved;
  }
  if (!existsSync(CREDS_PATH)) {
    throw new Error(`Missing OAuth credentials at ${CREDS_PATH}`);
  }
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDS_PATH });
  if (client.credentials?.refresh_token) await persistClient(client);
  return client;
}

function normalize(raw, region) {
  try {
    const parsed = parsePhoneNumberFromString(raw, region);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.format('E.164');
  } catch {
    return null;
  }
}

function pickPhones(person, region) {
  const phones = person.phoneNumbers || [];
  const cleaned = [];
  for (const p of phones) {
    const e164 = normalize(p.value || '', region);
    if (!e164) continue;
    const ptype = (p.type || 'other').toLowerCase();
    const isPrimary = !!p.metadata?.primary;
    cleaned.push({
      sortKey: [isPrimary ? 0 : 1, PHONE_TYPE_PRIORITY[ptype] ?? 5],
      ptype,
      e164,
    });
  }
  cleaned.sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1]);
  const seen = new Set();
  const out = [];
  for (const c of cleaned) {
    if (seen.has(c.e164)) continue;
    seen.add(c.e164);
    out.push({ ptype: c.ptype, e164: c.e164 });
  }
  return out;
}

function displayName(person) {
  const names = person.names || [];
  if (!names.length) return null;
  return (names[0].displayName || '').trim() || null;
}

async function listAllConnections(svc) {
  const all = [];
  let pageToken;
  do {
    const res = await svc.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'names,phoneNumbers',
      pageToken,
    });
    if (res.data.connections) all.push(...res.data.connections);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

function buildContactMap(connections, region) {
  const stats = { skippedNoName: 0, skippedNoPhone: 0, skippedInvalidPhone: 0 };
  const nameToEntries = new Map();
  for (const person of connections) {
    const name = displayName(person);
    if (!name) { stats.skippedNoName++; continue; }
    const phones = pickPhones(person, region);
    if (!phones.length) {
      const raw = person.phoneNumbers || [];
      if (raw.length) stats.skippedInvalidPhone++;
      else stats.skippedNoPhone++;
      continue;
    }
    phones.forEach((ph, idx) => {
      const key = idx === 0 ? name : `${name} (${ph.ptype})`;
      const list = nameToEntries.get(key) || [];
      list.push(ph.e164);
      nameToEntries.set(key, list);
    });
  }

  const flat = {};
  for (const [key, numbers] of nameToEntries) {
    if (numbers.length === 1) {
      flat[key] = numbers[0];
    } else {
      for (const n of numbers) {
        flat[`${key} #${n.slice(-4)}`] = n;
      }
    }
  }
  return { flat, stats };
}

async function cmdAuth() {
  const auth = await authorize({ forceNew: true });
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const info = (await oauth2.userinfo.get()).data;
  console.log(`Authenticated as: ${info.email}`);
  console.log(`Token saved: ${TOKEN_PATH}`);
}

async function cmdSync(args) {
  const auth = await authorize();
  const svc = google.people({ version: 'v1', auth });
  console.log('Pulling contacts from Google...');
  const connections = await listAllConnections(svc);
  console.log(`  ${connections.length} raw contacts`);
  const { flat, stats } = buildContactMap(connections, args.region);
  console.log(`  -> ${Object.keys(flat).length} usable phone entries`);
  if (stats.skippedNoName) console.log(`  skipped (no name): ${stats.skippedNoName}`);
  if (stats.skippedNoPhone) console.log(`  skipped (no phone): ${stats.skippedNoPhone}`);
  if (stats.skippedInvalidPhone) console.log(`  skipped (unparseable phone): ${stats.skippedInvalidPhone}`);

  const sortedFlat = Object.fromEntries(
    Object.entries(flat).sort(([a], [b]) => a.localeCompare(b))
  );
  const output = {
    _meta: {
      synced_at: new Date().toISOString(),
      source: 'google_people_api',
      default_region: args.region,
      total_entries: Object.keys(flat).length,
    },
    ...sortedFlat,
  };

  if (args.dryRun) {
    const txt = JSON.stringify(output, null, 2);
    console.log('\n--- DRY RUN ---');
    console.log(txt.slice(0, 2000));
    if (txt.length > 2000) console.log('... (truncated)');
    return;
  }

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(output, null, 2));
  console.log(`\nWrote: ${args.output}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.cmd) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.cmd === 'auth') return cmdAuth();
  if (args.cmd === 'sync') return cmdSync(args);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error('ERROR:', err.message || err);
  if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('has not been used')) {
    console.error('\nThe People API may not be enabled in your Google Cloud project.');
    console.error('Enable it here: https://console.cloud.google.com/apis/library/people.googleapis.com');
  }
  process.exit(1);
});
