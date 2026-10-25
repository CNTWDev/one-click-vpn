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
set -euo pipefail
cd "$(dirname "$0")/.."
for name in VEILBIRD_APPLE_TEAM_ID VEILBIRD_APPLE_BUNDLE_ID VEILBIRD_MACOS_APP_PROFILE VEILBIRD_MACOS_TUNNEL_PROFILE \
            VEILBIRD_APPLE_API_KEY_PATH VEILBIRD_APPLE_API_KEY_ID VEILBIRD_APPLE_API_ISSUER_ID; do
  [[ -n "${!name:-}" ]] || { echo "$name is not set (see clients/RELEASING.md)" >&2; exit 1; }
done
team=$VEILBIRD_APPLE_TEAM_ID bundle=$VEILBIRD_APPLE_BUNDLE_ID
version=${VEILBIRD_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../version.json)}
build=${VEILBIRD_BUILD_NUMBER:-1}
identity=$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .* ($team)\)\".*/\1/p" | head -1)
[[ -n "$identity" ]] || { echo "No \"Developer ID Application\" certificate of team $team in the keychain." >&2; exit 1; }
command -v xcodegen >/dev/null || { echo 'Install XcodeGen and full Xcode first.' >&2; exit 1; }

out=artifacts/release
rm -rf "$out"; mkdir -p "$out"
bash ../core/build-apple.sh
xcodegen generate
xcodebuild archive -project Veilbird.xcodeproj -scheme Veilbird-macOS -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$out/TrackNothing.xcarchive" \
  VEILBIRD_BUNDLE_ID="$bundle" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$identity" \
  VEILBIRD_MACOS_APP_PROFILE="$VEILBIRD_MACOS_APP_PROFILE" VEILBIRD_MACOS_TUNNEL_PROFILE="$VEILBIRD_MACOS_TUNNEL_PROFILE" \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" VEILBIRD_API_ORIGIN="${VEILBIRD_API_ORIGIN:-}" \
  OTHER_CODE_SIGN_FLAGS=--timestamp

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
dmg="$out/TrackNothing-$version-$build-macos.dmg"
hdiutil create -volname TrackNothing -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
codesign --sign "$identity" --timestamp "$dmg"

# Notarization: Apple's automated malware check (minutes, not an App Review); the stapled ticket lets Gatekeeper
# accept the download offline.
result=$(xcrun notarytool submit "$dmg" --key "$VEILBIRD_APPLE_API_KEY_PATH" --key-id "$VEILBIRD_APPLE_API_KEY_ID" \
  --issuer "$VEILBIRD_APPLE_API_ISSUER_ID" --wait --timeout 45m --output-format json)
echo "$result"
submission=$(echo "$result" | plutil -extract id raw -o - - 2>/dev/null || true)
if [[ "$(echo "$result" | plutil -extract status raw -o - - 2>/dev/null)" != Accepted ]]; then
  [[ -n "$submission" ]] && xcrun notarytool log "$submission" --key "$VEILBIRD_APPLE_API_KEY_PATH" \
    --key-id "$VEILBIRD_APPLE_API_KEY_ID" --issuer "$VEILBIRD_APPLE_API_ISSUER_ID" || true
  echo 'Notarization was not accepted (log above).' >&2; exit 1
fi
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature --verbose "$dmg"
echo "$dmg"
