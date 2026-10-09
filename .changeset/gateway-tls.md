---
"@archonum/sdk": minor
---

Talk to the gateway over TLS by default: `/json/version` goes over `https://`, and the CDP URL it hands back is `wss://`, so the API token and the whole browser session stay encrypted. `tls: false` (or `ARCHONUM_GATEWAY_TLS=false`) keeps the old plaintext behaviour for a gateway without a certificate.
