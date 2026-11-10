#!/usr/bin/env bash
# Move an issue on the roadmap project to a Status column.
#   scripts/roadmap-status.sh <issue-number> "<Backlog|Ready|In progress|In review|Done>"
# Adds the issue to the project first if it is not on it yet. Needs `gh` with the `project` scope.
set -euo pipefail
issue="${1:?issue number}"; status="${2:?status}"
owner=miguelcorderocollar; number=8; repo=miguelcorderocollar/endless-ai-quiz

project_id=$(gh project view "$number" --owner "$owner" --format json -q .id)
field_id=$(gh project field-list "$number" --owner "$owner" --format json -q '.fields[]|select(.name=="Status")|.id')
option_id=$(gh project field-list "$number" --owner "$owner" --format json \
  -q ".fields[]|select(.name==\"Status\")|.options[]|select(.name==\"$status\")|.id")
if [ -z "$option_id" ]; then
  echo "Unknown status '$status'. Use: Backlog, Ready, In progress, In review, Done" >&2
  exit 1
fi
item_id=$(gh project item-add "$number" --owner "$owner" \
  --url "https://github.com/$repo/issues/$issue" --format json -q .id)
gh project item-edit --id "$item_id" --project-id "$project_id" \
  --field-id "$field_id" --single-select-option-id "$option_id" >/dev/null
echo "#$issue → $status"
