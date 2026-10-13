---
"@archonum/sdk": minor
"@archonum/cli": patch
---

`ARCHONUM_API_TOKEN` is now the one documented credential: the API token alone identifies the account, so `ArchonumClient` only requires `token` and no longer needs a username. A token-only client authenticates to the CDP gateway with a `token` query parameter. Earlier variable names (`ARCHONUM_TOKEN`, `ARCHONUM_PASSWORD`, `ARCHONUM_USERNAME`, `ARCHONUM_CDP_*`) and the `password`/`username` options keep working for existing setups but are no longer documented; when a username is set the legacy `username`/`password` pair is still sent. The constructor error is now `token is required (ARCHONUM_API_TOKEN)`, and the CLI asks for `ARCHONUM_API_TOKEN` when unset.
