import type { Page } from 'puppeteer-core';
import type { PageMarkdownResult } from './types.js';

/**
 * The serialized shape the in-page walk hands back to Node. Split this way on
 * purpose: the browser side only SERIALIZES the DOM into a JSON tree (small,
 * dumb, hard to get wrong inside evaluate), and all markdown formatting lives
 * in {@link renderMarkdown} — a pure function we can unit-test without a
 * browser.
 */
export type MdInline =
  | string
  | { i: 'strong' | 'em' | 'code'; children: MdInline[] }
  | { i: 'a'; href: string; children: MdInline[] }
  | { i: 'img'; src: string; alt: string }
  | { i: 'br' };

export type MdBlock =
  | { b: 'heading'; level: number; children: MdInline[] }
  | { b: 'paragraph'; children: MdInline[] }
  | { b: 'list'; ordered: boolean; items: MdBlock[][] }
  | { b: 'blockquote'; children: MdBlock[] }
  | { b: 'pre'; text: string; lang?: string }
  | { b: 'table'; rows: MdInline[][][] }
  | { b: 'hr' };

/**
 * Serialize the page's CONTENT into an {@link MdBlock} tree, in-page. Chrome
 * (navigation, boilerplate) is dropped: nav/header/footer/aside, scripts,
 * hidden elements, and consent/dialog overlays. When an `<article>`/`<main>`
 * region exists and holds a meaningful share of the page's text, the walk
 * starts there instead of `<body>` — the cheap version of readability, which
 * is all a rendered-and-settled page needs.
 *
 * Like dom-scan's walker, this must stay ONE self-contained function — code
 * inside `page.evaluate` cannot reach module scope.
 */
export async function serializePageContent(page: Page): Promise<MdBlock[]> {
  return page.evaluate((): MdBlock[] => {
    // Inline copies of the module types — evaluate code can't import them.
    type Inline =
      | string
      | { i: 'strong' | 'em' | 'code'; children: Inline[] }
      | { i: 'a'; href: string; children: Inline[] }
      | { i: 'img'; src: string; alt: string }
      | { i: 'br' };
    type Block =
      | { b: 'heading'; level: number; children: Inline[] }
      | { b: 'paragraph'; children: Inline[] }
      | { b: 'list'; ordered: boolean; items: Block[][] }
      | { b: 'blockquote'; children: Block[] }
      | { b: 'pre'; text: string; lang?: string }
      | { b: 'table'; rows: Inline[][][] }
      | { b: 'hr' };

    const SKIP = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'FRAME',
      'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'DIALOG', 'BUTTON', 'SELECT',
      'INPUT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED',
    ]);

    const hidden = (el: Element): boolean => {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      const s = window.getComputedStyle(el);
      return s.display === 'none' || s.visibility === 'hidden';
    };

    const walkInline = (node: Node, out: Inline[]): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.nodeValue || '').replace(/\s+/g, ' ');
        if (text) out.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      const tag = el.tagName;
      if (SKIP.has(tag) || hidden(el)) return;
      if (tag === 'BR') {
        out.push({ i: 'br' });
        return;
      }
      if (tag === 'IMG') {
        // .src (the property) is already resolved to an absolute URL.
        const src = (el as HTMLImageElement).src || '';
        if (src && !src.startsWith('data:')) out.push({ i: 'img', src, alt: el.getAttribute('alt') || '' });
        return;
      }
      if (tag === 'A') {
        const href = (el as HTMLAnchorElement).href || ''; // absolute, like .src
        const children: Inline[] = [];
        for (const child of el.childNodes) walkInline(child, children);
        if (!children.length) return;
        if (!href || href.startsWith('javascript:')) out.push(...children);
        else out.push({ i: 'a', href, children });
        return;
      }
      if (tag === 'STRONG' || tag === 'B' || tag === 'EM' || tag === 'I' || tag === 'CODE') {
        const kind = tag === 'STRONG' || tag === 'B' ? 'strong' : tag === 'CODE' ? 'code' : 'em';
        const children: Inline[] = [];
        for (const child of el.childNodes) walkInline(child, children);
        if (children.length) out.push({ i: kind, children });
        return;
      }
      for (const child of el.childNodes) walkInline(child, out);
    };

    const inlineOf = (el: Element): Inline[] => {
      const out: Inline[] = [];
      for (const child of el.childNodes) walkInline(child, out);
      return out;
    };

    // True when the serialized inline run contains any real text or an image —
    // a run of pure whitespace strings renders to nothing and is dropped.
    const hasContent = (children: Inline[]): boolean =>
      children.some((c) => (typeof c === 'string' ? c.trim().length > 0 : c.i === 'img' || c.i === 'br' ? c.i === 'img' : hasContent(c.children)));

    const BLOCKY = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE',
      'TABLE', 'HR', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'FIGURE', 'FIGCAPTION',
      'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'ADDRESS', 'DL', 'DT', 'DD', 'LI',
    ]);

    const walkBlocks = (root: Element, out: Block[]): void => {
      let run: Inline[] = [];
      const flush = (): void => {
        if (hasContent(run)) out.push({ b: 'paragraph', children: run });
        run = [];
      };
      for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !BLOCKY.has((node as Element).tagName))) {
          walkInline(node, run);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        const tag = el.tagName;
        if (SKIP.has(tag) || hidden(el)) continue;
        flush();
        if (/^H[1-6]$/.test(tag)) {
          const children = inlineOf(el);
          if (hasContent(children)) out.push({ b: 'heading', level: Number(tag[1]), children });
        } else if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'SUMMARY' || tag === 'ADDRESS' || tag === 'DT' || tag === 'DD') {
          const children = inlineOf(el);
          if (hasContent(children)) out.push({ b: 'paragraph', children });
        } else if (tag === 'UL' || tag === 'OL') {
          const items: Block[][] = [];
          for (const li of el.children) {
            if (li.tagName !== 'LI' || hidden(li)) continue;
            const item: Block[] = [];
            walkBlocks(li, item);
            if (item.length) items.push(item);
          }
          if (items.length) out.push({ b: 'list', ordered: tag === 'OL', items });
        } else if (tag === 'PRE') {
          const text = (el.textContent || '').replace(/\n+$/, '');
          if (text.trim()) {
            const code = el.querySelector('code');
            const lang = code && [...code.classList].map((c) => /^(?:language|lang)-(.+)$/.exec(c)?.[1]).find(Boolean);
            out.push(lang ? { b: 'pre', text, lang } : { b: 'pre', text });
          }
        } else if (tag === 'BLOCKQUOTE') {
          const children: Block[] = [];
          walkBlocks(el, children);
          if (children.length) out.push({ b: 'blockquote', children });
        } else if (tag === 'TABLE') {
          const rows: Inline[][][] = [];
          for (const tr of el.querySelectorAll('tr')) {
            if (hidden(tr)) continue;
            const cells: Inline[][] = [];
            for (const cell of tr.children) {
              if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
              cells.push(inlineOf(cell));
            }
            if (cells.length) rows.push(cells);
          }
          if (rows.length) out.push({ b: 'table', rows });
        } else if (tag === 'HR') {
          out.push({ b: 'hr' });
        } else {
          // DIV/SECTION/etc — a transparent container: recurse into it.
          walkBlocks(el, out);
        }
      }
      flush();
    };

    // Cheap readability: start at <article>/<main> when it carries the bulk of
    // the page's text; otherwise take the whole body.
    const bodyLen = (document.body?.innerText || '').trim().length;
    let root: Element = document.body || document.documentElement;
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && !hidden(el) && (el.innerText || '').trim().length >= bodyLen * 0.4) {
        root = el;
        break;
      }
    }
    const blocks: Block[] = [];
    walkBlocks(root, blocks);
    return blocks;
  });
}

const escapeText = (text: string): string => text.replace(/([\\`*_[\]])/g, '\\$1');

function renderInline(children: MdInline[], { escape = true }: { escape?: boolean } = {}): string {
  let out = '';
  for (const child of children) {
    if (typeof child === 'string') {
      out += escape ? escapeText(child) : child;
    } else if (child.i === 'br') {
      out += '\n';
    } else if (child.i === 'img') {
      out += `![${child.alt.replace(/[[\]]/g, '')}](${child.src})`;
    } else if (child.i === 'a') {
      const label = renderInline(child.children).trim();
      out += label ? `[${label}](${child.href})` : '';
    } else if (child.i === 'code') {
      out += `\`${renderInline(child.children, { escape: false })}\``;
    } else {
      const mark = child.i === 'strong' ? '**' : '*';
      const inner = renderInline(child.children).trim();
      out += inner ? `${mark}${inner}${mark}` : '';
    }
  }
  // Inline runs come from a whitespace-normalized DOM walk; collapse any
  // doubled spaces produced by dropped nodes at the seams.
  return out.replace(/ {2,}/g, ' ');
}

/** One table cell: inline content flattened to a single pipe-safe line. */
const renderCell = (cell: MdInline[]): string => renderInline(cell).trim().replace(/\n/g, ' ').replace(/\|/g, '\\|');

/**
 * Render an {@link MdBlock} tree to markdown. Pure — all the browser work
 * happened in {@link serializePageContent}.
 */
export function renderMarkdown(blocks: MdBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.b === 'heading') {
      const text = renderInline(block.children).trim().replace(/\n/g, ' ');
      if (text) out.push(`${'#'.repeat(block.level)} ${text}`);
    } else if (block.b === 'paragraph') {
      const text = renderInline(block.children).trim();
      if (text) out.push(text);
    } else if (block.b === 'pre') {
      out.push(`\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\``);
    } else if (block.b === 'hr') {
      out.push('---');
    } else if (block.b === 'blockquote') {
      const inner = renderMarkdown(block.children);
      if (inner) out.push(inner.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
    } else if (block.b === 'list') {
      const lines: string[] = [];
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}. ` : '- ';
        const body = renderMarkdown(item);
        if (!body) return;
        const [first, ...rest] = body.split('\n');
        lines.push(marker + first, ...rest.map((line) => (line ? ' '.repeat(marker.length) + line : line)));
      });
      if (lines.length) out.push(lines.join('\n'));
    } else {
      const rows = block.rows.map((row) => `| ${row.map(renderCell).join(' | ')} |`);
      if (rows.length) {
        const cols = block.rows[0].length;
        rows.splice(1, 0, `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
        out.push(rows.join('\n'));
      }
    }
  }
  return out.join('\n\n').trim();
}

/**
 * The current page's content as LLM-optimized markdown: headings, links,
 * lists, tables and code fences survive; navigation chrome, scripts and
 * hidden elements don't. The structured counterpart to `pageText` — same
 * capping contract (`maxChars`, `truncated`, full pre-cap length).
 */
export async function pageMarkdown(page: Page, { maxChars = 8000 }: { maxChars?: number } = {}): Promise<PageMarkdownResult> {
  const full = renderMarkdown(await serializePageContent(page));
  return { markdown: full.slice(0, maxChars), truncated: full.length > maxChars, markdownLength: full.length };
}
