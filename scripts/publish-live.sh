#!/usr/bin/env bash
# Upload public/live (+ Traffy last-good cache) as release asset live/live.tar.gz, then ask Vercel to rebuild.
set -euo pipefail
COPYFILE_DISABLE=1 tar czf live.tar.gz public/live $( [ -d data/evidence ] && echo data/evidence )
gh release view live >/dev/null 2>&1 || gh release create live --prerelease --title "Live data (auto-updated)" --notes "Latest evidence and model output, replaced by GitHub Actions every run. Used by the Vercel build."
gh release upload live live.tar.gz --clobber
if [ -n "${VERCEL_DEPLOY_HOOK:-}" ]; then curl -fsS -X POST "$VERCEL_DEPLOY_HOOK" >/dev/null && echo "Vercel rebuild requested"; else echo "VERCEL_DEPLOY_HOOK not set; skipped deploy"; fi
