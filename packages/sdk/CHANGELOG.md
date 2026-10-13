# @archonum/sdk

## 1.1.0

### Minor Changes

- 4482758: `ARCHONUM_API_TOKEN` is now the one documented credential: the API token alone identifies the account, so `ArchonumClient` only requires `token` and no longer needs a username. A token-only client authenticates to the CDP gateway with a `token` query parameter. Earlier variable names (`ARCHONUM_TOKEN`, `ARCHONUM_PASSWORD`, `ARCHONUM_USERNAME`, `ARCHONUM_CDP_*`) and the `password`/`username` options keep working for existing setups but are no longer documented; when a username is set the legacy `username`/`password` pair is still sent. The constructor error is now `token is required (ARCHONUM_API_TOKEN)`, and the CLI asks for `ARCHONUM_API_TOKEN` when unset.
- b85299e: Talk to the gateway over TLS: `/json/version` goes over `https://`, and the CDP URL it hands back is `wss://`, so the API token and the whole browser session stay encrypted.

## 1.0.0

Released 2026-08-05. Backfilled by hand — 1.0.0 was published before this repo
started recording changesets; entries from 1.1.0 on are generated.

### Major Changes

- Initial release: authenticate against the archonum gateway from the
  `ARCHONUM_*` environment (or explicit options) and build the credentialed
  CDP URL, with connection-info retries, credit-balance and service-health
  queries, and `.env` loading. Zero runtime dependencies.
