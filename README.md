# triage — a terminal-native unified inbox

A `/triage` skill for Claude Code. Fans out across Gmail (multi-account),
WhatsApp (DMs + groups), and Slack (multi-workspace); prints one compact
actionable list; then asks one question per item where you can mark it done,
push it to your to-do, send a pre-composed reply, or type your own. No SaaS,
no extra tabs. Everything runs locally; the only network calls are to Gmail,
WhatsApp, Slack themselves.

> **Status.** Hand-built for personal use, shared as-is. Tested on Windows.
> Mac path written to spec but not verified — expect minor Mac-side polishing.

## What it does

```
$ /triage
4 actionable items (since 09:14 today):

1. [gm:work] alice@acme.com — Re: contract review
   Bumping this. Can you confirm the indemnity clause by EOD?

2. [wg] Investor update — Jordan (+3 msgs)
   Great. Let's lock the term sheet today. Sending paper at 3.

3. [s@] #eng-deploy — @here prod migration tonight, who's on?

4. [wa] Mom
   Are you coming for dinner Sunday?

Actions? (one per item, e.g. "1 done, 2 todo, 3 reply: yes, 4 reply: yes")
```

You reply once. The skill does the rest — Gmail labels, WA `wa-state.json`,
Slack cutoff. Next round, nothing already-handled re-surfaces.

## Quick start

```bash
git clone <this-repo>
cd <repo>
node setup.js
```

The wizard walks you through:

1. **Prereqs** — checks Node ≥ 18 and Python 3.8+, runs `npm install` in `wa-daemon/`.
2. **WhatsApp** — pairs via QR code (or pairing-code if you prefer). Scan from
   phone → WhatsApp → Settings → Linked Devices.
3. **Gmail** — one OAuth flow per account you want to triage. Opens browser,
   you click Allow, token stored locally.
4. **Slack** — same shape, per workspace. Optional.
5. **Channel classification** — scans your WA groups + Slack channels and
   asks which to skip from `/triage`. Writes `wa-daemon/wa-groups-block.json`
   and `slack/mute.json`. Skip ≠ mute on phone; you still see notifications,
   just not in `/triage`.
6. **Done** — daemon is running, configs are written, `/triage` works.

Re-run `node setup.js` anytime to add an account, re-pair WhatsApp, or
re-classify channels.

## Manual setup (if the wizard fails for you)

### Prereqs

- **Mac:** `brew install node python3`
- **Windows:** install Node from nodejs.org and Python from **python.org**
  (NOT the Microsoft Store — it stubs out and breaks subprocess calls).
- **Linux:** your package manager.

### WhatsApp

```bash
cd wa-daemon
npm install
node login.js          # QR mode (default)
# or: node login.js --phone +14155551234   # pairing-code mode
```

Then start the daemon:

```bash
# Mac / Linux
bash wa-daemon/start.sh
# Windows
powershell -ExecutionPolicy Bypass -File wa-daemon\start.ps1
```

The daemon listens on `127.0.0.1:4119` for outbound sends and owns the
Baileys session. Don't start multiple copies — WhatsApp's multi-device
sync doesn't like it.

For hands-free running: register the start script with your OS scheduler
(launchd on Mac, Task Scheduler on Windows). Sample plist + scheduled-task
XML are NOT included in this repo — see your OS docs.

### Gmail

1. Google Cloud Console → create a project → enable the Gmail API → configure
   OAuth consent (External, Testing mode is fine for personal use; add your
   own email as a test user).
2. Credentials → Create Credentials → OAuth Client ID → **Desktop app**.
3. Download the JSON, save as `triage/credentials.json` (shape shown in
   `triage/oauth-client.example.json`).
4. For each account:

   ```bash
   cd triage
   python3 gmail.py auth --account work       # Mac / Linux
   python gmail.py auth --account work        # Windows
   ```

   Each call opens a browser, you Allow, token written to `triage/tokens/work.json`.

### Slack (optional)

1. api.slack.com/apps → Create New App → From scratch.
2. OAuth & Permissions → add **user scopes**: `channels:history`,
   `groups:history`, `im:history`, `mpim:history`, `users:read`,
   `search:read`, `chat:write`.
3. Redirect URL: `http://localhost:53682/`
4. Copy Client ID + Client Secret into `slack/credentials.json`
   (shape in `slack/oauth-client.example.json`).
5. Auth per workspace:

   ```bash
   python3 slack/slack.py auth --workspace work
   ```

### Configure accounts

Either let the wizard write it, or hand-edit `triage/triage-config.json`:

```json
{
  "schema_version": 1,
  "python_cmd": null,
  "gmail":  { "accounts":   ["work", "personal"] },
  "slack":  { "workspaces": ["work"] }
}
```

`python_cmd` is optional. Leave `null` to auto-detect (`python3` on
Mac/Linux, `python` on Windows). Set to a full path if you hit Windows'
Microsoft Store Python stub.

### Try it

In Claude Code (this repo open):

```
/triage
```

You should see a numbered list, then a question per item: **Done**, **Todo**,
**Send suggested reply**, or **Other** (type your own — a reply, `suggest`,
`skip`, `mute`). You can also answer in one freeform line: `1 done, 2 todo,
3 reply: sounds good`.

## What's in the box

```
README.md
setup.js                     Cross-platform wizard (Node, no deps)
.gitignore                   Excludes secrets, tokens, auth, logs

triage/
  gmail.py                   Multi-account Gmail OAuth helper
  fetch-all.js               Parallel fan-out across Gmail + WA + Slack
  gmail.cmd / fetch-all.cmd  Windows shims
  gmail.sh  / fetch-all.sh   Mac/Linux shims
  requirements.txt
  oauth-client.example.json  Shape of credentials.json (drop yours next to gmail.py)
  triage-config.example.json Shape of triage-config.json (wizard writes the real one)
  skip-rules.example.md      Declared "this TYPE never matters" policy (copied to skip-rules.md on first run)
  agent-notes.example.md     Behavioural log the skill maintains (copied to agent-notes.md on first run)

wa-daemon/
  daemon.js                  Persistent Baileys socket, HTTP send on :4119
  triage.js                  Read view: unread DMs + groups since cutoff
  send.js                    Thin client → POST :4119/send
  login.js                   QR or pairing-code pairing
  show-thread.js             Pull a full burst (for groups where count > 1)
  search.js                  Free-text search over message-store.jsonl
  sync-contacts.js           Pulls names from your phone via Baileys
  wa-mute.js, lid-tag.js, check-flap.js
  start.ps1 / stop.ps1       Windows
  start.sh  / stop.sh        Mac/Linux
  keep-awake.ps1             Windows-only idle-sleep prevention
  package.json
  wa-groups-block.json       Skip list (wizard writes; safe to hand-edit)

slack/
  slack.py
  slack.cmd / slack.sh
  oauth-client.example.json

skills/
  triage/SKILL.md            The /triage skill itself
```

Files intentionally NOT included: WA `auth/` session, OAuth tokens,
`node_modules/`, message stores, contacts, logs. Anything sensitive is in
`.gitignore`.

## Design decisions worth knowing

1. **Baileys, not whatsapp-web.js.** Pure Node, no browser, smaller surface
   area, faster cold start. Works natively on Windows / Mac / Linux despite
   some online docs claiming WSL is required.
2. **One daemon, not per-call.** WhatsApp sessions don't multiplex —
   short-lived processes triggered session-conflict storms. The daemon owns
   the socket; reads (`triage.js`) and sends (HTTP `:4119`) are clients.
3. **Custom Gmail OAuth, not Anthropic's Gmail MCP.** The MCP marks reads
   on fetch (RFC822), labels are read-only, and multi-account is painful.
   Custom app: `BODY.PEEK[]`, full label CRUD, per-account tokens.
4. **`state.json` cutoff is the single source of truth.** All three sources
   post-filter on the same `last_check_at` Unix timestamp. Re-surfaces are
   impossible across rounds.
5. **Send-safety is a hard rule, not a checkbox.** Every send command
   defaults to dry-run. `--confirmed` is required to actually transmit. The
   skill echoes resolved recipient + first 80 chars of body before asking
   for the second confirmation.
6. **Noise filtering is three layers, by intent not accident.**
   *Entity-level* skips (a whole group/channel) live in `wa-groups-block.json`
   / `slack/mute.json` — cheap, deterministic. *Type-level* skips ("calendar
   acks never matter") live in `skip-rules.md` — your declared, editable
   policy. *Behavioural* patterns the agent infers from how you actually act
   live in `agent-notes.md` — tentative, and promoted into `skip-rules.md`
   only once stable and confirmed. Hypotheses (agent-notes) flow into committed
   policy (skip-rules); they never silently become rules.

## Privacy / security

- All OAuth tokens stay on your machine. No third-party server sees them.
- The WA daemon binds `127.0.0.1` only — nothing reachable from the network.
- This repo's `.gitignore` blocks committing tokens, auth state, or message
  history. If you fork: do a `git status` before pushing.
