---
name: triage
description: >
  Unified inbox triage across Gmail (multi-account), WhatsApp (DMs + groups via
  the local wa-daemon), and Slack (multi-workspace). Reads accounts/workspaces
  from triage-config.json. Fetches items needing action, prints a compact
  numbered list, asks one AskUserQuestion per item, advances a shared cutoff.
  Use when the user says "triage", "morning", "what's actionable", "inbox",
  or invokes /triage.
---

# Triage — multi-source actionable inbox

## Architecture

**Helpers** (all in this repo, all read paths from `triage-config.json`):

- **Gmail** — `triage/gmail.py` (custom OAuth, multi-account). Labels are the
  source of truth: `triage/action` (fresh), `triage/todo` (carryover),
  `triage/done` (handled), no label = auto-deprioritized.
- **WhatsApp** — `wa-daemon/` runs a persistent Baileys socket.
  `wa-daemon/triage.js --hours N --json` reads unread DMs + groups from the
  local message store. `wa-daemon/send.js` POSTs to the daemon's local HTTP
  send endpoint (`127.0.0.1:4119`).
- **Slack** — `slack/slack.py` (custom OAuth, user tokens, per workspace).
  Three sections per workspace: `dm_recent`, `mentions`, `channel_recent`.

**One-shot fan-out:** `triage/fetch-all.js` dispatches all three sources in
parallel, applies a 24h post-filter, and emits one JSON bundle. Always use
this — do NOT call helpers individually.

```
node <repo>/triage/fetch-all.js
```

## State model

- **Gmail:** labels themselves (`triage/action|todo|done`).
- **WhatsApp:** `wa-daemon/wa-state.json` — `{ todo: {...}, done: {...} }`.
  No native WA label system, so we keep state here.
- **Slack:** piggybacks on the shared cutoff (no per-message state file).
- **Shared cutoff:** `triage/state.json` holds `last_check_at` /
  `last_check_unix`. Updated at the end of every /triage round AND any informal
  "what's new" check. Every check reads it AND advances it.

## Hard rules

1. **Always end with AskUserQuestion.** After printing the actionable list,
   immediately call AskUserQuestion with one question per item (max 4 per
   call; batch + re-prompt if N > 4). Never return control without it.
   Exception: when N = 0 ("Inbox clear ✓"), just return.
2. **Send is dry-run by default.** Show the dry-run preview, wait for
   explicit "go"/"send", THEN re-run with `--confirmed`.
3. **Total output before user input: ≤ 50 words plus the list itself.**
4. **Skip non-actionable items silently.** Never print them, never label them.
5. **Hard 24h window — per-item post-filter, not just fetch scope.**
   Effective cutoff = `max(last_check_at, now − 24h)`. fetch-all.js applies
   this for you, but if you call a helper directly, you MUST re-check the
   latest INCOMING timestamp (not internalDate, not thread bump time) and
   drop anything older. Gmail's `after:` operator returns threads bumped by
   label changes — it WILL leak older items without the post-filter.
   Sole exception: explicit carryover (Gmail `triage/todo`, WA `wa-state.json#todo`).
6. **One-shot preservation.** The user's immediate next message after the
   list is the only chance to flag items. Silence or any unrelated message
   implicit-dones every shown item. No retroactive "todo".
7. **At round end, ALWAYS rewrite `triage/state.json#last_check_at`** to the
   current run's timestamp.

## Recipe

### 0. Behavioural notes (prioritisation prior)

Before fetching, read `triage/agent-notes.md` (copy it from `agent-notes.example.md` on first run if missing). It's a running log of how the user actually handles things over time. Use it silently to inform classify + display (steps 3–5):
- Senders/groups consistently skipped → deprioritise; suggest `mute` for recurring-noise groups.
- People whose suggested replies always get rewritten → pre-compose more carefully.
- Items deferred repeatedly → surface near the top.
- Time-of-day / day-of-week patterns → tune trimming.

Never echo these notes to the user — silent prior, not output.

### 1. Fetch

```
node <repo>/triage/fetch-all.js
```

Flags:
- `--no-enrich` — skip per-item context fetches (fast first look)
- `--scope gmail|wa|slack` — narrow to one source
- `--hours N` — override the window

### 2. Health check

Look at `wa.daemon_pid_alive` + `wa.daemon_heartbeat_age_sec` (NOT
`generated_at`, which lies — see check-flap.js). Also check `wa.flap`:
warn the user inline if `disc5m ≥ 3` OR `replaced60m ≥ 1`.

### 3. Classify

For each fetched item, decide:

- **Actionable** — needs a response, task, or decision today/this-week:
  surface it.
- **Skippable** — newsletters, automated notifications, marketing,
  community banter, reactions, FYI cc's: drop silently.
- **Carryover** — already flagged `triage/todo` or in
  `wa-state.json#todo`: surface at top.

**First read `triage/skip-rules.md`** (copy from `skip-rules.example.md` on
first run) — the user's declared type-skip policy, the single source of truth
for "this TYPE never matters". Apply every rule there as authoritative. The
baseline categories below seed it:
- Gmail: marketing, newsletters, calendar invites you already accepted,
  shipping notifications, social network noise.
- WA: groups in `wa-daemon/wa-groups-block.json` (set by setup wizard),
  reactions (`[reaction: ...]`), pure read-receipt traffic.
- Slack: channels listed in `slack/mute.json`, @here/@channel pings from
  bots, reaction-only "messages".

For WA groups with `count > 1`, ALWAYS check the burst (`item.burst`)
before classifying — the daemon's collapsed `text` field only shows the
latest line, so an earlier actionable message can hide behind a trailing
reaction.

### 4. Display

Compact, scannable. One block per item. Format:

```
{N}. [{source-code}] {sender} — {subject-or-snippet}
   {1-line preview of latest incoming, ≤ 80 chars}
```

Source codes: `gm` (Gmail), `wa` (WhatsApp DM), `wg` (WhatsApp group),
`sl` (Slack DM), `s@` (Slack mention), `sc` (Slack channel).

For account/workspace disambiguation, append `(account-name)`:
`{N}. [gm:work] alice@... — Re: ...`

Never invent senders. Always show the real "From" / WA push name / Slack
display name. Quote snippet text verbatim — no paraphrasing.

### 5. AskUserQuestion

One question per item. Options per item, in this FIXED order:

1. **Done** — mark read/handled this round.
2. **Todo** — capture to your task inbox AND mark the source done so triage
   stops re-surfacing it. (Gmail label `triage/todo`, WA `wa-state.json#todo`.)
3. **Send my suggested reply** — PRE-COMPOSE a 1-2 sentence reply per item and
   put it in the option's `description` field so the user sees it on focus.
   For FYI / info-only items, this option becomes "Acknowledge with: ...".
4. **(auto "Other")** — the user types freeform: their own reply text,
   `suggest` to ask for a draft, `skip`, or `mute` (groups only). This is the
   automatic free-text option AskUserQuestion always appends — do not add a
   literal 4th option.

`mute` is a freeform verb typed under Other, NOT a dedicated chip. Same for
`suggest` / `skip`.

Max 4 options per question (the 3 above + auto-Other), max 4 questions per
AskUserQuestion call. If N > 4 items, batch the first 4 and re-prompt.

### 6. Reply flow

When the user picks "Send my suggested reply" (use your pre-composed text) OR
types their own reply body under Other:
1. Draft the reply. Echo recipient + first 80 chars of body to the user.
2. WAIT for explicit "go" / "send" / "yes".
3. THEN re-run the helper with `--confirmed`.

For Gmail: use `gmail.py send --confirmed --thread-id <id>` so the reply
joins the original thread.
For WA: use `send.js --jid <chatJid> --confirmed --text "..."`. Pass the
JID directly, never the human name (name resolution re-introduces
ambiguity the JID already solves).
For Slack: use `slack.py send --workspace <name> --to <channel-or-DM> --confirmed`.

### 7. Round end

1. For each shown-but-not-preserved item: mark done (Gmail label
   `triage/done`; WA `wa-state.json#done[jid] = now`).
2. Write `triage/state.json` with `last_check_at` = ISO now, `last_check_unix` = now.
3. Brief 1-line summary: `Triaged: N items. M done, K todo, R replied.`

### 8. Record behavioural observations

Append any NEW pattern worth remembering to `triage/agent-notes.md` under `## Patterns observed`, dated. Record only SIGNAL that should change future prioritisation:
- A sender/group skipped across multiple rounds (candidate for mute).
- A contact whose suggested replies always get rewritten (recalibrate tone).
- An item deferred repeatedly (recurring obligation).
- Notably careful or slow handling of a person/thread.

One line per observation; skip if nothing notable. When `## Patterns observed` grows past ~30 lines, compact it — collapse repeating notes into one summary line. This is the agent's long-term memory of the user's habits, so keep it manageable.

**Promotion to a permanent rule.** When `agent-notes.md` shows a STABLE skip pattern (same message TYPE skipped across ≥3 rounds), propose promoting it: ask once, "Make 'skip <type>' a permanent rule?" On yes, append a one-line rule to `triage/skip-rules.md` under `## Always skip (message types)` and drop the observation from agent-notes. agent-notes = hypotheses; skip-rules.md = committed policy. Never auto-promote without the user's ok.

## Anti-patterns

- **Don't** call gmail.py / slack.py / wa-daemon helpers individually for
  the fetch step. fetch-all.js batches them in parallel and applies the
  24h post-filter for you.
- **Don't** show items that fail the 24h post-filter, even if a fetch
  returned them.
- **Don't** print non-actionable items to "explain why you skipped them".
  Just skip silently.
- **Don't** offer per-item AskUserQuestion if the list is empty — return
  "Inbox clear ✓" and stop.
- **Don't** use bare "name" resolution for WA sends from inside /triage —
  the bundle gives you `chatJid`; use it.

## When to use related skills

- **`/snm`** (lightweight glance, doesn't advance the cutoff) — for "is
  there anything urgent right now" without the full classify-and-act
  workflow. Reads the same cutoff but doesn't write it.
