#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
bridge="$SRCROOT/.dependencies/wireguard-apple/Sources/WireGuardKitGo"
[[ -f "$bridge/Makefile" ]] || { echo 'WireGuard package not resolved' >&2; exit 1; }
# Upstream Make rules cannot parse a build directory containing spaces.
bridge_tmp=$(mktemp -d /private/tmp/northstar-bridge.XXXXXX)
trap 'rm -rf "$bridge_tmp"' EXIT
if [[ "$PLATFORM_NAME" == iphonesimulator ]]; then
  make -C "$bridge" GOOS_iphonesimulator=ios BUILDDIR="$bridge_tmp/build" DESTDIR="$bridge_tmp/out"
else
  make -C "$bridge" BUILDDIR="$bridge_tmp/build" DESTDIR="$bridge_tmp/out"
fi
mkdir -p "$CONFIGURATION_BUILD_DIR"
cp "$bridge_tmp/out/libwg-go.a" "$CONFIGURATION_BUILD_DIR/libwg-go.a"
