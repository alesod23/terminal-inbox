#!/usr/bin/env node
// fetch-all.js — one-shot triage bundle.
// Spawns Gmail (carryover + fresh) per account, WA (triage + flap),
// Slack per workspace IN PARALLEL, reads state files, emits ONE JSON.
// Optional enrichment: per-thread Gmail get + per-group WA show-thread.
//
// Cross-platform: paths via os.homedir() + path.join. Python invoked directly
// (python3 on macOS/Linux, python on Windows; overridable via triage-config.json
// or TRIAGE_PYTHON env var).
//
// Usage:
//   node fetch-all.js [--scope all|gmail|wa|slack] [--no-enrich] [--hours N]
//
// Output: pretty JSON on stdout. Errors go to stderr; bundle still returns
// what succeeded so the caller can degrade gracefully.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const __scriptdir = __dirname;

// ---- config -------------------------------------------------------------
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

const CONFIG_PATH = path.join(__scriptdir, "triage-config.json");
const config = readJson(CONFIG_PATH, { gmail: { accounts: [] }, slack: { workspaces: [] } });
const GMAIL_ACCOUNTS = config?.gmail?.accounts || [];
const SLACK_WORKSPACES = config?.slack?.workspaces || [];
const PYTHON = process.env.TRIAGE_PYTHON
  || config?.python_cmd
  || (process.platform === "win32" ? "python" : "python3");

// Layout: this script lives in <repo>/triage/. wa-daemon and slack sit at
// known sibling locations. Allow override via env for non-default layouts.
const REPO_ROOT = path.dirname(__scriptdir);
const WA_DIR = process.env.TRIAGE_WA_DIR || path.join(REPO_ROOT, "wa-daemon");
const SLACK_DIR = process.env.TRIAGE_SLACK_DIR || path.join(REPO_ROOT, "slack");

const STATE_PATH = path.join(__scriptdir, "state.json");
const GMAIL_SCRIPT = path.join(__scriptdir, "gmail.py");
const SLACK_SCRIPT = path.join(SLACK_DIR, "slack.py");
const WA_TRIAGE = path.join(WA_DIR, "triage.js");
const WA_FLAP = path.join(WA_DIR, "check-flap.js");
const WA_SHOWTHREAD = path.join(WA_DIR, "show-thread.js");
const WA_STATE_PATH = path.join(WA_DIR, "wa-state.json");

// ---- CLI parse -----------------------------------------------------------
const args = process.argv.slice(2);
const opt = { scope: "all", enrich: true, hoursOverride: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--scope") opt.scope = args[++i];
  else if (a === "--no-enrich") opt.enrich = false;
  else if (a === "--hours") opt.hoursOverride = Number(args[++i]);
  else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: fetch-all [--scope all|gmail|wa|slack] [--no-enrich] [--hours N]\n",
    );
    process.exit(0);
  }
}
const wantGmail = (opt.scope === "all" || opt.scope === "gmail") && GMAIL_ACCOUNTS.length > 0;
const wantWa = opt.scope === "all" || opt.scope === "wa";
const wantSlack = (opt.scope === "all" || opt.scope === "slack") && SLACK_WORKSPACES.length > 0;

// ---- helpers -------------------------------------------------------------
function run(file, argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      argv,
      { maxBuffer: 50 * 1024 * 1024, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          err: err ? String(err.message || err) : null,
          stdout: stdout?.toString() || "",
          stderr: stderr?.toString() || "",
        });
      },
    );
  });
}

function parseJsonSafe(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---- main ----------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  const nowUnix = Math.floor(Date.now() / 1000);
  const errors = [];

  const triageState = readJson(STATE_PATH, {});
  const waState = readJson(WA_STATE_PATH, { todo: {}, done: {} });

  const lastCheckUnix =
    triageState.last_check_unix || triageState.last_triage_unix || nowUnix - 86400;
  const effectiveCutoffUnix = Math.max(lastCheckUnix, nowUnix - 86400);
  const hoursSinceLast =
    opt.hoursOverride ??
    Math.min(24, Math.max(1, Math.ceil((nowUnix - lastCheckUnix) / 3600)));

  // fan out — gmail labels, gmail searches, WA, slack, all in parallel
  const tasks = {};

  if (wantGmail) {
    for (const acct of GMAIL_ACCOUNTS) {
      tasks[`gmail_labels_${acct}`] = run(PYTHON, [GMAIL_SCRIPT, "list-labels", "--account", acct]);
      tasks[`gmail_todo_${acct}`] = run(PYTHON, [
        GMAIL_SCRIPT, "search", "--account", acct,
        "--query", "label:triage/todo -label:triage/done",
      ]);
      tasks[`gmail_fresh_${acct}`] = run(PYTHON, [
        GMAIL_SCRIPT, "search", "--account", acct,
        "--query", `is:unread after:${effectiveCutoffUnix} -label:triage/todo -label:triage/done`,
      ]);
    }
  }

  if (wantWa) {
    tasks.wa_triage = run("node", [WA_TRIAGE, "--hours", String(hoursSinceLast), "--json"]);
    tasks.wa_flap = run("node", [WA_FLAP]);
  }

  if (wantSlack) {
    for (const ws of SLACK_WORKSPACES) {
      tasks[`slack_${ws}`] = run(PYTHON, [
        SLACK_SCRIPT, "unread", "--workspace", ws,
        "--hours", String(hoursSinceLast),
      ]);
    }
  }

  const taskKeys = Object.keys(tasks);
  const settled = await Promise.all(taskKeys.map((k) => tasks[k]));
  const results = {};
  taskKeys.forEach((k, i) => (results[k] = settled[i]));

  // parse Gmail
  const gmail = {};
  function parseGmailLabels(stdout) {
    const map = {};
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      const [, id, name] = m;
      if (name.startsWith("triage/")) map[name.replace("triage/", "")] = id;
    }
    return map;
  }
  if (wantGmail) {
    for (const acct of GMAIL_ACCOUNTS) {
      const labels = parseGmailLabels(results[`gmail_labels_${acct}`].stdout);
      const todoRaw = parseJsonSafe(results[`gmail_todo_${acct}`].stdout, { threads: [] });
      const freshRaw = parseJsonSafe(results[`gmail_fresh_${acct}`].stdout, { threads: [] });
      if (!results[`gmail_todo_${acct}`].ok)
        errors.push({ source: `gmail_todo_${acct}`, err: results[`gmail_todo_${acct}`].err });
      if (!results[`gmail_fresh_${acct}`].ok)
        errors.push({ source: `gmail_fresh_${acct}`, err: results[`gmail_fresh_${acct}`].err });
      gmail[acct] = {
        label_ids: labels,
        todo: todoRaw.threads || [],
        fresh: freshRaw.threads || [],
      };
    }
  }

  // parse WA
  let wa = null;
  if (wantWa) {
    const waJson = parseJsonSafe(results.wa_triage.stdout, null);
    const flapJson = parseJsonSafe(results.wa_flap.stdout, {
      disc5m: 0, replaced60m: 0, lastReason: "",
    });
    if (!waJson) {
      errors.push({ source: "wa_triage", err: results.wa_triage.err || "parse failed" });
      wa = { ok: false, items: [], state: waState, flap: flapJson };
    } else {
      wa = {
        ok: true,
        generated_at: waJson.generated_at,
        daemon_pid_alive: waJson.daemon_pid_alive,
        daemon_heartbeat_age_sec: waJson.daemon_heartbeat_age_sec,
        flap: flapJson,
        items: waJson.items || [],
        state: waState,
      };
    }
  }

  // parse Slack
  const slack = {};
  if (wantSlack) {
    for (const ws of SLACK_WORKSPACES) {
      const r = results[`slack_${ws}`];
      const j = parseJsonSafe(r.stdout, null);
      if (!j) {
        errors.push({ source: `slack_${ws}`, err: r.err || r.stderr || "parse failed" });
        slack[ws] = { ok: false, dm_recent: [], mentions: [], channel_recent: [] };
      } else {
        slack[ws] = { ok: true, ...j };
      }
    }
  }

  // enrichment (default ON)
  const enrichTasks = {};
  if (opt.enrich && wa?.items) {
    for (const it of wa.items) {
      if (it.isGroup && it.count && it.count > 1 && it.jid !== "status@broadcast") {
        enrichTasks[`wa_burst_${it.jid}`] = run("node", [
          WA_SHOWTHREAD, "--jid", it.jid, "--limit", String(Math.min(it.count, 20)),
        ]);
      } else if (!it.isGroup && it.repliedSinceLastIncoming === false) {
        enrichTasks[`wa_burst_${it.jid}`] = run("node", [
          WA_SHOWTHREAD, "--jid", it.jid, "--limit", "4",
        ]);
      }
    }
  }
  if (opt.enrich && wantGmail) {
    for (const acct of GMAIL_ACCOUNTS) {
      for (const t of gmail[acct]?.fresh || []) {
        enrichTasks[`gmail_get_${acct}_${t.id}`] = run(PYTHON, [
          GMAIL_SCRIPT, "get", "--account", acct, "--thread-id", t.id,
        ]);
      }
    }
  }

  const enrichKeys = Object.keys(enrichTasks);
  const enrichSettled = await Promise.all(enrichKeys.map((k) => enrichTasks[k]));
  const enrich = {};
  enrichKeys.forEach((k, i) => (enrich[k] = enrichSettled[i]));

  // merge enrichment
  if (opt.enrich && wa?.items) {
    for (const it of wa.items) {
      const e = enrich[`wa_burst_${it.jid}`];
      if (e?.ok) it.burst = e.stdout.trim().split(/\r?\n/);
    }
  }
  if (opt.enrich && wantGmail) {
    for (const acct of GMAIL_ACCOUNTS) {
      for (const t of gmail[acct]?.fresh || []) {
        const e = enrich[`gmail_get_${acct}_${t.id}`];
        if (!e?.ok) continue;
        const tj = parseJsonSafe(e.stdout, null);
        if (!tj?.messages?.length) continue;
        let latestIn = null, subject = null, fromHeader = null;
        for (const m of tj.messages) {
          const labels = m.labelIds || [];
          const isSent = labels.includes("SENT");
          const headers = m.payload?.headers || [];
          const h = (n) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
          if (subject == null) subject = h("Subject");
          if (!isSent) {
            const ts = Number(m.internalDate) / 1000;
            if (!latestIn || ts > latestIn.ts) {
              latestIn = { ts, from: h("From"), date: h("Date"), snippet: m.snippet };
              fromHeader = h("From");
            }
          }
        }
        t.subject = subject;
        t.from = fromHeader;
        t.latest_incoming_unix = latestIn?.ts || null;
        t.latest_incoming_snippet = latestIn?.snippet || null;
        t.within_24h = latestIn ? latestIn.ts >= effectiveCutoffUnix : false;
      }
    }
  }

  // post-filter: drop fresh Gmail items whose latest incoming is outside 24h
  if (opt.enrich && wantGmail) {
    for (const acct of GMAIL_ACCOUNTS) {
      gmail[acct].fresh_dropped_24h = gmail[acct].fresh.filter((t) => t.within_24h === false);
      gmail[acct].fresh = gmail[acct].fresh.filter((t) => t.within_24h !== false);
    }
  }
  if (wa?.items) {
    wa.items_dropped_24h = wa.items.filter(
      (it) => it.lastIn?.timestamp && it.lastIn.timestamp < effectiveCutoffUnix,
    );
    wa.items = wa.items.filter(
      (it) => !it.lastIn?.timestamp || it.lastIn.timestamp >= effectiveCutoffUnix,
    );
  }
  if (wantSlack) {
    for (const ws of SLACK_WORKSPACES) {
      const w = slack[ws];
      if (!w || !w.ok) continue;
      const tsNum = (m) => {
        const v = m?.ts ?? m?.timestamp;
        return v == null ? null : Number(v);
      };
      const keep = (m) => {
        const t = tsNum(m);
        return t == null || t >= effectiveCutoffUnix;
      };
      const dropped = { dm_recent: [], mentions: [], channel_recent: [] };
      for (const k of ["dm_recent", "mentions"]) {
        if (!Array.isArray(w[k])) continue;
        dropped[k] = w[k].filter((m) => !keep(m));
        w[k] = w[k].filter(keep);
      }
      if (Array.isArray(w.channel_recent)) {
        const kept = [];
        for (const ch of w.channel_recent) {
          const previewKept = (ch.preview || []).filter(keep);
          const previewDropped = (ch.preview || []).filter((m) => !keep(m));
          if (previewDropped.length) dropped.channel_recent.push({ ...ch, preview: previewDropped });
          if (previewKept.length) kept.push({ ...ch, preview: previewKept });
        }
        w.channel_recent = kept;
      }
      w.dropped_24h = dropped;
    }
  }

  // bundle + emit
  const bundle = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    now: { unix: nowUnix, iso: new Date(nowUnix * 1000).toISOString() },
    cutoff: {
      last_check_unix: lastCheckUnix,
      last_check_at: triageState.last_check_at || triageState.last_triage_at || null,
      effective_unix: effectiveCutoffUnix,
      effective_iso: new Date(effectiveCutoffUnix * 1000).toISOString(),
      hours_since_last: hoursSinceLast,
    },
    config: { gmail_accounts: GMAIL_ACCOUNTS, slack_workspaces: SLACK_WORKSPACES },
    gmail: wantGmail ? gmail : null,
    wa,
    slack: wantSlack ? slack : null,
    errors,
  };
  process.stdout.write(JSON.stringify(bundle, null, 2));
  process.stdout.write("\n");
})().catch((e) => {
  process.stderr.write(`fetch-all fatal: ${e.stack || e}\n`);
  process.exit(1);
});
