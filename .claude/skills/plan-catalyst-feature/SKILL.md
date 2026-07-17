---
name: plan-catalyst-feature
description: Produce an evidence-based implementation plan for a Catalyst release.
argument-hint: "v<version>"
disable-model-invocation: true
---

Plan the Catalyst release identified by `$ARGUMENTS`. Do not implement the
feature.

## Resolve the release directory

1. Treat the first whitespace-delimited value in `$ARGUMENTS` as the version.
   Normalize `0.11.0` to `v0.11.0`; otherwise require `vMAJOR.MINOR.PATCH`.
2. Search `reference_data/catalyst_versions/` for the release directory:
   - prefer an exact directory named `<version>`;
   - otherwise match `<version>_*` or `<version>-*`;
   - ignore `_template`.
3. Require exactly one match. If none exists, stop and tell the user to run:

   ```bash
   ./scripts/new-catalyst-version <version> [short_feature_name]
   ```

   If multiple directories match, list them and stop rather than guessing.
4. Set the resolved directory as `RELEASE_DIR`.

## Validate the brief

1. Read `RELEASE_DIR/feature_brief.md` first.
2. Search that file for `PLEASE_COMPLETE_REQUIRED`.
3. If required markers remain and the missing information blocks a sound plan,
   ask only the minimum necessary questions. Do not treat placeholder text as
   requirements or evidence.
4. Read `RELEASE_DIR/evidence_index.md`,
   `RELEASE_DIR/open_questions.md`, and
   `RELEASE_DIR/interaction_notes.md` when present.
5. Inspect only the raw captures relevant to the plan. Use the evidence index
   before opening large JSON, HTML, screenshots, logs, or diagnostics.

## Plan the feature

1. Read the repository `CLAUDE.md`, relevant source files, `manifest.json`,
   `CHANGELOG.md`, and any other files needed to understand the current
   implementation.
2. Inspect the existing implementation before recommending architectural
   changes.
3. Separate confirmed facts, reasonable inferences, assumptions, and unresolved
   questions.
4. Verify load-bearing assumptions from code or captured evidence. Do not guess
   about API behavior, DOM lifecycle, state flow, or pagination when the answer
   affects correctness.
5. Recommend the smallest approach consistent with existing Catalyst patterns.
   Identify a fallback only when it addresses a credible failure mode.
6. Cover:
   - recommended architecture
   - affected files and responsibilities
   - state and data flow
   - initialization, SPA navigation, cleanup, and disabled behavior
   - edge cases and fail-open behavior
   - automated tests
   - manual verification
   - additional reference data needed
   - risks and compatibility concerns
   - OpenAPI/reference-data updates when applicable
   - CHANGELOG draft
   - concise branch and Conventional Commit suggestions
7. Avoid implementation code, unrelated refactors, speculative API
   documentation, unnecessary dependencies, generated-sounding commit
   messages, and all co-author or AI/tool attribution.
8. Use the plan path declared in `feature_brief.md`. If it is absent, save the
   plan as `RELEASE_DIR/implementation_plan.md`.
9. Finish with a concise summary of the recommended approach, unresolved
   blockers, and the next concrete step.
