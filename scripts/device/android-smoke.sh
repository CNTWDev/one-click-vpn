#!/usr/bin/env bash
# Android real-device smoke test (device-regression.yml, self-hosted Mac runner with a phone on USB).
# Installs the build twice over the one already on the phone (the in-app update path is the same `install -r`),
# cold-starts it three times and fails on any crash or ANR of the app's process. Writes one JSON line per case
# to $RESULTS (default results.jsonl). Usage: android-smoke.sh <new.apk> [<previous.apk>]
set -uo pipefail
APK="$1"; PREVIOUS="${2:-}"; RESULTS="${RESULTS:-results.jsonl}"; PACKAGE=com.veilbird.client
failed=0
record() { printf '{"platform":"android","case":"%s","ok":%s,"detail":"%s"}\n' "$1" "$2" "${3//\"/\'}" >> "$RESULTS"; [[ "$2" == true ]] || failed=1; echo "[$1] ok=$2 $3"; }

adb wait-for-device
serial=$(adb get-serialno); model=$(adb shell getprop ro.product.model | tr -d '\r'); sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
echo "Device $serial · $model · SDK $sdk"
adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard 2>/dev/null || true

if [[ -n "$PREVIOUS" ]]; then
  adb uninstall "$PACKAGE" >/dev/null 2>&1 || true
  if adb install "$PREVIOUS" >/dev/null; then record install-previous true "previous build installed"; else record install-previous false "previous build did not install"; fi
fi
before=$(adb shell dumpsys package "$PACKAGE" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
if out=$(adb install -r "$APK" 2>&1); then
  after=$(adb shell dumpsys package "$PACKAGE" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
  record update true "versionCode ${before:-none} -> $after"
else record update false "install -r failed: $(echo "$out" | tail -1)"; fi

for round in 1 2 3; do
  adb logcat -c
  adb shell am force-stop "$PACKAGE"
  adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 12
  pid=$(adb shell pidof "$PACKAGE" | tr -d '\r')
  crash=$(adb logcat -d -b crash 2>/dev/null | grep -A3 "Process: $PACKAGE" | head -4 | tr '\n' ' ')
  anr=$(adb logcat -d | grep -m1 "ANR in $PACKAGE" || true)
  if [[ -n "$pid" && -z "$crash" && -z "$anr" ]]; then record "cold-start-$round" true "pid $pid"
  else record "cold-start-$round" false "${crash:-${anr:-process not running}}"; fi
done
adb shell am force-stop "$PACKAGE"
exit $failed
