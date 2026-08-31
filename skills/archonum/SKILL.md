---
name: archonum
description: Stealth web access through the archonum remote browser (MCP). Use when web_fetch/web_search come back blocked, empty, or CAPTCHA'd; when data only appears after interaction (search forms, login, carts, multi-step flows); or when a page must be viewed from a specific exit country (geo pricing, availability, localization). Covers MCP setup, the tool set, limits, and troubleshooting.
---

# Archonum browser — agent setup

Archonum is a hosted **remote stealth browser**: real-device Chrome reached over
an MCP endpoint, with a per-session exit country. It walks past bot walls
(Cloudflare, Akamai, Kasada) that block normal fetching, runs full client-side
JS, can act on pages (forms, login, multi-step flows), and can view a page as
seen from a chosen country.

The browser is hosted, so there is no browser or driver to install — you only
add the endpoint. (One exception: Claude Desktop with Basic auth needs the
`mcp-remote` bridge, because its connector UI cannot send custom headers.
OAuth needs nothing.)

## When to use this vs the built-in web_fetch / web_search

- Default to `web_fetch` / `web_search` for reading open, undefended pages —
  they are faster and cheaper.
- Reach for archonum when any of:
  1. a site blocks bots (403, a CAPTCHA/challenge, or empty/partial content),
  2. the data only appears after interaction (search form, login, cart,
     booking, multi-step flow),
  3. you need the page as seen from a specific country (geo pricing /
     availability / localization).
- Rule of thumb: if `web_fetch` comes back blocked or suspiciously empty, retry
  that URL with the `read` tool.

## Step 1 — Add the MCP server

Two ways to authenticate:

- **OAuth (interactive clients):** add the endpoint with no credentials; the
  client discovers the OAuth flow and opens a browser window to sign in.
- **HTTP Basic (headless setups):** your archonum **username** and **API
  token** (the same token the proxy and CDP gateway use). Your API-key page
  shows a pre-encoded, paste-ready command under "Setup for agents".

Claude Code (OAuth — then run `/mcp` and pick archonum → Authenticate):

```
claude mcp add --transport http archonum https://app.archonum.com/mcp
```

Claude Code (Basic):

```
claude mcp add --transport http archonum https://app.archonum.com/mcp \
  --header "Authorization: Basic <base64 of username:token>"
```

Generic MCP client config (Streamable HTTP):

```json
{
  "mcpServers": {
    "archonum": {
      "type": "http",
      "url": "https://app.archonum.com/mcp",
      "headers": { "Authorization": "Basic <base64 of username:token>" }
    }
  }
}
```

Generate `<base64 of username:token>` yourself with:

```
printf '%s' 'USERNAME:TOKEN' | base64
```

## Step 2 — Verify

Call the `read` tool on a simple URL and confirm you get rendered text back:

- Tool: `read`
- Arguments: `{ "url": "https://example.com" }`

A successful call returns the page's rendered text with a status line.

## Tools

- `read` — one-shot stealth fetch: rendered text of a page (optionally from a
  given `country`). The `web_fetch` substitute; no session needed.
- `open_session` / `close_session` / `list_sessions` — hold independent
  per-country sessions (e.g. `ch`, `it`), each its own exit IP, so per-country
  work never mixes.
- `navigate` / `back` / `wait_for_content` — load a URL in a session (or go
  back one history entry); report whether a bot wall cleared.
- `snapshot` — ref-tagged accessibility outline of interactive elements.
- `get_text` — the current in-session page's rendered text; `selector` reads
  just one element (a price, a table).
- `get_html` — the current page's fully rendered HTML (post-JS DOM) for
  structured extraction; scope with `selector`, truncated at `maxChars`.
- `click` / `type` / `select` / `press` / `scroll` — act on the page by ref.
- `page_info` — current URL, title, status, blocked flag, viewport.
- `screenshot` — viewport PNG when you need to see it.
- `compare_countries` — replay a fixed flow across countries in one call.
- `get_credits` — remaining credit balance (MB); check before large jobs.


## Limits worth knowing before you plan a run

- **5 open sessions** per account; opening a sixth fails until you close one.
- **3 concurrent `read` / `compare_countries` calls**, shared across both.
- **Idle sessions are reaped after 10 minutes.** A named session then reports
  "is not open" — reopen it with `open_session`. Only `default` re-opens itself.
- **A pool idle for 30 minutes is reclaimed** ("session pool was reclaimed after
  being idle; retry to get a fresh one"). Retrying works; it is not an error
  state to report to the user.
- Reopening a session name with a **different country replaces** it — the page
  and its state are gone, exactly as with `freshIdentity`.
- `read` output is capped at 8,000 characters. For more, `navigate` in a session
  and use `get_text` with a larger `maxChars` (up to 50,000) or a `selector`.
- Page loads time out at 90 s; `wait_for_content` accepts at most 60 s.
- Everything bills as bandwidth. Check `get_credits` before a large job;
  screenshots and media-heavy pages cost noticeably more than text reads.

## Troubleshooting

- **401 / invalid credentials** — the username or token is genuinely wrong (or
  the account's email is unverified). Recheck the setup command on your API-key
  page; regenerating the key invalidates the old one everywhere.
- **402 / out of credits** — the balance is empty, or a free trial lapsed with
  credits still on the account. Do NOT re-authenticate or regenerate the key;
  it will not help. Top up, then retry.
- **"no capacity in country X"** — no healthy device for that exit country right
  now; retry shortly or try another country.
- **404 unknown session** — the MCP session id expired (30 minutes idle).
  Re-initialize the connection.
- **A page stays blocked** — call `wait_for_content`; if it reports
  `stalled=true`, reopen the session with `freshIdentity: true` for a new device
  identity, then navigate again.
