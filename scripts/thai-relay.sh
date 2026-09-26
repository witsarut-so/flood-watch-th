#!/usr/bin/env bash
# Install / remove the Thai relay on macOS (launchd): runs `node jobs.mjs thai` at :20 and :50 every hour
# while the Mac is awake, ~10 min before the GitHub Actions evidence run picks the data up.
#   scripts/thai-relay.sh install | uninstall | status | run
set -euo pipefail
LABEL=com.floodwatch.thai-relay
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/floodwatch-thai-relay.log"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"; GH="$(command -v gh)"
case "${1:-status}" in
 install)
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>$LABEL</string>
 <key>ProgramArguments</key><array><string>$NODE</string><string>jobs.mjs</string><string>thai</string></array>
 <key>WorkingDirectory</key><string>$DIR</string>
 <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):$(dirname "$GH"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
 <key>StartCalendarInterval</key><array><dict><key>Minute</key><integer>20</integer></dict><dict><key>Minute</key><integer>50</integer></dict></array>
 <key>StandardOutPath</key><string>$LOG</string><key>StandardErrorPath</key><string>$LOG</string>
 <key>ProcessType</key><string>Background</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "installed: $PLIST (log: $LOG)";;
 uninstall) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed";;
 run) launchctl kickstart -k "gui/$(id -u)/$LABEL" && echo "started; see $LOG";;
 status) launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|runs" || echo "not installed"; tail -3 "$LOG" 2>/dev/null || true;;
 *) echo "usage: $0 install|uninstall|status|run"; exit 1;;
esac
