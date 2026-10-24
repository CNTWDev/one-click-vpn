#!/usr/bin/env bash
# One-time: creates the Android release signing key and prints the four GitHub secrets CI needs.
# Every future update must be signed with this same key, or Android refuses to install it over the old app:
# keep veilbird-release.jks and its password backed up offline. Needs a JDK (keytool) or Docker.
#   bash scripts/android-keystore.sh [output.jks]
set -euo pipefail
out=${1:-veilbird-release.jks}
alias=veilbird
[[ -e "$out" ]] && { echo "$out already exists; refusing to overwrite a signing key." >&2; exit 1; }
password=$(openssl rand -hex 24)
args=(-genkeypair -v -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10000 -alias "$alias"
  -storepass "$password" -keypass "$password" -dname "CN=Veilbird")
dir=$(cd "$(dirname "$out")" && pwd) name=$(basename "$out")
if command -v keytool >/dev/null; then keytool "${args[@]}" -keystore "$out" >/dev/null 2>&1
elif command -v docker >/dev/null; then docker run --rm -v "$dir:/out" eclipse-temurin:17-jdk keytool "${args[@]}" -keystore "/out/$name" >/dev/null 2>&1
else echo "Install a JDK (keytool) or Docker first." >&2; exit 1; fi
echo "Created $out. Back it up together with the password below; losing either means users must uninstall to update."
echo
echo "GitHub → Settings → Secrets and variables → Actions → New repository secret:"
echo "  VEILBIRD_ANDROID_KEYSTORE_BASE64 = $(base64 < "$out" | tr -d '\n')"
echo "  VEILBIRD_ANDROID_KEYSTORE_PASSWORD = $password"
echo "  VEILBIRD_ANDROID_KEY_ALIAS = $alias"
echo "  VEILBIRD_ANDROID_KEY_PASSWORD = $password"
