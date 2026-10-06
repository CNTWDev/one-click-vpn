#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=2fec12a6e1f6e3460b6ee483aa00ad29cddadab1
checkout=.dependencies/wireguard-apple
if [[ ! -d "$checkout/.git" ]]; then
  mkdir -p .dependencies
  git clone https://git.zx2c4.com/wireguard-apple "$checkout"
fi
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$revision" ]] || git -C "$checkout" checkout --detach "$revision"
# Upstream declares tools 5.3 but uses platform APIs introduced in 5.5.
if git -C "$checkout" apply --check ../../patches/swift-tools.patch 2>/dev/null; then
  git -C "$checkout" apply ../../patches/swift-tools.patch
else
  git -C "$checkout" apply --reverse --check ../../patches/swift-tools.patch
fi
