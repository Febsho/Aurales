#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="$repository_root/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Aurales.app"
dmg_directory="$repository_root/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
dmg_path="$dmg_directory/Aurales_aarch64.dmg"

if [[ ! -d "$app_path" ]]; then
  echo "macOS app bundle not found: $app_path" >&2
  echo "Build it first with: npm run build:macos" >&2
  exit 1
fi

mkdir -p "$dmg_directory"
staging_directory="$(mktemp -d "$dmg_directory/.aurales-dmg.XXXXXX")"
cleanup() { rm -rf "$staging_directory"; }
trap cleanup EXIT

ditto "$app_path" "$staging_directory/Aurales.app"
ln -s /Applications "$staging_directory/Applications"
hdiutil create -volname Aurales -srcfolder "$staging_directory" -format UDZO -ov "$dmg_path"
echo "Created $dmg_path"
