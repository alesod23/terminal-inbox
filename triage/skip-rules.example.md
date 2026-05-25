---
type: skip-rules
maintained_by: user + agent
---

# Triage skip rules — declared type-level policy

Your explicit "this TYPE of message never matters" rules. `/triage` reads this
at classify time (step 3) and applies every rule here as authoritative, on top
of its baseline judgment. On first run, /triage copies this template to
`skip-rules.md` (gitignored — it's your personal policy).

This is the home for type-level skips — distinct from the other two layers:
- `wa-groups-block.json` / `slack/mute.json` → ENTITY-level (a specific group/channel)
- `agent-notes.md` → tentative OBSERVED patterns (promoted here once stable)

Add a line whenever you tell triage "X type is never important." One line per
rule, concrete enough to match on. The agent also appends here via the
promotion flow (SKILL step 8); you can hand-edit anytime.

## Always skip (message types)
- Calendar acks — meeting accept / decline / tentative confirmations ("X accepted your invitation"). The decision already happened; the notice is a receipt.
- Appointment / booking confirmations — Calendly / Cal.com / Google Calendar / Microsoft Bookings auto-confirmations. The booking IS the action.
- Newsletters, marketing, promotions, automated digests.
- Receipt / shipping / delivery / order notifications.
- Automated-sender mail — `noreply@` / `no-reply@` / `notifications@` / `invitations@`. Exception: a deadline on a service you actively run.
- Self-sent threads — your own mail landing in inbox via BCC/forward.
- Reactions / single-word closures — "ok", "thanks", "noted", emojis. (Burst-tail exception: check earlier messages first.)
- Moot / past-tense asks — a question whose time has already passed.

## Always surface (overrides a skip)
- (priority projects / people — add lines here, e.g. "anything from <project> or <person>")

## Notes
- Burst-tail exception: before skipping on a closure, check earlier messages in the burst (`show-thread.js`) for an unacted actionable msg.
- Entity-level skips do NOT go here — use `wa-mute.js add <jid>` (groups) or edit `slack/mute.json` (channels).
