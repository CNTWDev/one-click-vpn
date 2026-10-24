#!/usr/bin/env bash
# Builds app/libs/veilbird-core.aar: mihomo for Android through gomobile bind.
# Needs Go (version from go.mod), the Android SDK and NDK (ANDROID_HOME, ANDROID_NDK_HOME).
set -euo pipefail
cd "$(dirname "$0")"
mobile=$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install "golang.org/x/mobile/cmd/gomobile@${mobile}" "golang.org/x/mobile/cmd/gobind@${mobile}"
export PATH="$(go env GOPATH)/bin:$PATH"
gomobile init
mkdir -p ../app/libs
# with_gvisor: userspace TCP/IP stack for the tun; cmfa: Android app mode (no netlink, no package manager).
gomobile bind -target=android/arm64,android/arm -androidapi 26 -javapkg com.veilbird \
  -tags with_gvisor,cmfa -trimpath -ldflags "-s -w -buildid=" -o ../app/libs/veilbird-core.aar .
