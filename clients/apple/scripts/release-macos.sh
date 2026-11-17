#!/usr/bin/env bash
# Signed and notarized TrackNothing-<version>-<build>-macos.dmg for direct download (Developer ID, outside the
# Mac App Store). Runs on a Mac with full Xcode and XcodeGen; CI runs it in .github/workflows/client-release.yml.
#
# Needs: VEILBIRD_APPLE_TEAM_ID, VEILBIRD_APPLE_BUNDLE_ID (registered prefix, e.g. com.veilbird.client),
#   the "Developer ID Application" identity in a keychain, Developer ID provisioning profiles for
#   <prefix>.macos and <prefix>.macos.tunnel named in VEILBIRD_MACOS_APP_PROFILE / VEILBIRD_MACOS_TUNNEL_PROFILE
#   (scripts/apple-profiles.mjs installs them), and an App Store Connect API key for notarization:
#   VEILBIRD_APPLE_API_KEY_PATH (.p8 file), VEILBIRD_APPLE_API_KEY_ID, VEILBIRD_APPLE_API_ISSUER_ID.
# Optional: VEILBIRD_API_ORIGIN (baked into the app), VEILBIRD_VERSION and VEILBIRD_BUILD_NUMBER.
#
# Usage: release-macos.sh [build|notarize|all]   (default all). CI runs build, keeps the signed DMG as a run
# artifact, then runs notarize, so a slow Apple check never costs the build.
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:-all}
case $mode in
  build) required="VEILBIRD_APPLE_TEAM_ID VEILBIRD_APPLE_BUNDLE_ID VEILBIRD_MACOS_APP_PROFILE VEILBIRD_MACOS_TUNNEL_PROFILE" ;;
  notarize) required="VEILBIRD_APPLE_API_KEY_PATH VEILBIRD_APPLE_API_KEY_ID VEILBIRD_APPLE_API_ISSUER_ID" ;;
  all) required="VEILBIRD_APPLE_TEAM_ID VEILBIRD_APPLE_BUNDLE_ID VEILBIRD_MACOS_APP_PROFILE VEILBIRD_MACOS_TUNNEL_PROFILE
                 VEILBIRD_APPLE_API_KEY_PATH VEILBIRD_APPLE_API_KEY_ID VEILBIRD_APPLE_API_ISSUER_ID" ;;
  *) echo "Usage: $0 [build|notarize|all]" >&2; exit 2 ;;
esac
for name in $required; do
  [[ -n "${!name:-}" ]] || { echo "$name is not set (see clients/RELEASING.md)" >&2; exit 1; }
done
version=${VEILBIRD_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../version.json)}
build=${VEILBIRD_BUILD_NUMBER:-1}
out=artifacts/release
dmg="$out/TrackNothing-$version-$build-macos.dmg"

build_dmg() {
  team=$VEILBIRD_APPLE_TEAM_ID bundle=$VEILBIRD_APPLE_BUNDLE_ID
  identity=$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .* ($team)\)\".*/\1/p" | head -1)
  [[ -n "$identity" ]] || { echo "No \"Developer ID Application\" certificate of team $team in the keychain." >&2; exit 1; }
  command -v xcodegen >/dev/null || { echo 'Install XcodeGen and full Xcode first.' >&2; exit 1; }

  rm -rf "$out"; mkdir -p "$out"
  # Only the Mac slices of the core: the iPhone ones are not in this app.
  VEILBIRD_CORE_TARGETS=macos bash ../core/build-apple.sh
  # XcodeGen writes the name of the embedded system extension (<bundle id>.systemextension) into the project when it
  # generates it, so the registered identifier must be in the spec itself: overriding VEILBIRD_BUNDLE_ID only on the
  # xcodebuild line builds com.example.macos.tunnel.systemextension but still copies the .dev one into the app.
  spec=project.release.yml
  trap 'rm -f "$spec"' EXIT
  sed "s/com\.veilbird\.client\.dev/$bundle/g" project.yml > "$spec"
  grep -q "VEILBIRD_BUNDLE_ID: $bundle\$" "$spec" || { echo "Could not set VEILBIRD_BUNDLE_ID in $spec" >&2; exit 1; }
  xcodegen generate --spec "$spec"
  xcodebuild archive -project Veilbird.xcodeproj -scheme Veilbird-macOS -configuration Release \
    -destination 'generic/platform=macOS' -archivePath "$out/TrackNothing.xcarchive" \
    VEILBIRD_BUNDLE_ID="$bundle" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$identity" \
    VEILBIRD_MACOS_APP_PROFILE="$VEILBIRD_MACOS_APP_PROFILE" VEILBIRD_MACOS_TUNNEL_PROFILE="$VEILBIRD_MACOS_TUNNEL_PROFILE" \
    MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" VEILBIRD_API_ORIGIN="${VEILBIRD_API_ORIGIN:-}" \
    OTHER_CODE_SIGN_FLAGS=--timestamp

  # The service address users never type: it must be in the app (Config/App-Info.plist).
  plist="$out/TrackNothing.xcarchive/Products/Applications/Veilbird.app/Contents/Info.plist"
  [[ "$(plutil -extract VeilbirdAPIOrigin raw -o - "$plist" 2>/dev/null)" == "${VEILBIRD_API_ORIGIN:-}" ]] \
    || { echo "VeilbirdAPIOrigin in $plist does not match VEILBIRD_API_ORIGIN" >&2; exit 1; }
  [[ -n "${VEILBIRD_API_ORIGIN:-}" ]] || echo 'warning: VEILBIRD_API_ORIGIN is not set; this build asks users for a server address.' >&2

  cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>$team</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
  <key>provisioningProfiles</key><dict>
    <key>$bundle.macos</key><string>$VEILBIRD_MACOS_APP_PROFILE</string>
    <key>$bundle.macos.tunnel</key><string>$VEILBIRD_MACOS_TUNNEL_PROFILE</string>
  </dict>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath "$out/TrackNothing.xcarchive" -exportPath "$out/export" -exportOptionsPlist "$out/export.plist"

  # The disk image: the app under its product name, beside a link to Applications (the extension loads only from there).
  stage="$out/dmg"; mkdir -p "$stage"
  ditto "$out/export/Veilbird.app" "$stage/TrackNothing.app"
  ls -d "$stage/TrackNothing.app/Contents/Library/SystemExtensions/$bundle.macos.tunnel.systemextension" >/dev/null
  codesign --verify --deep --strict "$stage/TrackNothing.app"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname TrackNothing -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
  codesign --sign "$identity" --timestamp "$dmg"
  echo "$dmg"
}

# Notarization: Apple's automated malware check (usually minutes, longer for a team's first submissions; not an
# App Review). The stapled ticket lets Gatekeeper accept the download offline.
notarize_dmg() {
  [[ -f "$dmg" ]] || { echo "$dmg not found: run \"$0 build\" first." >&2; exit 1; }
  local auth=(--key "$VEILBIRD_APPLE_API_KEY_PATH" --key-id "$VEILBIRD_APPLE_API_KEY_ID" --issuer "$VEILBIRD_APPLE_API_ISSUER_ID")
  local submission status
  # Apple's API sometimes drops a connection (SSL error -1200): ask a few times before giving up.
  notary_status() {
    local attempt value
    for attempt in 1 2 3 4 5; do
      value=$(xcrun notarytool info "$1" "${auth[@]}" --output-format json 2>/dev/null | plutil -extract status raw -o - - 2>/dev/null) \
        && { echo "$value"; return 0; }
      sleep 20
    done
    return 1
  }
  # VEILBIRD_NOTARY_RESUME=1: reuse the latest submission of this DMG (by file name) instead of submitting again.
  if [[ -n "${VEILBIRD_NOTARY_RESUME:-}" ]]; then
    # Every submission of this team and its state, newest first (earlier builds included).
    xcrun notarytool history "${auth[@]}" || true
    submission=$(xcrun notarytool history "${auth[@]}" --output-format json | node -e '
      const name = process.argv[1]; let input = "";
      process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
        const found = JSON.parse(input).history.filter((item) => item.name === name)
          .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate))[0];
        process.stdout.write(found ? found.id : "");
      });' "$(basename "$dmg")")
    [[ -n "$submission" ]] || { echo "No earlier notarization of $(basename "$dmg") found." >&2; exit 1; }
  else
    submission=$(xcrun notarytool submit "$dmg" "${auth[@]}" --output-format json | plutil -extract id raw -o - -)
  fi
  echo "Notarization submission: $submission"
  if ! xcrun notarytool wait "$submission" "${auth[@]}" --timeout 60m; then
    status=$(notary_status "$submission" || true)
    if [[ "$status" == "In Progress" || -z "$status" ]]; then
      echo "::warning::Apple has not finished notarization $submission after 60 min. The signed DMG is kept as this" \
        "run's artifact. Finish it later without rebuilding: Run workflow with 平台 = macOS notarize and build =" \
        "${VEILBIRD_BUILD_NUMBER:-<this run number>}." >&2
      exit 1
    fi
  fi
  status=$(notary_status "$submission") || { echo "Could not read the state of notarization $submission." >&2; exit 1; }
  if [[ "$status" != Accepted ]]; then
    xcrun notarytool log "$submission" "${auth[@]}" || true
    echo "Notarization $submission: $status (log above)." >&2; exit 1
  fi
  xcrun stapler staple "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose "$dmg"
  echo "$dmg"
}

case $mode in
  build) build_dmg ;;
  notarize) notarize_dmg ;;
  all) build_dmg; notarize_dmg ;;
esac
