import type { ElementHandle, Page } from 'puppeteer-core';

interface ScanOptions {
  locate?: { name?: string; role?: string; selector?: string } | null;
  maxNodes?: number;
}

/**
 * The one in-page DOM walk behind both {@link snapshotOutline} and
 * {@link locateRef}, so the role/name definitions never drift between "list
 * elements" and "find an element". Without `locate` it returns the outline
 * string; with `locate` it stamps the first match as `e1` and returns `"e1"`
 * (or `null`).
 */
async function scan(page: Page, opts: ScanOptions): Promise<string | null> {
  return page.evaluate((options: ScanOptions): string | null => {
    const locate = options.locate ?? null;
    const maxNodes = options.maxNodes ?? 400;
    // Roles worth surfacing to an agent: things you read or act on.
    const KEEP = new Set([
      'link', 'button', 'textbox', 'checkbox', 'radio', 'submit',
      'combobox', 'heading', 'tab', 'menuitem', 'option', 'switch',
    ]);
    const roleFor = (el: Element): string | null => {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName;
      if (tag === 'A') return 'link';
      if (tag === 'BUTTON') return 'button';
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button' ? t : 'textbox';
      }
      if (/^H[1-6]$/.test(tag)) return 'heading';
      // Web-component / focusable fallback: custom elements (maui-button, …)
      // and focusable divs that carry a click affordance. Design systems wrap
      // real buttons in web components, so without this their submit buttons
      // are invisible to the outline.
      const focusable = el.getAttribute && el.getAttribute('tabindex') != null;
      if ((tag && tag.includes('-')) || focusable) {
        if (focusable || typeof (el as HTMLElement).onclick === 'function') return 'button';
      }
      return null;
    };
    const nameFor = (el: Element, role: string | null): string => {
      const raw =
        (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
          el.getAttribute('alt') || el.getAttribute('title'))) ||
        (role === 'textbox' ? '' : (el as HTMLElement).innerText || el.textContent) ||
        '';
      return raw.trim().replace(/\s+/g, ' ').slice(0, 120);
    };
    const visible = (el: Element): boolean => {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const s = view.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // querySelectorAll stops at shadow-root and frame boundaries, so walk the
    // roots ourselves: light DOM + every OPEN shadow root + every SAME-ORIGIN
    // iframe document. Same-origin frames are read via contentDocument from
    // THIS (main-frame) evaluate — no child-frame execution context is ever
    // entered, which matters because the isolated-world Runtime-leak patch this
    // SDK relies on hangs child-frame execution. Closed shadow roots are
    // unreachable from page script; cross-origin frames can't be read, so
    // they're reported as markers rather than silently skipped.
    const all: Element[] = [];
    const frameNotes: string[] = [];
    const collect = (root: Document | ShadowRoot | Element): void => {
      let els: NodeListOf<Element>;
      try { els = root.querySelectorAll('*'); } catch { return; }
      for (const el of els) {
        all.push(el);
        if (el.shadowRoot) collect(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc: Document | null = null;
          try { doc = (el as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
          if (doc) collect(doc);
          else if (visible(el)) {
            const label = el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('id') || '';
            frameNotes.push(
              `[frame] cross-origin iframe${label ? ` ${JSON.stringify(label)}` : ''} (${el.getAttribute('src') || 'no src'}) — contents not reachable`,
            );
          }
        }
      }
    };
    collect(document);

    all.forEach((el) => el.removeAttribute && el.removeAttribute('data-archonum-ref'));

    // Fast path: locate by raw CSS selector (also pierces, since `all` does).
    if (locate && locate.selector) {
      const sel = locate.selector;
      const el = all.find((e) => {
        try { return e.matches && e.matches(sel) && visible(e); } catch { return false; }
      });
      if (!el) return null;
      el.setAttribute('data-archonum-ref', '1');
      return 'e1';
    }

    const wantName = locate && locate.name ? locate.name.trim().toLowerCase() : null;
    const wantRole = locate && locate.role ? locate.role : null;

    const lines: string[] = [];
    let ref = 0;
    for (const el of all) {
      if (!locate && lines.length >= maxNodes) break;
      const role = roleFor(el);
      if (!role || !KEEP.has(role) || !visible(el)) continue;
      const name = nameFor(el, role);
      if (locate) {
        if (wantRole && role !== wantRole) continue;
        const hay = name.toLowerCase();
        if (wantName && hay !== wantName && !hay.includes(wantName)) continue;
        el.setAttribute('data-archonum-ref', '1');
        return 'e1';
      }
      if (!name && role === 'heading') continue;
      ref += 1;
      el.setAttribute('data-archonum-ref', String(ref));
      let line = `[e${ref}] ${role} ${JSON.stringify(name)}`;
      if (role === 'textbox' && (el as HTMLInputElement).value) line += ` (value: ${JSON.stringify((el as HTMLInputElement).value)})`;
      if (el.ownerDocument !== document) line += ' [iframe]';
      lines.push(line);
    }
    if (locate) return null;
    lines.push(...frameNotes);
    return lines.join('\n') || '(no interactive elements found)';
  }, opts);
}

/**
 * A compact, ref-tagged outline of the page's interactive elements and
 * headings — the accessibility surface an agent needs to DRIVE a page rather
 * than just look at a screenshot. Each line is `[eN] role "name"`; the ref
 * `eN` is stamped onto the element (data-archonum-ref) so click/type can act
 * on it by ref. Far cheaper than a screenshot (text, not vision tokens).
 * Pierces OPEN shadow roots (web-component controls surface) AND same-origin
 * iframes (their elements get refs, tagged `[iframe]`, and are actionable
 * like any other); cross-origin iframes can't be read, so a `[frame]` marker
 * line reports each one instead of silence. Re-run after any navigation —
 * refs are only valid until the DOM changes.
 */
export async function snapshotOutline(page: Page, { maxNodes = 400 }: { maxNodes?: number } = {}): Promise<string> {
  return (await scan(page, { maxNodes })) ?? '(no interactive elements found)';
}

/**
 * Find one element by the same accessible name/role {@link snapshotOutline}
 * shows (case-insensitive exact-or-contains match), or by a raw CSS
 * `selector`, and stamp it with ref `e1`. Returns `"e1"` or `null`. This is
 * how a flow targets elements across *fresh* sessions — snapshot refs are
 * ephemeral and can't be carried between sessions, but a name/selector
 * re-resolves anywhere.
 */
export async function locateRef(page: Page, target: { name?: string; role?: string; selector?: string }): Promise<string | null> {
  return scan(page, { locate: target });
}

/**
 * Resolve a snapshot ref ("e12" or 12) to a live element handle, or throw.
 * Walks the same roots the scan stamps: light DOM, open shadow roots, and
 * same-origin iframe documents — all read from the MAIN frame's context
 * (child-frame execution hangs under the isolated-world Runtime-leak patch, so
 * we never enter one; same-origin contentDocument doesn't need to).
 */
export async function resolveRef(page: Page, ref: string | number): Promise<ElementHandle<Element>> {
  const n = Number(String(ref).replace(/^e/, ''));
  const handle = await page.evaluateHandle((wanted: number) => {
    const sel = `[data-archonum-ref="${wanted}"]`;
    const find = (root: Document | ShadowRoot | Element): Element | null => {
      let hit: Element | null = null;
      try { hit = root.querySelector(sel); } catch { return null; }
      if (hit) return hit;
      let els: NodeListOf<Element>;
      try { els = root.querySelectorAll('*'); } catch { return null; }
      for (const el of els) {
        if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            const doc = (el as HTMLIFrameElement).contentDocument;
            if (doc) { const r = find(doc); if (r) return r; }
          } catch { /* cross-origin */ }
        }
      }
      return null;
    };
    return find(document);
  }, n);
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await handle.dispose().catch(() => {});
    throw new Error(`no element for ref e${n} — re-run snapshot (refs go stale after the DOM changes)`);
  }
  return el;
}
