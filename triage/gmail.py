"""Gmail helper for triage skill.

Handles OAuth + read + label + draft + send for any number of accounts.

Tokens stored at ./tokens/<account>.json. credentials.json (OAuth app)
must already exist in the same directory as this script.

Usage:
    python gmail.py auth --account work
    python gmail.py whoami --account work
    python gmail.py search --account work --query "is:unread newer_than:1d"
    python gmail.py get --account work --thread-id 19df...
    python gmail.py send --account work --to foo@bar.com --subject Hi --body "hello"
    python gmail.py send --account work --to foo@bar.com --subject Hi --body "hello" --confirmed
    python gmail.py label --account work --thread-id 19df... --add Label_1
    python gmail.py list-labels --account work
    python gmail.py create-label --account work --name triage/action

Send safety: defaults to dry-run; nothing actually sends without --confirmed.
"""

import argparse
import base64
import html
import json
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parseaddr
from pathlib import Path

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

ROOT = Path(__file__).resolve().parent
CREDS_FILE = ROOT / "credentials.json"
TOKENS_DIR = ROOT / "tokens"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.labels",
]


def get_service(account: str):
    if not CREDS_FILE.exists():
        raise SystemExit(f"Missing {CREDS_FILE}. Download it from Google Cloud Console and place it here.")
    TOKENS_DIR.mkdir(exist_ok=True)
    token_file = TOKENS_DIR / f"{account}.json"
    creds = None
    if token_file.exists():
        creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)
    if not creds or not creds.valid:
        refreshed = False
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                refreshed = True
            except RefreshError:
                # Token was revoked or otherwise unrefreshable. Fall through
                # to a fresh OAuth flow instead of crashing.
                creds = None
        if not refreshed:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        token_file.write_text(creds.to_json())
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def cmd_auth(args):
    svc = get_service(args.account)
    profile = svc.users().getProfile(userId="me").execute()
    print(f"Authenticated as: {profile['emailAddress']}")
    print(f"Token saved: {TOKENS_DIR / (args.account + '.json')}")


def cmd_whoami(args):
    svc = get_service(args.account)
    profile = svc.users().getProfile(userId="me").execute()
    print(profile["emailAddress"])


def cmd_search(args):
    svc = get_service(args.account)
    res = svc.users().threads().list(
        userId="me", q=args.query, maxResults=args.max_results
    ).execute()
    print(json.dumps(res, indent=2))


def cmd_get(args):
    svc = get_service(args.account)
    res = svc.users().threads().get(
        userId="me", id=args.thread_id, format="full"
    ).execute()
    print(json.dumps(res, indent=2))


def _read_body(args):
    """Return body text from --body or --body-file (must pass exactly one)."""
    if args.body_file and args.body:
        raise SystemExit("Pass either --body or --body-file, not both.")
    if args.body_file:
        return Path(args.body_file).read_text(encoding="utf-8")
    if args.body:
        return args.body
    raise SystemExit("Must pass --body <text> or --body-file <path>.")


def cmd_send(args):
    svc = get_service(args.account)
    profile = svc.users().getProfile(userId="me").execute()
    sender_addr = profile["emailAddress"]
    body_text = _read_body(args)

    in_reply_to = None
    references = None
    if args.thread_id:
        thread = svc.users().threads().get(
            userId="me", id=args.thread_id, format="metadata",
            metadataHeaders=["Message-Id", "References"],
        ).execute()
        msgs = thread.get("messages", [])
        target = None
        for m in reversed(msgs):
            labels = m.get("labelIds", [])
            if "SENT" not in labels and "DRAFT" not in labels:
                target = m
                break
        if target is None and msgs:
            target = msgs[0]
        if target:
            for h in target.get("payload", {}).get("headers", []):
                name = h["name"].lower()
                if name == "message-id":
                    in_reply_to = h["value"]
                elif name == "references":
                    references = h["value"]
            if in_reply_to:
                references = (references + " " + in_reply_to).strip() if references else in_reply_to

    print("--- DRY RUN ---")
    print(f"From:    {sender_addr}")
    print(f"To:      {args.to}")
    print(f"Subject: {args.subject}")
    if in_reply_to:
        print(f"In-Reply-To: {in_reply_to}")
    print("Body:")
    print(body_text)
    print("---------------")

    if not args.confirmed:
        print("NOT SENT. Re-run with --confirmed to actually send.")
        return

    msg = MIMEMultipart("alternative")
    msg["to"] = args.to
    msg["subject"] = args.subject
    msg["from"] = sender_addr
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references
    msg.attach(MIMEText(body_text, "plain", "utf-8"))
    msg.attach(MIMEText(_plaintext_to_html(body_text), "html", "utf-8"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

    body = {"raw": raw}
    if args.thread_id:
        body["threadId"] = args.thread_id

    sent = svc.users().messages().send(userId="me", body=body).execute()
    print(f"SENT. Message ID: {sent['id']}")


def _decode_body(part):
    """Walk a Gmail payload part tree, return (text, html) bodies if found."""
    text = None
    html_body = None
    mime = part.get("mimeType", "")
    data = part.get("body", {}).get("data")
    if data:
        padded = data + "=" * (-len(data) % 4)
        try:
            decoded = base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")
            if mime == "text/plain":
                text = decoded
            elif mime == "text/html":
                html_body = decoded
        except Exception:
            pass
    for sub in part.get("parts") or []:
        t, h = _decode_body(sub)
        text = text or t
        html_body = html_body or h
    return text, html_body


def _plaintext_to_html(text):
    """Convert email-sig plaintext conventions to HTML.

    *bold* -> <b>bold</b>
    <http(s)://url> -> clickable <a href> (angle brackets removed)
    Newlines -> <br>. Everything else html-escaped.
    """
    placeholders = {}

    def stash(snippet):
        key = f"\x00PH{len(placeholders)}\x00"
        placeholders[key] = snippet
        return key

    def url_repl(m):
        url = m.group(1)
        return stash(f'<a href="{html.escape(url, quote=True)}">{html.escape(url)}</a>')

    text = re.sub(r"<(https?://[^>\s]+)>", url_repl, text)

    def bold_repl(m):
        inner = m.group(1)
        return stash(f"<b>{html.escape(inner)}</b>")

    text = re.sub(r"\*([^*\n]+)\*", bold_repl, text)

    out = html.escape(text)
    for key, val in placeholders.items():
        out = out.replace(key, val)
    return out.replace("\n", "<br>")


def cmd_draft(args):
    svc = get_service(args.account)
    profile = svc.users().getProfile(userId="me").execute()
    sender_addr = profile["emailAddress"]
    body_text = _read_body(args)

    in_reply_to = None
    references = None
    quote_text_block = ""
    quote_html_block = ""

    if args.thread_id:
        thread = svc.users().threads().get(
            userId="me", id=args.thread_id, format="full"
        ).execute()
        msgs = thread.get("messages", [])
        target = None
        for m in reversed(msgs):
            labels = m.get("labelIds", [])
            if "SENT" not in labels and "DRAFT" not in labels:
                target = m
                break
        if target is None and msgs:
            target = msgs[0]

        if target:
            from_full = ""
            date_str = ""
            target_refs = ""
            for h in target.get("payload", {}).get("headers", []):
                name = h["name"].lower()
                if name == "message-id":
                    in_reply_to = h["value"]
                elif name == "references":
                    target_refs = h["value"]
                elif name == "from":
                    from_full = h["value"]
                elif name == "date":
                    date_str = h["value"]
            if in_reply_to:
                references = (target_refs + " " + in_reply_to).strip() if target_refs else in_reply_to

            from_name, from_addr = parseaddr(from_full)
            from_label = from_full or from_addr

            text_body, html_body = _decode_body(target.get("payload", {}))

            if text_body:
                quote_lines = "\n".join("> " + line for line in text_body.rstrip().split("\n"))
                quote_text_block = f"\n\nOn {date_str}, {from_label} wrote:\n{quote_lines}"
            if html_body:
                inner_html = html_body
            elif text_body:
                inner_html = "<div>" + html.escape(text_body).replace("\n", "<br>") + "</div>"
            else:
                inner_html = ""
            if inner_html:
                quote_html_block = (
                    f'<div class="gmail_extra"><div>On {html.escape(date_str)}, '
                    f'{html.escape(from_label)} wrote:<br>'
                    f'<blockquote class="gmail_quote" '
                    f'style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;">'
                    f'{inner_html}</blockquote></div></div>'
                )

    plain_body = body_text + quote_text_block
    html_top = _plaintext_to_html(body_text)
    html_full = html_top + (("<br>" + quote_html_block) if quote_html_block else "")

    msg = MIMEMultipart("alternative")
    msg["to"] = args.to
    msg["subject"] = args.subject
    msg["from"] = sender_addr
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references

    msg.attach(MIMEText(plain_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_full, "html", "utf-8"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    draft_body = {"message": {"raw": raw}}
    if args.thread_id:
        draft_body["message"]["threadId"] = args.thread_id

    draft = svc.users().drafts().create(userId="me", body=draft_body).execute()
    msg_meta = draft.get("message", {})
    print("DRAFT CREATED")
    print(f"  draft_id:   {draft.get('id')}")
    print(f"  message_id: {msg_meta.get('id')}")
    print(f"  threadId:   {msg_meta.get('threadId')}")
    if in_reply_to:
        print(f"  In-Reply-To: {in_reply_to}")
    print(f"To send: gmail.cmd send-draft --account {args.account} --draft-id {draft.get('id')} --confirmed")


def cmd_send_draft(args):
    svc = get_service(args.account)
    drafts = svc.users().drafts().list(userId="me", maxResults=20).execute().get("drafts", [])
    match = None
    for d in drafts:
        if d.get("id") == args.draft_id or d.get("message", {}).get("id") == args.draft_id:
            match = d
            break

    print("--- DRY RUN ---")
    if match:
        print(f"Found draft {match['id']} (message {match.get('message', {}).get('id')})")
    else:
        print(f"WARNING: draft {args.draft_id} not in last 20 drafts of this account. send call will still attempt with the given id.")
    print(f"Account: {args.account}")
    print("---------------")

    if not args.confirmed:
        print("NOT SENT. Re-run with --confirmed to actually send.")
        return

    sent = svc.users().drafts().send(userId="me", body={"id": args.draft_id}).execute()
    print(f"SENT. Message ID: {sent.get('id')}")


def cmd_list_drafts(args):
    svc = get_service(args.account)
    res = svc.users().drafts().list(userId="me", maxResults=20).execute()
    for d in res.get("drafts", []):
        print(f"draft_id={d['id']:25s}  message_id={d.get('message', {}).get('id', '')}  threadId={d.get('message', {}).get('threadId', '')}")


def cmd_label(args):
    svc = get_service(args.account)
    body = {}
    if args.add:
        body["addLabelIds"] = args.add.split(",")
    if args.remove:
        body["removeLabelIds"] = args.remove.split(",")
    if not body:
        raise SystemExit("Pass --add and/or --remove with comma-separated label IDs.")
    svc.users().threads().modify(
        userId="me", id=args.thread_id, body=body
    ).execute()
    print(f"Updated thread {args.thread_id}")


def cmd_list_labels(args):
    svc = get_service(args.account)
    res = svc.users().labels().list(userId="me").execute()
    for lbl in res.get("labels", []):
        print(f"{lbl['id']:30s}  {lbl['name']}")


def cmd_create_label(args):
    svc = get_service(args.account)
    body = {
        "name": args.name,
        "labelListVisibility": "labelShow",
        "messageListVisibility": "show",
    }
    res = svc.users().labels().create(userId="me", body=body).execute()
    print(f"Created label '{res['name']}' with id {res['id']}")


def main():
    p = argparse.ArgumentParser(description="Gmail helper for triage skill.")
    sub = p.add_subparsers(dest="cmd", required=True)

    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--account", required=True, help="Account name, e.g. work, personal. Used as token filename.")

    sub.add_parser("auth", parents=[parent])
    sub.add_parser("whoami", parents=[parent])
    sub.add_parser("list-labels", parents=[parent])
    sub.add_parser("list-drafts", parents=[parent])

    sp = sub.add_parser("send-draft", parents=[parent])
    sp.add_argument("--draft-id", required=True)
    sp.add_argument("--confirmed", action="store_true")

    sp = sub.add_parser("draft", parents=[parent])
    sp.add_argument("--to", required=True)
    sp.add_argument("--subject", required=True)
    sp.add_argument("--body", help="Inline body. SAFE for single-line. For multi-line bodies, prefer --body-file (the .cmd shim mangles multi-line args via cmd.exe's %* expansion).")
    sp.add_argument("--body-file", help="Path to a UTF-8 file containing the body. Use this for any multi-line content.")
    sp.add_argument("--thread-id", help="If provided, creates a threaded reply with auto-quoted original message")

    sp = sub.add_parser("search", parents=[parent])
    sp.add_argument("--query", required=True)
    sp.add_argument("--max-results", type=int, default=30)

    sp = sub.add_parser("get", parents=[parent])
    sp.add_argument("--thread-id", required=True)

    sp = sub.add_parser("send", parents=[parent])
    sp.add_argument("--to", required=True)
    sp.add_argument("--subject", required=True)
    sp.add_argument("--body", help="Inline body. SAFE for single-line. For multi-line bodies, prefer --body-file (the .cmd shim mangles multi-line args via cmd.exe's %* expansion).")
    sp.add_argument("--body-file", help="Path to a UTF-8 file containing the body. Use this for any multi-line content.")
    sp.add_argument("--thread-id", help="Optional: send as reply within this thread")
    sp.add_argument("--confirmed", action="store_true", help="Without this flag, only prints what would be sent")

    sp = sub.add_parser("label", parents=[parent])
    sp.add_argument("--thread-id", required=True)
    sp.add_argument("--add", help="Comma-separated label IDs to add")
    sp.add_argument("--remove", help="Comma-separated label IDs to remove")

    sp = sub.add_parser("create-label", parents=[parent])
    sp.add_argument("--name", required=True)

    args = p.parse_args()

    cmds = {
        "auth": cmd_auth,
        "whoami": cmd_whoami,
        "search": cmd_search,
        "get": cmd_get,
        "send": cmd_send,
        "label": cmd_label,
        "list-labels": cmd_list_labels,
        "create-label": cmd_create_label,
        "list-drafts": cmd_list_drafts,
        "send-draft": cmd_send_draft,
        "draft": cmd_draft,
    }
    cmds[args.cmd](args)


if __name__ == "__main__":
    main()
