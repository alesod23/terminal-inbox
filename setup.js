#!/usr/bin/env node
// setup.js — interactive wizard to get /triage running from a fresh clone.
//
// Steps:
//   1. Prerequisite check (Node, Python, npm)
//   2. WhatsApp pairing (QR or pairing-code)
//   3. Gmail OAuth (per account)
//   4. Slack OAuth (per workspace, optional)
//   5. Channel classification (WA groups, Slack channels)
//   6. Write configs + start daemon
//
// Cross-platform. No deps beyond Node built-ins.
// Re-runnable: skip pairing if already paired, skip OAuth if token exists, etc.

const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const ROOT = __dirname;
const WA_DIR = path.join(ROOT, "wa-daemon");
const TRIAGE_DIR = path.join(ROOT, "triage");
const SLACK_DIR = path.join(ROOT, "slack");
const TRIAGE_CONFIG = path.join(TRIAGE_DIR, "triage-config.json");
const WA_AUTH_DIR = path.join(WA_DIR, "auth");
const WA_CHATS = path.join(WA_DIR, "chats.json");
const WA_BLOCK = path.join(WA_DIR, "wa-groups-block.json");
const WA_PID = path.join(WA_DIR, "daemon.pid");

// ANSI styling. Disabled if NO_COLOR set or stdout is not a TTY.
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  blue: useColor ? "\x1b[34m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};
const banner = (s) => console.log(`\n${c.bold}${c.blue}== ${s} ==${c.reset}\n`);
const ok = (s) => console.log(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => console.log(`${c.yellow}!${c.reset} ${s}`);
const fail = (s) => console.log(`${c.red}✗${c.reset} ${s}`);
const dim = (s) => console.log(`${c.dim}${s}${c.reset}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const yes = async (q, def = true) => {
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${q} ${hint} `)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
};

// ---- Python detection ----------------------------------------------------
function detectPython() {
  const envOverride = process.env.TRIAGE_PYTHON;
  if (envOverride) {
    if (testPython(envOverride)) return envOverride;
    warn(`TRIAGE_PYTHON=${envOverride} did not respond to --version; ignoring`);
  }
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const p of candidates) if (testPython(p)) return p;
  return null;
}
function testPython(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    if (r.status !== 0) return false;
    const out = (r.stdout?.toString() || "") + (r.stderr?.toString() || "");
    // Reject MS Store stub (it prints "Python was not found...").
    if (/Microsoft Store/i.test(out) || /was not found/i.test(out)) return false;
    return /Python\s+3\.(8|9|1\d|2\d)/.test(out);
  } catch { return false; }
}

// ---- subprocess helpers --------------------------------------------------
function runForeground(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "", err: r.error };
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }

// ---- step 1: prereqs -----------------------------------------------------
async function stepPrereqs() {
  banner("Step 1/6: Prerequisites");
  const nodeMajor = Number(process.version.replace(/^v/, "").split(".")[0]);
  if (nodeMajor < 18) { fail(`Node ${process.version} is too old (need 18+).`); return null; }
  ok(`Node ${process.version}`);

  if (!fs.existsSync(path.join(WA_DIR, "node_modules"))) {
    dim("Installing wa-daemon dependencies (one-time, ~30s)...");
    const installed = await runForeground("npm", ["install", "--silent"], { cwd: WA_DIR });
    if (!installed) { fail("npm install failed inside wa-daemon/. Check Node/npm setup."); return null; }
  }
  ok("wa-daemon dependencies installed");

  const pythonCmd = detectPython();
  if (!pythonCmd) {
    fail("Python 3.8+ not found on PATH.");
    if (process.platform === "win32") {
      dim("On Windows, install from python.org (not the Microsoft Store — that one stubs out).");
    } else {
      dim("On macOS: `brew install python3`. On Linux: your package manager.");
    }
    return null;
  }
  ok(`Python: ${pythonCmd}`);
  return { pythonCmd };
}

// ---- step 2: WhatsApp ----------------------------------------------------
async function stepWhatsApp() {
  banner("Step 2/6: WhatsApp");
  const credsFile = path.join(WA_AUTH_DIR, "creds.json");
  if (fs.existsSync(credsFile)) {
    ok("Already paired (auth/creds.json present).");
    const re = await yes("Re-pair from scratch?", false);
    if (!re) return true;
    fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
  }
  const enable = await yes("Pair WhatsApp now?", true);
  if (!enable) { warn("Skipped. /triage will run without WhatsApp."); return false; }

  const mode = await ask("QR code (recommended) or pairing code? [qr/pair] (default: qr) ");
  const useQR = !mode || mode.toLowerCase() === "qr" || mode.toLowerCase() === "q";

  let args = [];
  if (!useQR) {
    const phone = await ask("Phone number in E.164 (e.g. +14155551234): ");
    if (!/^\+\d{7,15}$/.test(phone)) { fail("Bad phone format. Skipping WA."); return false; }
    args = ["--phone", phone];
  }

  console.log();
  dim("Launching login. Follow on-screen instructions. (^C to abort.)");
  const success = await runForeground("node", [path.join(WA_DIR, "login.js"), ...args]);
  if (!success) { fail("Pairing failed."); return false; }
  ok("WhatsApp paired.");
  return true;
}

// ---- step 3: Gmail -------------------------------------------------------
async function stepGmail(pythonCmd) {
  banner("Step 3/6: Gmail");
  const credPath = path.join(TRIAGE_DIR, "credentials.json");
  if (!fs.existsSync(credPath)) {
    warn("triage/credentials.json missing — needed for Gmail OAuth.");
    console.log("\nCreate a Google OAuth client (one-time, takes ~3 min):");
    console.log("  1. Go to https://console.cloud.google.com/projectcreate and make a project");
    console.log("  2. Enable the Gmail API: https://console.cloud.google.com/apis/library/gmail.googleapis.com");
    console.log("  3. Configure OAuth consent (External, Testing — add yourself as a test user)");
    console.log("  4. Credentials -> Create Credentials -> OAuth Client ID -> Desktop app");
    console.log("  5. Download the JSON and save it as:");
    console.log(`     ${c.cyan}${credPath}${c.reset}`);
    console.log(`     (shape shown in triage/oauth-client.example.json)\n`);
    const ready = await yes("Done? Continue with Gmail setup?", false);
    if (!ready) { warn("Skipped Gmail."); return []; }
    if (!fs.existsSync(credPath)) { fail("Still no credentials.json. Skipping Gmail."); return []; }
  }

  const accounts = [];
  while (true) {
    const name = await ask("Gmail account nickname (e.g. 'work', 'personal') — or blank to finish: ");
    if (!name) break;
    if (!/^[a-z0-9_-]+$/i.test(name)) { fail("Use letters/digits/dash/underscore only."); continue; }
    if (accounts.includes(name)) { warn("Already added."); continue; }
    const tokenPath = path.join(TRIAGE_DIR, "tokens", `${name}.json`);
    if (fs.existsSync(tokenPath)) {
      ok(`Token already exists for "${name}".`);
      accounts.push(name);
      continue;
    }
    console.log(`Opening browser for OAuth. Approve in browser, then return here.`);
    const success = await runForeground(pythonCmd,
      [path.join(TRIAGE_DIR, "gmail.py"), "auth", "--account", name]);
    if (!success) { fail(`Auth failed for ${name}.`); continue; }
    ok(`Authed: ${name}`);
    accounts.push(name);
  }
  return accounts;
}

// ---- step 4: Slack -------------------------------------------------------
async function stepSlack(pythonCmd) {
  banner("Step 4/6: Slack (optional)");
  const enable = await yes("Add a Slack workspace?", false);
  if (!enable) return [];

  const credPath = path.join(SLACK_DIR, "credentials.json");
  if (!fs.existsSync(credPath)) {
    warn("slack/credentials.json missing — needed for Slack OAuth.");
    console.log("\nCreate a Slack app (one-time, ~5 min):");
    console.log("  1. https://api.slack.com/apps -> Create New App -> From scratch");
    console.log("  2. OAuth & Permissions -> add user scopes: channels:history, groups:history,");
    console.log("     im:history, mpim:history, users:read, search:read, chat:write");
    console.log("  3. Add redirect URL http://localhost:53682/");
    console.log("  4. Copy Client ID and Client Secret into:");
    console.log(`     ${c.cyan}${credPath}${c.reset}`);
    console.log(`     (shape shown in slack/oauth-client.example.json)\n`);
    const ready = await yes("Done? Continue?", false);
    if (!ready || !fs.existsSync(credPath)) { warn("Skipped Slack."); return []; }
  }

  const workspaces = [];
  while (true) {
    const name = await ask("Slack workspace nickname (e.g. 'work') — or blank to finish: ");
    if (!name) break;
    if (!/^[a-z0-9_-]+$/i.test(name)) { fail("Use letters/digits/dash/underscore only."); continue; }
    if (workspaces.includes(name)) { warn("Already added."); continue; }
    const tokenPath = path.join(SLACK_DIR, "tokens", `${name}.json`);
    if (fs.existsSync(tokenPath)) {
      ok(`Token already exists for "${name}".`);
      workspaces.push(name);
      continue;
    }
    const success = await runForeground(pythonCmd,
      [path.join(SLACK_DIR, "slack.py"), "auth", "--workspace", name]);
    if (!success) { fail(`Auth failed for ${name}.`); continue; }
    ok(`Authed: ${name}`);
    workspaces.push(name);
  }
  return workspaces;
}

// ---- step 5: channel classification --------------------------------------
function isDaemonRunning() {
  if (!fs.existsSync(WA_PID)) return false;
  const pid = Number(fs.readFileSync(WA_PID, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startDaemonIfNeeded() {
  if (isDaemonRunning()) { ok("Daemon already running."); return true; }
  dim("Starting WA daemon to sync your groups + contacts (~20s)...");
  const log = path.join(WA_DIR, "daemon.log");
  const child = spawn("node", [path.join(WA_DIR, "daemon.js")], {
    cwd: WA_DIR,
    detached: true,
    stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log + ".err", "a")],
  });
  child.unref();
  // Wait for chats.json to fill in with @g.us entries.
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const chats = readJson(WA_CHATS, {});
    const groups = Object.keys(chats).filter((j) => j.endsWith("@g.us"));
    if (groups.length > 0) { ok(`Daemon synced ${groups.length} groups.`); return true; }
  }
  warn("Daemon didn't sync groups within 60s. Classification will be empty — re-run wizard later.");
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function stepClassifyWAGroups(waEnabled) {
  if (!waEnabled) return [];
  banner("Step 5a/6: WhatsApp group classification");
  console.log("Skip groups so they don't clog your /triage list.");
  console.log("Marking a group as SKIP only filters it from triage — you'll still get notifications on your phone.\n");

  await startDaemonIfNeeded();
  const chats = readJson(WA_CHATS, {});
  const groups = Object.entries(chats)
    .filter(([jid]) => jid.endsWith("@g.us"))
    .map(([jid, name]) => ({ jid, name: name || "(unnamed)" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!groups.length) { warn("No groups synced. Skipping classification."); return []; }
  console.log(`Found ${groups.length} groups.`);
  const reviewLimit = Math.min(groups.length, 40);
  if (groups.length > reviewLimit) {
    dim(`(Showing first ${reviewLimit}. Edit wa-daemon/wa-groups-block.json later to add more.)`);
  }

  const blocked = [];
  for (let i = 0; i < reviewLimit; i++) {
    const g = groups[i];
    const a = (await ask(`  [${i + 1}/${reviewLimit}] ${g.name} — keep/skip? [K/s/q] `)).toLowerCase();
    if (a === "q") break;
    if (a === "s" || a === "skip") blocked.push({ jid: g.jid, name: g.name, reason: "wizard" });
  }
  writeJson(WA_BLOCK, { blocked });
  ok(`Wrote ${blocked.length} group(s) to wa-groups-block.json`);
  return blocked;
}

async function stepClassifySlackChannels(pythonCmd, workspaces) {
  if (!workspaces.length) return {};
  banner("Step 5b/6: Slack channel classification");
  const muted = {};
  for (const ws of workspaces) {
    const res = runCapture(pythonCmd, [path.join(SLACK_DIR, "slack.py"), "list-channels", "--workspace", ws]);
    if (!res.ok) { warn(`Couldn't list channels for ${ws}: ${res.stderr.trim()}`); continue; }
    const channels = res.stdout.split(/\r?\n/).filter(Boolean).slice(0, 40);
    if (!channels.length) { warn(`No channels for ${ws}.`); continue; }
    console.log(`\n  ${c.cyan}${ws}${c.reset} — ${channels.length} channels (showing first 40):`);
    const wsMuted = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const a = (await ask(`    [${i + 1}/${channels.length}] ${ch} — keep/skip? [K/s/q] `)).toLowerCase();
      if (a === "q") break;
      if (a === "s" || a === "skip") wsMuted.push(ch);
    }
    muted[ws] = wsMuted;
  }
  const mutePath = path.join(SLACK_DIR, "mute.json");
  writeJson(mutePath, muted);
  ok(`Wrote slack/mute.json`);
  return muted;
}

// ---- step 6: write final config + summary --------------------------------
function stepWriteConfig({ pythonCmd, gmailAccounts, slackWorkspaces }) {
  banner("Step 6/6: Writing config");
  const existing = readJson(TRIAGE_CONFIG, {});
  const cfg = {
    schema_version: 1,
    python_cmd: existing.python_cmd || (process.platform === "win32" ? pythonCmd : null),
    gmail: { accounts: gmailAccounts },
    slack: { workspaces: slackWorkspaces },
  };
  writeJson(TRIAGE_CONFIG, cfg);
  ok(`Wrote ${TRIAGE_CONFIG}`);
}

function printSummary({ waEnabled, gmailAccounts, slackWorkspaces }) {
  banner("Done");
  console.log(`WhatsApp:    ${waEnabled ? c.green + "paired" : c.dim + "skipped"}${c.reset}`);
  console.log(`Gmail:       ${gmailAccounts.length ? c.green + gmailAccounts.join(", ") : c.dim + "none"}${c.reset}`);
  console.log(`Slack:       ${slackWorkspaces.length ? c.green + slackWorkspaces.join(", ") : c.dim + "none"}${c.reset}`);
  console.log();
  console.log("Next:");
  if (waEnabled) {
    const startCmd = process.platform === "win32"
      ? `powershell -ExecutionPolicy Bypass -File ${path.join(WA_DIR, "start.ps1")}`
      : `bash ${path.join(WA_DIR, "start.sh")}`;
    console.log(`  - WA daemon: ${c.cyan}${startCmd}${c.reset}  (register as autostart for hands-free running)`);
  }
  console.log(`  - Try it: open Claude Code in this repo and type ${c.cyan}/triage${c.reset}.`);
  console.log(`  - Edit ${c.cyan}${TRIAGE_CONFIG}${c.reset} anytime to add/remove accounts.`);
  console.log();
}

// ---- main ----------------------------------------------------------------
async function main() {
  console.log(`${c.bold}triage setup${c.reset}`);
  console.log(`Repo: ${ROOT}`);
  console.log(`OS:   ${process.platform} / ${os.release()}`);

  const pre = await stepPrereqs();
  if (!pre) { rl.close(); process.exit(1); }

  const waEnabled = await stepWhatsApp();
  const gmailAccounts = await stepGmail(pre.pythonCmd);
  const slackWorkspaces = await stepSlack(pre.pythonCmd);
  await stepClassifyWAGroups(waEnabled);
  await stepClassifySlackChannels(pre.pythonCmd, slackWorkspaces);
  stepWriteConfig({ pythonCmd: pre.pythonCmd, gmailAccounts, slackWorkspaces });
  printSummary({ waEnabled, gmailAccounts, slackWorkspaces });

  rl.close();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
