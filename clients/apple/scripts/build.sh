#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  ios) scheme=Northstar-iOS; destination='generic/platform=iOS Simulator'; signing=YES ;;
  macos) scheme=Northstar-macOS; destination='generic/platform=macOS'; signing=NO ;;
  *) echo 'Usage: bash scripts/build.sh ios|macos' >&2; exit 2 ;;
esac
command -v xcodegen >/dev/null || { echo 'Install XcodeGen and full Xcode first.' >&2; exit 1; }
bash scripts/prepare-wireguard.sh
xcodegen generate
xcodebuild -project Northstar.xcodeproj -scheme "$scheme" -destination "$destination" -derivedDataPath "artifacts/$scheme" "CODE_SIGNING_ALLOWED=$signing" CODE_SIGN_IDENTITY=- build
echo 'Development only (simulator ad-hoc signature / unsigned Mac). A developer team, production signing and physical-device VPN tests are required before distribution.'
