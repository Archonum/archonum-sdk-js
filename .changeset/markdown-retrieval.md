---
"@archonum/engine": minor
---

LLM-optimized markdown retrieval: `session.pageMarkdown(page)` and `engine.read(url, { format: 'markdown' })` return page content as markdown — headings, links, lists, tables and code fences survive; navigation chrome, scripts and hidden elements are dropped. `ReadResult` gains a `format` field echoing which format `text` is in (default remains `'text'`, unchanged behaviour).
