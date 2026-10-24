#!/usr/bin/env bash
# Builds clients/apple/.deps/TunnelCore.xcframework (iOS, iOS Simulator, macOS): mihomo for the
# packet tunnel extensions through gomobile bind. Needs Go (version from go.mod) and full Xcode.
set -euo pipefail
cd "$(dirname "$0")"
output=../apple/.deps/TunnelCore.xcframework
# Rebuilt only when the core changed: scripts/build.sh runs this before every build.
stamp=$(cat go.mod go.sum core.go build-apple.sh | shasum -a 256 | cut -c1-16)
if [[ -f "$output/.stamp" && "$(cat "$output/.stamp")" == "$stamp" ]]; then exit 0; fi
source ./gomobile.sh
rm -rf "$output"; mkdir -p ../apple/.deps
gomobile bind -target=ios,iossimulator,macos -iosversion 16.0 -macosversion 13.0 \
  -tags with_gvisor -trimpath -ldflags "-s -w -buildid=" -o "$output" .
echo "$stamp" > "$output/.stamp"
