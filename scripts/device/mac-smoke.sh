#!/usr/bin/env bash
# Mac real-device smoke test (device-regression.yml, self-hosted runner on the owner's Mac).
# Installs the DMG's app into ~/Applications/Regression (never over the copy in /Applications), launches it,
# checks it keeps running without a crash report, closes the window and checks the app leaves the Dock while
# staying in the menu bar. Writes one JSON line per case to $RESULTS. Usage: mac-smoke.sh <app.dmg>
set -uo pipefail
DMG="$1"; RESULTS="${RESULTS:-results.jsonl}"; DEST="$HOME/Applications/Regression"
failed=0
record() { printf '{"platform":"macos","case":"%s","ok":%s,"detail":"%s"}\n' "$1" "$2" "${3//\"/\'}" >> "$RESULTS"; [[ "$2" == true ]] || failed=1; echo "[$1] ok=$2 $3"; }

mount=$(hdiutil attach -nobrowse -readonly "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
app=$(find "$mount" -maxdepth 1 -name '*.app' | head -1)
if [[ -z "$app" ]]; then record install false "no .app in the DMG"; hdiutil detach "$mount" -quiet; exit 1; fi
mkdir -p "$DEST"; name=$(basename "$app"); rm -rf "${DEST:?}/$name"; cp -R "$app" "$DEST/"; hdiutil detach "$mount" -quiet
target="$DEST/$name"; bundle=$(defaults read "$target/Contents/Info" CFBundleIdentifier); process=$(defaults read "$target/Contents/Info" CFBundleExecutable)
if spctl --assess --type execute "$target" 2>/dev/null; then record gatekeeper true "notarized"; else record gatekeeper false "Gatekeeper rejects the app"; fi

pkill -x "$process" 2>/dev/null; sleep 1
started=$(date +%s)
open "$target"; sleep 15
if pgrep -x "$process" >/dev/null; then record launch true "running"; else record launch false "not running 15 s after launch"; fi
crash=$(find "$HOME/Library/Logs/DiagnosticReports" -newermt "@$started" -name "${process}*" 2>/dev/null | head -1)
if [[ -z "$crash" ]]; then record no-crash true "no crash report"; else record no-crash false "crash report $(basename "$crash")"; fi

# Close the main window (⌘W): the app should leave the Dock (accessory) and stay in the menu bar.
osascript -e "tell application id \"$bundle\" to activate" -e 'delay 1' -e 'tell application "System Events" to keystroke "w" using command down' >/dev/null 2>&1
sleep 3
kind=$(lsappinfo info -only ApplicationType "$(lsappinfo find bundleid="$bundle" | head -1)" 2>/dev/null | sed 's/.*="\(.*\)"/\1/')
alive=$(pgrep -x "$process" >/dev/null && echo yes || echo no)
if [[ "$alive" == yes && "$kind" == "UIElement" ]]; then record dock-hide true "menu bar only"
else record dock-hide false "after closing the window: running=$alive type=${kind:-unknown}"; fi
pkill -x "$process" 2>/dev/null
exit $failed
