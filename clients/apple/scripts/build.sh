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
xcodebuild -project Veilbird.xcodeproj -scheme "$scheme" -destination "$destination" -derivedDataPath "artifacts/$scheme" "CODE_SIGNING_ALLOWED=$signing" CODE_SIGN_IDENTITY=- build
if [[ "$1" == macos ]]; then
  # macOS loads the tunnel only from Contents/Library/SystemExtensions/<bundle id>.systemextension.
  ls -d "artifacts/$scheme/Build/Products/Debug/Veilbird.app/Contents/Library/SystemExtensions/"*.macos.tunnel.systemextension >/dev/null \
    || { echo 'The tunnel system extension is not embedded in Veilbird.app.' >&2; exit 1; }
fi
echo 'Development only (simulator ad-hoc signature / unsigned Mac). A developer team, production signing and physical-device VPN tests are required before distribution.'
