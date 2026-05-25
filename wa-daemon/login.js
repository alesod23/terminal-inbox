import baileys, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcodeTerminal from 'qrcode-terminal';

const makeWASocket = baileys.default ?? baileys;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth');

function platformBrowser() {
  if (process.platform === 'darwin') return Browsers.macOS('Chrome');
  if (process.platform === 'linux') return Browsers.ubuntu('Chrome');
  return Browsers.windows('Chrome');
}

function usage() {
  console.log('Usage:');
  console.log('  node login.js                    # QR mode (default)');
  console.log('  node login.js --phone +<E.164>   # Pairing-code mode');
  console.log('');
  console.log('QR mode: scan from phone -> WhatsApp -> Settings -> Linked Devices.');
  console.log('Pairing-code mode: enter the 8-digit code on phone instead of scanning.');
}

function parseArgs(argv) {
  const out = { mode: 'qr' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phone') { out.mode = 'pair'; out.phone = argv[++i]; }
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--') && /^\+\d{7,15}$/.test(a)) {
      // Back-compat: bare phone arg = pairing-code mode.
      out.mode = 'pair';
      out.phone = a;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  if (args.mode === 'pair') {
    if (!args.phone || !/^\+\d{7,15}$/.test(args.phone)) {
      console.error('ERROR: --phone must be E.164 (e.g. +14155551234)');
      usage();
      process.exit(1);
    }
  }
  const phoneDigits = args.phone ? args.phone.replace(/^\+/, '') : null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (state.creds.registered) {
    console.log('Already registered. Auth dir:', AUTH_DIR);
    console.log('To re-pair from scratch, delete the auth/ folder and re-run.');
    process.exit(0);
  }

  let codeRequested = false;
  let qrShown = false;
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      browser: platformBrowser(),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);

    const result = await new Promise((resolve) => {
      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        // QR mode: each `qr` event is a new QR string. Render it in the terminal.
        if (qr && args.mode === 'qr') {
          if (!qrShown) {
            console.log('\nScan this QR with WhatsApp on your phone:');
            console.log('  Settings -> Linked Devices -> Link a Device\n');
            qrShown = true;
          }
          qrcodeTerminal.generate(qr, { small: true });
          console.log('(QR refreshes every ~30s. Scan within the window.)\n');
        }
        // Pairing-code mode: request a code after the socket comes up.
        if (args.mode === 'pair' && !sock.authState.creds.registered && !codeRequested) {
          codeRequested = true;
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const code = await sock.requestPairingCode(phoneDigits);
            const formatted = code.match(/.{1,4}/g)?.join('-') ?? code;
            console.log('\n=== PAIRING CODE ===');
            console.log(`  ${formatted}`);
            console.log('====================\n');
            console.log('On your phone: WhatsApp -> Settings -> Linked Devices');
            console.log('  -> Link a Device -> Link with phone number instead');
            console.log('  -> Enter the code above.\n');
            console.log('Waiting...');
          } catch (err) {
            console.error('Failed to request pairing code:', err.message);
            resolve({ kind: 'error' });
          }
        }
        if (connection === 'open') resolve({ kind: 'open', user: sock.user });
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) resolve({ kind: 'loggedOut' });
          else if (code === DisconnectReason.restartRequired) resolve({ kind: 'restart' });
          else resolve({ kind: 'close', code });
        }
      });
    });

    try { sock.end(undefined); } catch {}

    if (result.kind === 'open') {
      console.log(`\nLogged in as: ${result.user?.name || result.user?.id || 'unknown'}`);
      console.log(`Auth saved to: ${AUTH_DIR}`);
      process.exit(0);
    }
    if (result.kind === 'loggedOut' || result.kind === 'error') {
      console.error('Login failed. Wipe auth/ and retry.');
      process.exit(1);
    }
    if (result.kind === 'restart') {
      console.log(`(restart required, reconnecting... ${attempt}/${MAX_ATTEMPTS})`);
      qrShown = false;
      continue;
    }
    console.error(`Closed unexpectedly (code=${result.code}). Retrying...`);
    qrShown = false;
  }
  console.error('Too many reconnect attempts.');
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
