"""Slack helper for one or more workspaces.

Mirrors the design of gmail.py: one custom OAuth app shared across
workspaces, per-workspace user tokens, dry-run sends.

Usage:
    python slack.py auth        --workspace work
    python slack.py whoami      --workspace work
    python slack.py list-channels --workspace work
    python slack.py list-users  --workspace work
    python slack.py unread      --workspace work --hours 24
    python slack.py search      --workspace work --query "from:@me has:link"
    python slack.py read        --workspace work --channel C0123456 --limit 20
    python slack.py send        --workspace work --to "@alice" --text "hi"
    python slack.py send        --workspace work --to "@alice" --text "hi" --confirmed

Send safety: defaults to dry-run; nothing actually sends without --confirmed.
"""

import argparse
import http.server
import json
import secrets
import socketserver
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
CREDS_FILE = ROOT / "credentials.json"
TOKENS_DIR = ROOT / "tokens"

# User Token Scopes — granted to the user, not a bot. Acts as the user.
USER_SCOPES = [
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "mpim:write",
    "chat:write",
    "users:read",
    "users:read.email",
    "search:read",
]

OAUTH_PORT = 53682  # must match a redirect URL configured in the Slack app
REDIRECT_URI = f"http://localhost:{OAUTH_PORT}/callback"
API_BASE = "https://slack.com/api"


# ----------------------------- OAuth -----------------------------


def _load_app_creds() -> dict:
    if not CREDS_FILE.exists():
        sys.exit(
            f"Missing {CREDS_FILE}. Create it as:\n"
            '  {"client_id": "...", "client_secret": "..."}\n'
            "Get those from api.slack.com/apps -> your app -> Basic Information."
        )
    return json.loads(CREDS_FILE.read_text(encoding="utf-8"))


def _capture_oauth_code() -> str:
    """Spin up a one-shot localhost server to receive the OAuth callback."""
    code_holder: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args, **_kwargs):
            pass

        def do_GET(self):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            if "code" in params:
                code_holder["code"] = params["code"][0]
                code_holder["state"] = params.get("state", [None])[0]
                body = b"<html><body><h2>Slack auth complete.</h2>You can close this tab.</body></html>"
            else:
                code_holder["error"] = params.get("error", ["unknown"])[0]
                body = b"<html><body><h2>Slack auth failed.</h2></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    httpd = socketserver.TCPServer(("localhost", OAUTH_PORT), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    deadline = time.time() + 300  # 5 min to authorize
    while "code" not in code_holder and "error" not in code_holder:
        if time.time() > deadline:
            httpd.shutdown()
            sys.exit("OAuth timed out (5 min). Re-run `auth`.")
        time.sleep(0.2)
    httpd.shutdown()
    if "error" in code_holder:
        sys.exit(f"OAuth error: {code_holder['error']}")
    return code_holder["code"]


def cmd_auth(args):
    creds = _load_app_creds()
    state = secrets.token_urlsafe(16)
    auth_url = (
        "https://slack.com/oauth/v2/authorize?"
        + urllib.parse.urlencode(
            {
                "client_id": creds["client_id"],
                "user_scope": ",".join(USER_SCOPES),
                "redirect_uri": REDIRECT_URI,
                "state": state,
            }
        )
    )
    print(f"Opening browser to authorize workspace '{args.workspace}'...")
    print(f"If it doesn't open, paste this URL manually:\n  {auth_url}\n")
    webbrowser.open(auth_url)

    code = _capture_oauth_code()

    resp = requests.post(
        f"{API_BASE}/oauth.v2.access",
        data={
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        timeout=30,
    ).json()
    if not resp.get("ok"):
        sys.exit(f"oauth.v2.access failed: {json.dumps(resp, indent=2)}")

    user_token = resp.get("authed_user", {}).get("access_token")
    user_id = resp.get("authed_user", {}).get("id")
    team_name = resp.get("team", {}).get("name")
    team_id = resp.get("team", {}).get("id")
    if not user_token:
        sys.exit(f"No user token returned. Full response:\n{json.dumps(resp, indent=2)}")

    TOKENS_DIR.mkdir(exist_ok=True)
    token_file = TOKENS_DIR / f"{args.workspace}.json"
    token_file.write_text(
        json.dumps(
            {
                "user_token": user_token,
                "user_id": user_id,
                "team_id": team_id,
                "team_name": team_name,
                "scopes": resp.get("authed_user", {}).get("scope", ""),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Authenticated to '{team_name}' (team {team_id}) as user {user_id}.")
    print(f"Token saved: {token_file}")


def cmd_auth_cookie(args):
    """Save a browser-extracted xoxc token + d cookie. Workaround for workspaces that
    block app installs. Validates by calling auth.test before persisting."""
    if not args.token.startswith("xoxc-"):
        sys.exit(
            f"Token doesn't look like a browser token (expected `xoxc-...`, got "
            f"`{args.token[:8]}...`). The OAuth path uses `xoxp-`; for that, run `auth`."
        )
    test_tok = {"user_token": args.token, "cookie_d": args.cookie}
    data = _api("auth.test", test_tok)

    TOKENS_DIR.mkdir(exist_ok=True)
    token_file = TOKENS_DIR / f"{args.workspace}.json"
    token_file.write_text(
        json.dumps(
            {
                "user_token": args.token,
                "cookie_d": args.cookie,
                "auth_method": "browser_cookie",
                "user_id": data.get("user_id"),
                "team_id": data.get("team_id"),
                "team_name": data.get("team"),
                "url": data.get("url"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Authenticated to '{data.get('team')}' as {data.get('user')} ({data.get('user_id')}).")
    print(f"Token saved: {token_file}")
    print(
        "\nNote: browser tokens + the `d` cookie can rotate (logout, password change, "
        "long inactivity). If a call later fails with `not_authed`/`invalid_auth`, "
        "re-extract from DevTools and re-run `auth-cookie`."
    )


# ----------------------------- API helpers -----------------------------


def _load_token(workspace: str) -> dict:
    f = TOKENS_DIR / f"{workspace}.json"
    if not f.exists():
        sys.exit(
            f"No token for workspace '{workspace}'. Run either:\n"
            f"  python {Path(__file__).name} auth --workspace {workspace}\n"
            f"or, if your workspace blocks app installs:\n"
            f"  python {Path(__file__).name} auth-cookie --workspace {workspace} "
            f"--token xoxc-... --cookie <d-cookie>"
        )
    return json.loads(f.read_text(encoding="utf-8"))


def _api(method: str, tok: dict, params: dict = None, post: bool = False) -> dict:
    """Call a Slack Web API method.

    `tok` is the loaded token dict (from _load_token), so this auto-handles
    both auth modes:
      - OAuth (xoxp-) -> just Authorization header
      - Browser cookie (xoxc-) -> Authorization header + `d` cookie
    """
    url = f"{API_BASE}/{method}"
    headers = {"Authorization": f"Bearer {tok['user_token']}"}
    cookies = {"d": tok["cookie_d"]} if tok.get("cookie_d") else None

    # Retry on read-timeout / connection-error. users.list pagination on a
    # large workspace (~1k members) sometimes takes >30s; 60s per-call timeout
    # plus 3 attempts with exponential backoff prevents one slow page from
    # killing the whole triage run.
    last_exc = None
    for attempt in range(3):
        try:
            if post:
                # xoxc tokens reject application/json; form-encoded works for both.
                r = requests.post(url, headers=headers, data=params or {}, cookies=cookies, timeout=60)
            else:
                r = requests.get(url, headers=headers, params=params or {}, cookies=cookies, timeout=60)
            data = r.json()
            if not data.get("ok"):
                sys.exit(f"Slack API {method} failed: {json.dumps(data, indent=2)}")
            return data
        except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(2 ** attempt)  # 1s, 2s
                continue
    sys.exit(f"Slack API {method} failed after 3 attempts: {last_exc}")


def _paginate(method: str, tok: dict, params: dict, list_key: str, page_limit: int = 200) -> list:
    """Walk Slack cursor pagination, return all items from `list_key`."""
    items = []
    cursor = None
    while True:
        p = dict(params or {})
        p["limit"] = page_limit
        if cursor:
            p["cursor"] = cursor
        data = _api(method, tok, p)
        items.extend(data.get(list_key, []))
        cursor = data.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            break
    return items


# ----------------------------- Commands -----------------------------


def cmd_whoami(args):
    tok = _load_token(args.workspace)
    data = _api("auth.test", tok)
    print(json.dumps(data, indent=2))


def cmd_list_channels(args):
    tok = _load_token(args.workspace)
    chans = _paginate(
        "conversations.list",
        tok,
        {"types": "public_channel,private_channel,mpim,im", "exclude_archived": "true"},
        "channels",
    )
    out = []
    for c in chans:
        out.append(
            {
                "id": c.get("id"),
                "name": c.get("name") or c.get("user") or "(dm)",
                "is_im": c.get("is_im", False),
                "is_private": c.get("is_private", False),
                "is_mpim": c.get("is_mpim", False),
                "is_member": c.get("is_member", False),
            }
        )
    print(json.dumps(out, indent=2))


def cmd_list_users(args):
    tok = _load_token(args.workspace)
    users = _paginate("users.list", tok, {}, "members")
    out = []
    for u in users:
        if u.get("deleted") or u.get("is_bot"):
            continue
        prof = u.get("profile", {}) or {}
        out.append(
            {
                "id": u.get("id"),
                "name": u.get("name"),
                "real_name": prof.get("real_name"),
                "display_name": prof.get("display_name"),
                "email": prof.get("email"),
            }
        )
    print(json.dumps(out, indent=2))


def _resolve_channel(tok: dict, target: str) -> str:
    """Accept a channel ID, #channel-name, or @user-name. Return channel ID."""
    if target.startswith(("C", "D", "G")) and target.isalnum() and target.upper() == target:
        return target
    if target.startswith("@"):
        username = target[1:]
        users = _paginate("users.list", tok, {}, "members")
        match = None
        for u in users:
            if u.get("deleted") or u.get("is_bot"):
                continue
            prof = u.get("profile", {}) or {}
            candidates = [
                u.get("name"),
                prof.get("display_name"),
                prof.get("real_name"),
                prof.get("email"),
            ]
            if username.lower() in [c.lower() for c in candidates if c]:
                match = u
                break
        if not match:
            sys.exit(f"No user matched '{target}'. Try `list-users` to find the right handle.")
        opened = _api("conversations.open", tok, {"users": match["id"]}, post=True)
        return opened["channel"]["id"]
    if target.startswith("#"):
        name = target[1:]
        chans = _paginate(
            "conversations.list",
            tok,
            {"types": "public_channel,private_channel", "exclude_archived": "true"},
            "channels",
        )
        for c in chans:
            if c.get("name") == name:
                return c["id"]
        sys.exit(f"No channel named '{target}'.")
    sys.exit(f"Could not resolve target '{target}'. Use a channel ID, #channel, or @user.")


USER_CACHE_TTL_SEC = 24 * 3600


def _user_name_map(tok: dict, workspace: str | None = None) -> dict:
    """Map user_id -> display name. Cached to disk for 24h since names rarely change
    and users.list is the dominant cost of `unread` (slow + frequent timeouts on large workspaces).
    """
    cache_file = ROOT / f"users-cache-{workspace}.json" if workspace else None
    if cache_file and cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            age = time.time() - cached.get("_fetched_at", 0)
            if age < USER_CACHE_TTL_SEC and isinstance(cached.get("map"), dict):
                return cached["map"]
        except (OSError, json.JSONDecodeError):
            pass  # fall through to fresh fetch
    users = _paginate("users.list", tok, {}, "members", page_limit=500)
    out = {}
    for u in users:
        prof = u.get("profile", {}) or {}
        out[u["id"]] = (
            prof.get("display_name")
            or prof.get("real_name")
            or u.get("name")
            or u["id"]
        )
    if cache_file:
        try:
            cache_file.write_text(
                json.dumps({"_fetched_at": time.time(), "map": out}),
                encoding="utf-8",
            )
        except OSError:
            pass  # cache is opportunistic
    return out


def cmd_read(args):
    tok = _load_token(args.workspace)
    chan = _resolve_channel(tok, args.channel)
    data = _api(
        "conversations.history",
        tok,
        {"channel": chan, "limit": args.limit},
    )
    names = _user_name_map(tok, args.workspace)
    out = []
    for m in data.get("messages", []):
        out.append(
            {
                "ts": m.get("ts"),
                "time": datetime.fromtimestamp(float(m["ts"]), tz=timezone.utc).isoformat()
                if m.get("ts")
                else None,
                "user": names.get(m.get("user"), m.get("user")),
                "text": m.get("text", ""),
                "thread_ts": m.get("thread_ts"),
                "reply_count": m.get("reply_count", 0),
            }
        )
    print(json.dumps(out, indent=2))


def cmd_unread(args):
    """Recent incoming activity in last N hours, across every conversation
    the user is a member of (channels, group DMs, DMs).

    Slack auto-marks channels read when they're on-screen even briefly, so
    `client.counts`-based "unread" misses messages the user actually wants
    to see in triage. This walks all is_member conversations and returns
    every message newer than `now - hours` from someone other than the user.
    """
    tok = _load_token(args.workspace)
    me = tok["user_id"]
    names = _user_name_map(tok, args.workspace)
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=args.hours)).timestamp()

    convs = _paginate(
        "conversations.list",
        tok,
        {"types": "public_channel,private_channel,mpim,im", "exclude_archived": "true"},
        "channels",
    )

    def fetch_recent(channel_id):
        hist = _api(
            "conversations.history",
            tok,
            {"channel": channel_id, "oldest": str(cutoff), "limit": 30},
        )
        msgs = []
        for m in hist.get("messages", []):
            ts = m.get("ts")
            if not ts or float(ts) < cutoff:
                continue
            if m.get("user") == me:
                continue  # skip my own messages
            msgs.append(
                {
                    "from": names.get(m.get("user"), m.get("user") or m.get("username") or "(bot)"),
                    "text": (m.get("text") or "")[:300],
                    "ts": ts,
                    "thread_ts": m.get("thread_ts"),
                }
            )
        msgs.sort(key=lambda x: float(x["ts"]))
        return msgs

    out = {
        "workspace": args.workspace,
        "since_hours": args.hours,
        "channel_recent": [],
        "dm_recent": [],
        "mentions": [],
    }

    for c in convs:
        if c.get("is_archived") or not c.get("is_member", True):
            # is_member is absent on im/mpim (always implicit member), default True
            if c.get("is_im") or c.get("is_mpim"):
                pass
            else:
                continue
        msgs = fetch_recent(c["id"])
        if not msgs:
            continue

        if c.get("is_im"):
            peer_id = c.get("user")
            entry = {
                "channel_id": c["id"],
                "type": "im",
                "peer": names.get(peer_id, peer_id),
                "preview": msgs,
            }
            out["dm_recent"].append(entry)
        elif c.get("is_mpim"):
            entry = {
                "channel_id": c["id"],
                "type": "mpim",
                "peer": c.get("name") or "(group dm)",
                "preview": msgs,
            }
            out["dm_recent"].append(entry)
        else:
            entry = {
                "channel_id": c["id"],
                "name": "#" + (c.get("name") or c["id"]),
                "is_private": c.get("is_private", False),
                "preview": msgs,
            }
            out["channel_recent"].append(entry)

    # Mentions still useful for highlighting "you specifically".
    since = (datetime.now(tz=timezone.utc) - timedelta(hours=args.hours)).strftime("%Y-%m-%d")
    search = _api(
        "search.messages",
        tok,
        {
            "query": f"<@{me}> after:{since}",
            "count": 50,
            "sort": "timestamp",
            "sort_dir": "desc",
        },
    )
    for m in search.get("messages", {}).get("matches", []):
        ts = m.get("ts")
        if ts and float(ts) < cutoff:
            continue
        out["mentions"].append(
            {
                "channel": m.get("channel", {}).get("name"),
                "channel_id": m.get("channel", {}).get("id"),
                "from": m.get("username") or names.get(m.get("user"), m.get("user")),
                "text": (m.get("text") or "")[:300],
                "ts": ts,
                "permalink": m.get("permalink"),
            }
        )

    print(json.dumps(out, indent=2))


def cmd_search(args):
    tok = _load_token(args.workspace)
    data = _api(
        "search.messages",
        tok,
        {"query": args.query, "count": args.max_results, "sort": "timestamp", "sort_dir": "desc"},
    )
    print(json.dumps(data.get("messages", {}), indent=2))


def cmd_send(args):
    tok = _load_token(args.workspace)
    chan = _resolve_channel(tok, args.to)
    payload = {"channel": chan, "text": args.text, "as_user": True}
    if args.thread_ts:
        payload["thread_ts"] = args.thread_ts

    if not args.confirmed:
        # Dry run: show resolution + payload, do nothing.
        info = _api("conversations.info", tok, {"channel": chan})["channel"]
        label = (
            f"#{info['name']}"
            if info.get("name")
            else (f"DM with user {info.get('user')}" if info.get("is_im") else chan)
        )
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "workspace": args.workspace,
                    "team": tok.get("team_name"),
                    "to": args.to,
                    "resolved_channel_id": chan,
                    "resolved_channel_label": label,
                    "thread_ts": args.thread_ts,
                    "text": args.text,
                    "note": "Re-run with --confirmed to actually send.",
                },
                indent=2,
            )
        )
        return

    data = _api("chat.postMessage", tok, payload, post=True)
    print(
        json.dumps(
            {
                "sent": True,
                "channel": data.get("channel"),
                "ts": data.get("ts"),
                "permalink": None,
            },
            indent=2,
        )
    )


# ----------------------------- argparse -----------------------------


def main():
    p = argparse.ArgumentParser(prog="slack")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("auth", help="OAuth-authorize a workspace (needs admin-approved app install)")
    sp.add_argument("--workspace", required=True)
    sp.set_defaults(func=cmd_auth)

    sp = sub.add_parser(
        "auth-cookie",
        help="Save browser-extracted xoxc token + `d` cookie (workaround when admin blocks app installs)",
    )
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--token", required=True, help="xoxc-... user token from localConfig_v2")
    sp.add_argument("--cookie", required=True, help="value of the `d` cookie from app.slack.com")
    sp.set_defaults(func=cmd_auth_cookie)

    sp = sub.add_parser("whoami")
    sp.add_argument("--workspace", required=True)
    sp.set_defaults(func=cmd_whoami)

    sp = sub.add_parser("list-channels")
    sp.add_argument("--workspace", required=True)
    sp.set_defaults(func=cmd_list_channels)

    sp = sub.add_parser("list-users")
    sp.add_argument("--workspace", required=True)
    sp.set_defaults(func=cmd_list_users)

    sp = sub.add_parser("read", help="Read recent messages from a channel/DM")
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--channel", required=True, help="channel ID, #channel, or @user")
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_read)

    sp = sub.add_parser("unread", help="DM unreads + recent @-mentions")
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--hours", type=int, default=24, help="Lookback for mentions")
    sp.set_defaults(func=cmd_unread)

    sp = sub.add_parser("search")
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--query", required=True)
    sp.add_argument("--max-results", type=int, default=20)
    sp.set_defaults(func=cmd_search)

    sp = sub.add_parser("send", help="Send a message (dry-run unless --confirmed)")
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--to", required=True, help="channel ID, #channel, or @user")
    sp.add_argument("--text", required=True)
    sp.add_argument("--thread-ts", default=None, help="Reply in a thread")
    sp.add_argument("--confirmed", action="store_true", help="Actually send (else dry-run)")
    sp.set_defaults(func=cmd_send)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
