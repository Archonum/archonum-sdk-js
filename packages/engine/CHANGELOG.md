# @archonum/engine

## 1.1.0

### Minor Changes

- c0faaf7: LLM-optimized markdown retrieval: `session.pageMarkdown(page)` and `engine.read(url, { format: 'markdown' })` return page content as markdown — headings, links, lists, tables and code fences survive; navigation chrome, scripts and hidden elements are dropped. `ReadResult` gains a `format` field echoing which format `text` is in (default remains `'text'`, unchanged behaviour).

### Patch Changes

- 1eb4ec1: Desktop mode keeps its client hints: when the page the engine reads them from has no `navigator.userAgentData` (it only exists on secure pages, and the reused tab is often `about:blank`), they are derived from the user agent instead of left out. Before, Chrome then reported empty brands and sent no `Sec-CH-UA` at all, a tell no real Chrome has.
- 324dcff: Desktop mode no longer fails on older Android WebViews: the client-hint metadata carries the deprecated `fullVersion` their CDP still requires, and a browser that rejects the metadata anyway gets the desktop user agent without it instead of a failed session.
- Updated dependencies [4482758]
- Updated dependencies [b85299e]
  - @archonum/sdk@1.1.0

## 1.0.0

Released 2026-08-05. Backfilled by hand — 1.0.0 was published before this repo
started recording changesets; entries from 1.1.0 on are generated.

### Major Changes

- Initial release: stealth browser automation on the archonum gateway —
  retrying CDP handshake, sessions on real mobile devices with honest desktop
  emulation, ref-tagged accessibility snapshots, human-like input (click,
  type, select, press, scroll), bot-wall detection and stall diagnosis,
  viewport screenshots, replayable flows, and the one-shot helpers `capture`,
  `read`, and `compareFlow`.
