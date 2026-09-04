# @archonum/sdk

## 1.0.0

Released 2026-08-05. Backfilled by hand — 1.0.0 was published before this repo
started recording changesets; entries from 1.1.0 on are generated.

### Major Changes

- Initial release: authenticate against the archonum gateway from the
  `ARCHONUM_*` environment (or explicit options) and build the credentialed
  CDP URL, with connection-info retries, credit-balance and service-health
  queries, and `.env` loading. Zero runtime dependencies.
