#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  ios) scheme=Veilbird-iOS; destination='generic/platform=iOS Simulator'; signing=YES ;;
  macos) scheme=Veilbird-macOS; destination='generic/platform=macOS'; signing=NO ;;
  *) echo 'Usage: bash scripts/build.sh ios|macos' >&2; exit 2 ;;
esac
command -v xcodegen >/dev/null || { echo 'Install XcodeGen and full Xcode first.' >&2; exit 1; }
bash ../core/build-apple.sh
xcodegen generate
xcodebuild -project Veilbird.xcodeproj -scheme "$scheme" -destination "$destination" -derivedDataPath "artifacts/$scheme" "CODE_SIGNING_ALLOWED=$signing" VEILBIRD_API_ORIGIN="${VEILBIRD_API_ORIGIN:-}" CODE_SIGN_IDENTITY=- build
if [[ "$1" == macos ]]; then
  # macOS loads the tunnel only from Contents/Library/SystemExtensions/<bundle id>.systemextension.
  ls -d "artifacts/$scheme/Build/Products/Debug/Veilbird.app/Contents/Library/SystemExtensions/"*.macos.tunnel.systemextension >/dev/null \
    || { echo 'The tunnel system extension is not embedded in Veilbird.app.' >&2; exit 1; }
fi
# The keys the app reads at run time (Config/App-Info.plist and the tunnels' info properties) must reach the bundle.
products=$(ls -d "artifacts/$scheme/Build/Products/"Debug*)
for plist in "$products"/Veilbird.app/Info.plist "$products"/Veilbird.app/Contents/Info.plist \
             "$products"/Veilbird.app/PlugIns/*.appex/Info.plist "$products"/Veilbird.app/Contents/Library/SystemExtensions/*/Contents/Info.plist; do
  [[ -f "$plist" ]] || continue
  [[ -n "$(plutil -extract VeilbirdAppGroup raw -o - "$plist" 2>/dev/null)" ]] || { echo "VeilbirdAppGroup missing from $plist" >&2; exit 1; }
  if [[ "$plist" == */Veilbird.app/Info.plist || "$plist" == */Veilbird.app/Contents/Info.plist ]]; then
    origin=$(plutil -extract VeilbirdAPIOrigin raw -o - "$plist" 2>/dev/null) || { echo "VeilbirdAPIOrigin missing from $plist" >&2; exit 1; }
    [[ "$origin" == "${VEILBIRD_API_ORIGIN:-}" ]] || { echo "VeilbirdAPIOrigin is '$origin', expected '${VEILBIRD_API_ORIGIN:-}'" >&2; exit 1; }
  fi
  echo "Checked $plist"
done
echo 'Development only (simulator ad-hoc signature / unsigned Mac). A developer team, production signing and physical-device VPN tests are required before distribution.'
