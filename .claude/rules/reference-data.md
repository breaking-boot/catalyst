---
paths:
  - "reference_data/**/*"
---

# Reference data

- Keep original captures in their version-specific canonical directory; do not move or delete them.
- Organize additional access through relative Markdown links or indexes when practical. Copy files only when that is more reliable.
- Update `reference_data/bootdev_api_info/bootdev_openapi.yaml` only from observed HTTP requests, responses, or controlled verification.
- Do not document guessed parameters or inferred behavior as confirmed API contract.
- Distinguish confirmed facts, reasonable inferences, and unresolved behavior.
- Preserve unrelated OpenAPI content and formatting.
- Validate YAML after editing and report the validation command and result.