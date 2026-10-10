---
"@archonum/engine": patch
---

Desktop mode no longer fails on older Android WebViews: the client-hint metadata carries the deprecated `fullVersion` their CDP still requires, and a browser that rejects the metadata anyway gets the desktop user agent without it instead of a failed session.
