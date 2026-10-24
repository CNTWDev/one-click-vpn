#!/usr/bin/env bash
# Builds clients/android/app/libs/veilbird-core.aar: mihomo for Android through gomobile bind.
# Needs Go (version from go.mod), the Android SDK and NDK (ANDROID_HOME, ANDROID_NDK_HOME).
set -euo pipefail
cd "$(dirname "$0")"
source ./gomobile.sh
mkdir -p ../android/app/libs
# with_gvisor: userspace TCP/IP stack for the tun; cmfa: Android app mode (no netlink, no package manager).
gomobile bind -target=android/arm64,android/arm -androidapi 26 -javapkg com.veilbird \
  -tags with_gvisor,cmfa -trimpath -ldflags "-s -w -buildid=" -o ../android/app/libs/veilbird-core.aar .
