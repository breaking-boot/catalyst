#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage:
  ./scripts/new-catalyst-version v<major.minor.patch>
  ./scripts/new-catalyst-version v<major.minor.patch> <short_feature_name>

Examples:
  ./scripts/new-catalyst-version v0.11.0
  ./scripts/new-catalyst-version v0.11.0 boss_event_history
  ./scripts/new-catalyst-version v0.11.0 "boss event history"
EOF
}

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

[[ $# -ge 1 ]] || {
    usage >&2
    exit 2
}

version="$1"
shift

[[ "$version" == v* ]] || version="v$version"

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "version must use vMAJOR.MINOR.PATCH format (for example, v0.11.0)"
fi

feature_input="$*"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
template_dir="$repo_root/reference_data/catalyst_versions/_template"

[[ -d "$template_dir" ]] || \
    die "template directory not found: $template_dir"

command -v python3 >/dev/null 2>&1 || \
    die "python3 is required to normalize names and update template files"

export CATALYST_VERSION="$version"
export CATALYST_FEATURE_INPUT="$feature_input"

mapfile -t generated < <(
python3 <<'PY'
from __future__ import annotations

import os
import re

version = os.environ["CATALYST_VERSION"]
raw = os.environ["CATALYST_FEATURE_INPUT"].strip()

if raw:
    slug = re.sub(r"[^a-z0-9]+", "_", raw.lower()).strip("_")
    if not slug:
        raise SystemExit("feature name must contain at least one letter or number")
    display_name = re.sub(r"[_-]+", " ", raw).strip()
    directory_name = f"{version}_{slug}"
    feature_name = display_name
    feature_slug = slug
    branch_name = f"feat/{slug.replace('_', '-')}"
else:
    directory_name = version
    feature_name = "PLEASE_COMPLETE_FEATURE_NAME"
    feature_slug = "PLEASE_COMPLETE_FEATURE_SLUG"
    branch_name = "feat/PLEASE_COMPLETE_BRANCH_NAME"

print(directory_name)
print(feature_name)
print(feature_slug)
print(branch_name)
PY
)

directory_name="${generated[0]}"
feature_name="${generated[1]}"
feature_slug="${generated[2]}"
branch_name="${generated[3]}"

destination="$repo_root/reference_data/catalyst_versions/$directory_name"
relative_destination="reference_data/catalyst_versions/$directory_name"
plan_path="$relative_destination/implementation_plan.md"

[[ ! -e "$destination" ]] || \
    die "destination already exists: $destination"

cp -R "$template_dir" "$destination"

export CATALYST_DESTINATION="$destination"
export CATALYST_DIRECTORY_NAME="$directory_name"
export CATALYST_FEATURE_NAME="$feature_name"
export CATALYST_FEATURE_SLUG="$feature_slug"
export CATALYST_BRANCH_NAME="$branch_name"
export CATALYST_RELATIVE_DESTINATION="$relative_destination"
export CATALYST_PLAN_PATH="$plan_path"

python3 <<'PY'
from __future__ import annotations

import os
from pathlib import Path

root = Path(os.environ["CATALYST_DESTINATION"])
replacements = {
    "{{VERSION}}": os.environ["CATALYST_VERSION"],
    "{{DIRECTORY_NAME}}": os.environ["CATALYST_DIRECTORY_NAME"],
    "{{FEATURE_NAME}}": os.environ["CATALYST_FEATURE_NAME"],
    "{{FEATURE_SLUG}}": os.environ["CATALYST_FEATURE_SLUG"],
    "{{BRANCH_NAME}}": os.environ["CATALYST_BRANCH_NAME"],
    "{{RELEASE_DIR}}": os.environ["CATALYST_RELATIVE_DESTINATION"],
    "{{PLAN_PATH}}": os.environ["CATALYST_PLAN_PATH"],
}

for path in root.rglob("*"):
    if not path.is_file():
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue

    updated = text
    for token, value in replacements.items():
        updated = updated.replace(token, value)

    if updated != text:
        path.write_text(updated, encoding="utf-8")
PY

printf 'Created: %s\n\n' "$relative_destination"
printf 'Next steps:\n'
printf '  1. Complete: %s/feature_brief.md\n' "$relative_destination"
printf '  2. Find required markers:\n'
printf "     grep -n 'PLEASE_COMPLETE_REQUIRED' '%s/feature_brief.md'\n" \
    "$relative_destination"
printf '  3. Add captures and update evidence_index.md as needed.\n'
printf '  4. Run in Claude Code: /plan-catalyst-feature %s\n' "$version"
