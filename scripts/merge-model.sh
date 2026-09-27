#!/usr/bin/env bash
# Merge a freshly computed model output (dir with <runId>/ folders + latest.json) into public/live/model of the
# latest published live data, keeping the newest KEEP_RUNS run folders. Lets the long model computation run
# outside the live-data lock: only this merge + publish holds it, so evidence updates are never overwritten.
#   scripts/merge-model.sh <new-model-dir>
set -euo pipefail
src="$1"; dst=public/live/model; keep="${KEEP_RUNS:-2}"
mkdir -p "$dst"
for d in "$src"/*/; do n=$(basename "$d"); [ -d "$dst/$n" ] || cp -R "$d" "$dst/$n"; done
# latest.json only moves forward (a slower run must not replace a newer one published meanwhile)
new=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$src/latest.json')).runId||'')")
cur=$( [ -f "$dst/latest.json" ] && node -e "console.log(JSON.parse(require('fs').readFileSync('$dst/latest.json')).runId||'')" || echo "")
if [[ "$new" > "$cur" ]]; then cp "$src/latest.json" "$dst/latest.json"; echo "latest -> $new"; else echo "kept newer $cur"; fi
dirs=$(ls -1d "$dst"/*/ | sort); n=$(echo "$dirs" | grep -c . || true)
echo "$dirs" | awk -v n="$n" -v k="$keep" 'NR<=n-k' | while read -r d; do rm -rf "$d"; done
ls -1 "$dst"
