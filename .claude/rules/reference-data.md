---
paths:
  - "reference_data/**/*"
---

# Reference data (Catalyst)

`breaking_boot/.claude/rules/reference-data.md` is the governing rule and
applies here too. This file records only what is specific to Catalyst.

- **Placement:** facts about Boot.dev go to `breaking_boot/reference_data/`;
  artefacts about Catalyst stay in `catalyst/reference_data/`. Five directories
  moved up on 2026-08-23 and have symlinks at their old paths — see
  `reference_data/README.md`. Write to the real paths, not through the symlinks,
  and do not delete the symlinks: tracked check scripts and the historical
  evidence indexes both resolve through them.
- Keep original captures where they are filed; do not move or delete them
  without agreement, since provenance is part of their value. Agreed moves are
  recorded — the 2026-08-23 migration is described in `reference_data/README.md`,
  and deliberate alterations to a capture go in
  `breaking_boot/reference_data/REDACTIONS.md`.
- The canonical endpoint spec is
  `breaking_boot/reference_data/bootdev_api_info/bootdev_openapi.yaml`. Update it
  only from observed HTTP requests, responses, or controlled verification.
- Do not document guessed parameters or inferred behavior as confirmed API
  contract.
- Distinguish confirmed facts, reasonable inferences, and unresolved behavior.
  Withdraw a claim explicitly when better evidence contradicts it, rather than
  silently editing it away.
- Preserve unrelated OpenAPI content and formatting.
- Validate YAML after editing and report the validation command and result.
- Never commit credentials, tokens, or answer data. Page captures carry the
  session token in `__NUXT_DATA__` and HARs carry it in WebSocket URLs — grep new
  captures for `eyJ` before filing them.
