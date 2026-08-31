// samples/mcp-server.js — expose the archonum remote browser as MCP tools.
//
// Turns the stealth, geo-aware remote Chrome behind ArchonumEngine into tools an
// MCP client (e.g. Claude) can call:
//   • read                          — one-shot stealth fetch: rendered text of a (possibly
//       bot-walled or country-specific) page, no session. The web_fetch substitute.
//   • open_session / close_session / list_sessions — hold several INDEPENDENT
//       sessions at once, each pinned to its own exit country (e.g. "ch", "it"),
//       so per-country work never mixes
//   • navigate / wait_for_content — load a URL in a session and report whether a bot wall
//       cleared (with challenge classification and a stalled=hard-block fast-fail)
//   • snapshot                      — read a ref-tagged accessibility outline (pierces shadow
//       DOM and same-origin iframes)
//   • get_text                      — the current page's rendered text (read, but in-session)
//   • click / type / select / press / scroll — act on it by ref; click/select/press verify
//       the action had an effect and say so
//   • screenshot                    — grab the viewport as a PNG when you need to SEE it
//   • compare_countries             — replay a fixed declarative flow across countries in one call
//
// Every interactive tool takes an optional `session` name (default: "default").
// Each session is its own remote browser connection + tab + exit country, with
// its own serialize queue, so different sessions run concurrently and stay
// separate. Sessions connect lazily and self-heal if the shared remote recycles.
//
// The MCP SDK + zod ship as dependencies of this workspace package, so `pnpm install`
// at the repo root covers them.
//
//   ARCHONUM_TOKEN=… ARCHONUM_USERNAME=… node samples/mcp-server.js
//   # or wire it into an MCP client's config as the command to run.
//   # Uses --env-file too:  node --env-file=.env samples/mcp-server.js
//
// IMPORTANT: stdout is the MCP JSON-RPC transport — all logging goes to stderr.

import { ArchonumEngine } from '@archonum/engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if (!process.env.ARCHONUM_TOKEN && !process.env.ARCHONUM_PASSWORD && !process.env.ARCHONUM_CDP_PASSWORD) {
  console.error('✗ set ARCHONUM_TOKEN and ARCHONUM_USERNAME (see the comment at the top of this file)');
  process.exit(1);
}

const engine = ArchonumEngine.fromEnv({ log: (msg) => console.error(`  ${msg}`) }); // stderr — never stdout

// --- Session registry --------------------------------------------------------
// Named, independent sessions. Each entry is one remote browser connection + tab
// pinned to an exit country, with its own serialize `tail` (a single tab can't be
// driven concurrently, but different sessions can). This is what lets a CH and an
// IT session run side by side without mixing.

const sessions = new Map(); // name -> { session, page, country, tail }
const opening = new Map(); // name -> in-flight open promise, so first-use races don't double-connect

function open(name, country) {
  if (opening.has(name)) return opening.get(name);
  const p = (async () => {
    const prev = sessions.get(name);
    if (prev) await prev.session.disconnect().catch(() => {}); // replace a dead/old session under this name
    const session = await engine.connect({ country });
    const page = await session.newPage({ desktop: true });
    const entry = { session, page, country: country ?? engine.client.country, tail: Promise.resolve() };
    sessions.set(name, entry);
    return entry;
  })();
  opening.set(name, p);
  p.finally(() => opening.delete(name)).catch(() => {});
  return p;
}

async function ensure(name = 'default') {
  const entry = sessions.get(name);
  if (entry) {
    const alive = !entry.page.isClosed() && entry.session.browser.connected;
    if (alive) return entry;
    return open(name, entry.country); // self-heal on the same exit country
  }
  // Never auto-create a *named* session — that would silently pick the wrong exit
  // country and mix results. Only the implicit "default" is created on demand.
  if (name !== 'default') {
    throw new Error(`session "${name}" is not open — open it first with open_session (and its country)`);
  }
  return open('default'); // uses the client's default exit country
}

// Serialize an op onto one session's queue; different sessions stay concurrent.
function serialize(entry, fn) {
  const run = entry.tail.then(fn, fn);
  entry.tail = run.then(() => {}, () => {});
  return run;
}

// Resolve the session, then run the page op serialized on it.
async function on(name, fn) {
  const entry = await ensure(name);
  return serialize(entry, () => fn(entry));
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const label = (session) => `[${session ?? 'default'}]`; // which session a result came from
const state = (info) => {
  let flags = `status=${info.status} blocked=${info.blocked}`;
  if (info.challenge) flags += ` challenge=${info.challenge} clearable=${info.clearable}`;
  if (info.stalled) flags += ' stalled=true';
  if (info.settled === false) flags += ' settled=false';
  return `url: ${info.url}\n${flags} text=${info.textLength}\ntitle: ${info.title}`;
};
const effectNote = (effect, { via, fallback } = {}) => {
  let s = ` effect=${effect}`;
  if (via === 'enter') s += ' activated-via=enter';
  if (effect === 'none') {
    s += fallback
      ? ' (no DOM change or navigation within 1s — click AND Enter fallback both ignored)'
      : ' (no DOM change or navigation within 1s — the widget may want keyboard activation: retry with fallback:true)';
  }
  return s;
};
const sessionParam = z
  .string()
  .optional()
  .describe('session to act on (default: "default"). Open per-country sessions with open_session to keep e.g. CH and IT separate.');

// --- Server ------------------------------------------------------------------

// The mental model, stated once. Clients surface this to the agent as a preamble,
// so the per-tool descriptions can stay short and factual.
const INSTRUCTIONS = `
A remote stealth browser: real-device Chrome via the archonum gateway, with a per-session exit country. It gets past bot walls that block normal fetching, runs full client-side JS, can ACT on pages (forms, login, multi-step), and can view a page from a chosen country.

WHEN TO USE THIS vs the built-in web_fetch / web_search:
- Default to web_fetch/web_search for reading open, undefended pages — they are faster and cheaper.
- Reach for this when ANY of: (a) a site blocks bots — web_fetch returns 403, a CAPTCHA/challenge, or empty/partial content; (b) the data only appears after interaction — a search form, login, cart, booking, multi-step flow; (c) you need the page as seen from a specific country (geo pricing / availability / localization).
- Rule of thumb: if web_fetch comes back blocked or suspiciously empty, retry that URL with read (below).

READING a page (no interaction): use read(url, country?) — one-shot "fetch but unblockable", returns rendered text. This is the archonum equivalent of web_fetch. On JS-heavy pages pass waitForText so it can't return a half-rendered shell; settled=false flags an incomplete extraction.

INTERACTING with a page: drive a session — navigate → snapshot → act (click/type/select/press/scroll) → snapshot again.
- snapshot lists interactive elements as [e12] button "Save". Act on an element by its eN ref. It pierces open shadow DOM and same-origin iframes ([iframe]-tagged); cross-origin iframes appear as [frame] markers.
- To READ the current page's text (prices, times, descriptions — content snapshot doesn't list), use get_text: same extraction as read, but for the state you drove to. No need to re-fetch the URL elsewhere.
- Refs are EPHEMERAL: they belong to that session's most recent snapshot and go stale the instant the DOM changes (a click, a navigation, an async update). If acting on a ref fails, re-run snapshot and use fresh refs — never reuse an old eN. Prefer snapshot over screenshot (cheap text, and it is where refs come from).
- click/type FAIL LOUDLY (they don't silently no-op): if an overlay covers the target or a modal eats the keystrokes, the error names the blocker — dismiss it (or open it via its own ref) and retry. click/select/press also report effect= (navigation | dom-change | none): effect=none means the page IGNORED the action — for clicks, retry with fallback:true (keyboard activation). Every result also carries the page url; use page_info to grab the current URL any time.
- Bot walls: navigate reports "blocked" plus a challenge= classification (cloudflare-turnstile, cloudflare-js-challenge, akamai, unknown-empty, …) and clearable= (likely/maybe/unlikely). If blocked, call wait_for_content: most walls clear on their own (real device), but if it returns stalled=true the identity is HARD-blocked — do not keep waiting; reopen the session with freshIdentity:true (new device/exit IP, same name) and navigate again.

COMPARING exit countries: for a real flow, open one session per country (open_session "ch" country ch, open_session "it" country it) and drive each via the \`session\` arg — pages/refs are per-session and never mix. For a quick no-interaction diff, use read per country or compare_countries.
`.trim();

const server = new McpServer({ name: 'archonum-browser', version: '1.0.0' }, { instructions: INSTRUCTIONS });

// --- Session management ------------------------------------------------------

server.registerTool(
  'open_session',
  {
    title: 'Open a session',
    description:
      'Open a named session pinned to an exit country (e.g. name "it", country "it"), then pass ' +
      'the name as `session` to the other tools. Sessions are independent and never mix; reopening ' +
      'an existing name keeps it unless `freshIdentity` is set.',
    inputSchema: {
      name: z.string().describe('session name, e.g. "ch" or "it"'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 exit country; defaults to the server default'),
      freshIdentity: z
        .boolean()
        .default(false)
        .describe(
          'reconnect under the same name with a NEW device identity/exit IP (the gateway rotates real devices). ' +
            'Use when a bot wall hard-blocks the current identity — e.g. wait_for_content reports stalled=true.',
        ),
    },
  },
  async ({ name, country, freshIdentity }) => {
    const existing = sessions.get(name);
    const alive = existing && !existing.page.isClosed() && existing.session.browser.connected;
    if (alive && !freshIdentity && (!country || country === existing.country)) {
      return text(`session "${name}" already open (country=${existing.country}) — pass freshIdentity:true for a new device identity`);
    }
    const e = await open(name, country ?? existing?.country);
    const device = e.session.info?.Browser || e.session.info?.['User-Agent'] || '';
    return text(
      `session "${name}" open (country=${e.country}${freshIdentity ? ', fresh identity' : ''})${device ? `\ndevice: ${device}` : ''}`,
    );
  },
);

server.registerTool(
  'close_session',
  {
    title: 'Close a session',
    description: 'Disconnect and drop a named session (the shared remote keeps running for others).',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const entry = sessions.get(name);
    if (entry) {
      await entry.session.disconnect().catch(() => {});
      sessions.delete(name);
    }
    return text(`session "${name}" closed`);
  },
);

server.registerTool(
  'list_sessions',
  {
    title: 'List sessions',
    description: 'List open sessions with their exit country and current URL.',
    inputSchema: {},
  },
  async () => {
    if (sessions.size === 0) return text('(no sessions open)');
    return text([...sessions].map(([name, e]) => `${name}  country=${e.country}  ${e.page.url()}`).join('\n'));
  },
);

server.registerTool(
  'page_info',
  {
    title: 'Page info',
    description:
      'Report a session\'s active page: URL (after redirects), title, status, bot-wall "blocked" ' +
      'flag, rendered-text length, viewport + device profile, and whether a modal dialog is open. ' +
      'Use it to capture the current URL (e.g. a booking deep link) or to check state after a navigation.',
    inputSchema: { session: sessionParam },
  },
  ({ session }) =>
    on(session, async (entry) => {
      const info = await entry.session.pageInfo(entry.page);
      const vp = entry.page.viewport() || {};
      const openDialog = await entry.page
        .evaluate(() => !!document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]'))
        .catch(() => false);
      return text(
        `${label(session)} ${state(info)}\n` +
          `viewport: ${vp.width ?? '?'}x${vp.height ?? '?'} (${vp.isMobile ? 'mobile' : 'desktop'}, dpr ${vp.deviceScaleFactor ?? 1})\n` +
          `openDialog: ${openDialog}`,
      );
    }),
);

// --- read: one-shot stealth fetch (the web_fetch substitute) -----------------

server.registerTool(
  'read',
  {
    title: 'Read a page (stealth fetch)',
    description:
      'Fetch a URL through the real-device remote browser and return its rendered text — like ' +
      'web_fetch, but it gets past bot walls, runs full JS, and can read the page as seen from a ' +
      'given `country`. Reach for this the moment web_fetch is blocked/empty, or when you need a ' +
      'country-specific view. On JS-heavy pages pass `waitForText` (a string you expect on the ' +
      'loaded page) so it cannot return a half-rendered shell; `settled=false` in the result means ' +
      'the wait timed out and the text may be incomplete. One-shot: no session, no interaction — ' +
      'for forms/login/clicking, use open_session + navigate instead.',
    inputSchema: {
      url: z.string().url(),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 exit country; defaults to the server default'),
      waitForText: z.string().optional().describe('wait until this text appears before extracting (deterministic reads of JS-heavy pages)'),
      minTextLength: z.number().int().positive().optional().describe('wait until this much text has rendered (default 200)'),
      format: z.enum(['text', 'markdown']).default('markdown').describe('markdown keeps headings/links/tables and drops navigation chrome; text is the raw rendered text'),
      screenshot: z.boolean().default(false).describe('also return a viewport PNG'),
    },
  },
  ({ url, country, waitForText, minTextLength, format, screenshot }) =>
    engine.read(url, { country, waitForText, minTextLength, format, screenshot }).then((r) => {
      const content = [
        { type: 'text', text: `[${country ?? (engine.client.country || 'any')}] ${state(r)}\n\n${r.text}${r.truncated ? '\n\n…(truncated)' : ''}` },
      ];
      if (r.screenshot) content.push({ type: 'image', data: Buffer.from(r.screenshot).toString('base64'), mimeType: 'image/png' });
      return { content };
    }),
);

// --- Interactive tools (each takes an optional `session` name) ---------------

server.registerTool(
  'navigate',
  {
    title: 'Navigate',
    description:
      'Load a URL in a session to then INTERACT with it (forms, login, clicking). Returns status, ' +
      'title, rendered-text length, and a bot-wall "blocked" flag; call snapshot next. If you only ' +
      'need to READ a page (even a bot-walled or country-specific one), use `read` instead — it is ' +
      'one-shot and needs no session.',
    inputSchema: {
      url: z.string().url(),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).default('load'),
      session: sessionParam,
    },
  },
  ({ url, waitUntil, session }) =>
    on(session, async (entry) => {
      const res = await entry.page.goto(url, { waitUntil, timeout: 90_000 });
      const info = await entry.session.pageInfo(entry.page, res);
      return text(
        `${label(session)} ${state(info)}${
          info.blocked
            ? '\n\nLooks blocked — wait_for_content next; if it reports stalled=true, reopen this session with freshIdentity:true.'
            : ''
        }`,
      );
    }),
);

server.registerTool(
  'wait_for_content',
  {
    title: 'Wait for content',
    description:
      'Poll until the page renders real content (a bot wall clearing, or slow JS finishing) or ' +
      'until it times out. Pass `containsText` to wait for a specific string instead — the match ' +
      'is returned with surrounding context. Returns EARLY with stalled=true when the page shows ' +
      'zero progress (no DOM mutation/network/text change for 10s): that identity is hard-blocked, ' +
      'so stop waiting and reopen the session with freshIdentity:true.',
    inputSchema: {
      minTextLength: z.number().int().positive().default(200),
      containsText: z.string().optional().describe('wait for this text instead of a length; the matching excerpt is returned'),
      timeoutMs: z.number().int().positive().max(60_000).default(15_000),
      session: sessionParam,
    },
  },
  ({ minTextLength, containsText, timeoutMs, session }) =>
    on(session, async (entry) => {
      const info = await entry.session.waitForContent(entry.page, { minTextLength, containsText, timeoutMs });
      let out = `${label(session)} ${state(info)}`;
      if (info.excerpt) out += `\nmatch: …${info.excerpt}…`;
      if (info.stalled) out += `\n\n${info.recommendation}`;
      return text(out);
    }),
);

server.registerTool(
  'get_text',
  {
    title: 'Get page text',
    description:
      "Return the session's CURRENT page as rendered text — what `read` gives you, but for the " +
      'state you drove to (search results, a cart, a logged-in view), with no navigation and no ' +
      'new session. Use it whenever snapshot (interactive elements only) is not enough to read ' +
      'the content.',
    inputSchema: {
      maxChars: z.number().int().positive().max(50_000).default(8000),
      format: z.enum(['text', 'markdown']).default('markdown').describe('markdown keeps headings/links/tables and drops navigation chrome; text is the raw rendered text'),
      session: sessionParam,
    },
  },
  ({ maxChars, format, session }) =>
    on(session, async (entry) => {
      const info = await entry.session.pageInfo(entry.page);
      const { text: body, truncated } =
        format === 'markdown'
          ? await entry.session.pageMarkdown(entry.page, { maxChars }).then((m) => ({ text: m.markdown, truncated: m.truncated }))
          : await entry.session.pageText(entry.page, { maxChars });
      return text(`${label(session)} url: ${info.url}\n\n${body}${truncated ? '\n\n…(truncated)' : ''}`);
    }),
);

server.registerTool(
  'snapshot',
  {
    title: 'Snapshot (accessibility outline)',
    description:
      'Return a ref-tagged outline of the page\'s interactive elements and headings, e.g. ' +
      '`[e12] button "Add to cart"`. Pierces open shadow DOM (web-component widgets) AND ' +
      'same-origin iframes (embedded widgets — their elements are tagged [iframe] and work with ' +
      'the same refs); cross-origin iframes are listed as [frame] markers since their contents ' +
      'are unreachable. Use the eN refs with click/type; re-run it after the page changes. For ' +
      'the page\'s plain text (prices, times, descriptions), use get_text.',
    inputSchema: { session: sessionParam },
  },
  ({ session }) => on(session, async (entry) => text(await entry.session.snapshot(entry.page))),
);

server.registerTool(
  'click',
  {
    title: 'Click',
    description:
      'Click an element by its snapshot ref (e.g. "e12"). Fails (naming the overlay) if something ' +
      'covers the target — dismiss the overlay and retry. The result reports what the click DID: ' +
      'effect=navigation | dom-change | none. effect=none means the page ignored the click (some ' +
      'widgets only accept keyboard activation) — retry with fallback:true, which re-activates via ' +
      'focus + Enter. Re-snapshot afterwards.',
    inputSchema: {
      ref: z.string().describe('An element ref from snapshot, like "e12"'),
      force: z.boolean().default(false).describe('skip the overlay check (for false positives like transparent wrappers)'),
      fallback: z.boolean().default(false).describe('on effect=none, automatically retry activation via focus + Enter'),
      session: sessionParam,
    },
  },
  ({ ref, force, fallback, session }) =>
    on(session, async (entry) => {
      const { effect, via } = await entry.session.click(entry.page, ref, { force, fallback });
      const info = await entry.session.pageInfo(entry.page);
      return text(`${label(session)} clicked ${ref}${effectNote(effect, { via, fallback })}\n${state(info)}`);
    }),
);

server.registerTool(
  'type',
  {
    title: 'Type',
    description:
      'Type text into an input/textarea by its snapshot ref. Existing text is cleared first; set ' +
      'submit=true to press Enter after. Verifies the text actually landed and FAILS if it did not ' +
      '(e.g. an overlay ate the keystrokes) — set verify:false for widgets that reformat input.',
    inputSchema: {
      ref: z.string().describe('An element ref from snapshot, like "e3"'),
      text: z.string(),
      submit: z.boolean().default(false),
      verify: z.boolean().default(true).describe('read the field back and fail if the text did not land'),
      session: sessionParam,
    },
  },
  ({ ref, text: value, submit, verify, session }) =>
    on(session, async (entry) => {
      await entry.session.type(entry.page, ref, value, { submit, verify });
      return text(`${label(session)} typed into ${ref}${submit ? ' and pressed Enter' : ''}`);
    }),
);

server.registerTool(
  'select',
  {
    title: 'Select option',
    description: 'Choose an option in a <select> dropdown by its snapshot ref. `value` matches the option\'s visible label or its value attribute.',
    inputSchema: {
      ref: z.string().describe('A combobox/select ref from snapshot, like "e7"'),
      value: z.string().describe('The option label or value to choose'),
      session: sessionParam,
    },
  },
  ({ ref, value, session }) =>
    on(session, async (entry) => {
      const { effect } = await entry.session.select(entry.page, ref, value);
      return text(`${label(session)} selected ${JSON.stringify(value)} in ${ref}${effectNote(effect)}`);
    }),
);

server.registerTool(
  'press',
  {
    title: 'Press key',
    description:
      'Press a key or key-combo — "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+A", ' +
      'etc. Optionally focus an element first via its snapshot ref.',
    inputSchema: {
      key: z.string().describe('e.g. "Enter", "Escape", "ArrowDown", "Control+A"'),
      ref: z.string().optional().describe('Optional element ref to focus before pressing'),
      session: sessionParam,
    },
  },
  ({ key, ref, session }) =>
    on(session, async (entry) => {
      const { effect } = await entry.session.press(entry.page, key, { ref });
      const info = await entry.session.pageInfo(entry.page);
      return text(`${label(session)} pressed ${key}${effectNote(effect)}\n${state(info)}`);
    }),
);

server.registerTool(
  'scroll',
  {
    title: 'Scroll',
    description:
      'Scroll the page, or bring an element into view. With `ref`, centers that element (direction ' +
      'ignored); otherwise scrolls `direction`: "down"/"up" (~one viewport) or "top"/"bottom".',
    inputSchema: {
      direction: z.enum(['down', 'up', 'top', 'bottom']).default('down'),
      ref: z.string().optional().describe('Optional element ref to scroll into view'),
      session: sessionParam,
    },
  },
  ({ direction, ref, session }) =>
    on(session, async (entry) => {
      await entry.session.scroll(entry.page, { direction, ref });
      return text(`${label(session)} ${ref ? `scrolled ${ref} into view` : `scrolled ${direction}`}`);
    }),
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot',
    description: 'Capture the current viewport as a PNG. Use when you need to SEE the page; prefer snapshot for reading and acting.',
    inputSchema: { session: sessionParam },
  },
  ({ session }) =>
    on(session, async (entry) => {
      const { buffer, clip, width, height } = await entry.session.captureViewport(entry.page);
      const short = width != null && (width < clip.width || height < clip.height);
      return {
        content: [
          {
            type: 'text',
            text: `${label(session)} captured ${width ?? '?'}x${height ?? '?'} (viewport ${clip.width}x${clip.height})${short ? ' — PARTIAL capture; the page may be mid-resize, retry' : ''}`,
          },
          { type: 'image', data: Buffer.from(buffer).toString('base64'), mimeType: 'image/png' },
        ],
      };
    }),
);

// --- compare_countries: declarative, one-call geo diff -----------------------
// The fast path when the flow is simple/deterministic (or you just want a homepage
// diff): it replays a FIXED step list blind in a fresh session per country. For
// fiddly interactive flows (autocompletes, date pickers, challenges), prefer
// open_session per country + the interactive tools, which let you adapt per step.

// One step of a replayable flow. Targets an element by its visible name/label
// (`target`, as shown in snapshot) or a CSS `selector` — NOT an eN ref, since
// refs don't survive across the fresh per-country sessions.
const flowStep = z
  .object({
    action: z.enum(['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'waitForContent']),
    target: z.string().optional().describe('element name/label from snapshot, e.g. "Search" or "Accept all"'),
    selector: z.string().optional().describe('CSS selector — a language-independent alternative to target'),
    role: z.string().optional().describe('optional role to disambiguate, e.g. "button"'),
    url: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    direction: z.enum(['down', 'up', 'top', 'bottom']).optional(),
    submit: z.boolean().optional(),
    clear: z.boolean().optional(),
    ms: z.number().optional(),
    optional: z.boolean().optional().describe('skip if the target is not found (cookie banners, occasional popups)'),
  })
  .describe('one flow step');

server.registerTool(
  'compare_countries',
  {
    title: 'Compare a flow across exit countries',
    description:
      'Quick geo-diff: replay a FIXED `steps` flow across `countries` in parallel (a fresh session ' +
      'each) and compare. Steps target elements by visible name (`target`) or CSS `selector`, not ' +
      'eN ref. Omit `steps` to just load `url`. Pull a value per country with `extract` (CSS ' +
      'selector) and/or set `screenshot`. For flows that need real interaction, use open_session ' +
      'per country instead (see the server instructions).',
    inputSchema: {
      url: z.string().url(),
      countries: z.array(z.string().length(2)).min(2).max(5).describe('ISO 3166-1 alpha-2 codes, e.g. ["ch","it"]'),
      steps: z.array(flowStep).default([]),
      extract: z.string().optional().describe("CSS selector; return this element's text per country (e.g. the total price)"),
      screenshot: z.boolean().default(false).describe('include a viewport PNG per country'),
    },
  },
  ({ url, countries, steps, extract, screenshot }) =>
    engine.compareFlow(url, { countries, steps, extract, screenshot }).then((results) => {
      const content = [
        {
          type: 'text',
          text: results
            .map(
              (r) =>
                `### ${r.country.toUpperCase()}  [HTTP ${r.status}${r.blocked ? ', blocked' : ''}]\n` +
                `title: ${r.title}\ntext length: ${r.textLength}` +
                (r.extracted != null ? `\nextracted: ${r.extracted}` : '') +
                `\nexcerpt: ${r.excerpt}`,
            )
            .join('\n\n'),
        },
      ];
      for (const r of results) {
        if (r.screenshot) {
          content.push({ type: 'text', text: `— ${r.country.toUpperCase()} —` });
          content.push({ type: 'image', data: Buffer.from(r.screenshot).toString('base64'), mimeType: 'image/png' });
        }
      }
      return { content };
    }),
);

// --- Lifecycle ---------------------------------------------------------------

async function shutdown() {
  await Promise.all([...sessions.values()].map((e) => e.session.disconnect().catch(() => {})));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error('✓ archonum MCP server ready on stdio');
