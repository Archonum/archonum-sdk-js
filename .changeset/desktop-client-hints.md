---
"@archonum/engine": patch
---

Desktop mode keeps its client hints: when the page the engine reads them from has no `navigator.userAgentData` (it only exists on secure pages, and the reused tab is often `about:blank`), they are derived from the user agent instead of left out. Before, Chrome then reported empty brands and sent no `Sec-CH-UA` at all, a tell no real Chrome has.
