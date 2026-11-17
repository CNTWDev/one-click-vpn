#!/usr/bin/env bash
# Builds clients/apple/.deps/TunnelCore.xcframework (iOS, iOS Simulator, macOS): mihomo for the
# packet tunnel extensions through gomobile bind. Needs Go (version from go.mod) and full Xcode.
set -euo pipefail
cd "$(dirname "$0")"
output=../apple/.deps/TunnelCore.xcframework
# Platforms: all three by default; the Mac release passes VEILBIRD_CORE_TARGETS=macos (it needs no iPhone slices,
# which take most of the compile time).
targets=${VEILBIRD_CORE_TARGETS:-ios,iossimulator,macos}
# Rebuilt only when the core or the platforms changed: scripts/build.sh runs this before every build.
stamp=$( { echo "$targets"; cat go.mod go.sum build-apple.sh; find . -name '*.go' ! -name '*_test.go' | LC_ALL=C sort | xargs cat; } \
  | shasum -a 256 | cut -c1-16)
if [[ -f "$output/.stamp" && "$(cat "$output/.stamp")" == "$stamp" ]]; then exit 0; fi
source ./gomobile.sh
rm -rf "$output"; mkdir -p ../apple/.deps
gomobile bind -target="$targets" -iosversion 16.0 -macosversion 13.0 \
  -tags with_gvisor -trimpath -ldflags "-s -w -buildid=" -o "$output" .
echo "$stamp" > "$output/.stamp"
