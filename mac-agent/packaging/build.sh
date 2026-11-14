#!/bin/bash
# Builds Support.app and Support-<version>.pkg for Apple silicon (call 4) from mac-agent/, on a Mac.
#
#   SUPPORT_SIGN_IDENTITY="<identity name or SHA-1>" [SUPPORT_SIGN_KEYCHAIN=<keychain>] mac-agent/packaging/build.sh [out dir]
#
# The app is signed with that identity and the hardened runtime, with the empty entitlements in this folder. There is
# no ad-hoc fallback: an unsigned or ad-hoc app would have a designated requirement of its own cdhash, and the service's
# peer check would then accept only that exact build. SUPPORT_SIGN_IDENTITY=- signs ad hoc, for a local try only.
# The .pkg is not signed here: a self-signed code signing identity cannot sign an installer (call 1, A).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
agent="$(cd "$here/.." && pwd)"
out="${1:-$agent/target/package}"
target=aarch64-apple-darwin
identity="${SUPPORT_SIGN_IDENTITY:?set SUPPORT_SIGN_IDENTITY to the signing identity (or - for ad hoc, local only)}"

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$agent/app/Cargo.toml" | head -n 1)"
[ -n "$version" ] || { echo "no version in app/Cargo.toml" >&2; exit 1; }

echo "Building Support $version for $target"
(cd "$agent" && cargo build --release --locked --target "$target" -p support-mac --bin support)
bin="$agent/target/$target/release/support"
archs="$(lipo -archs "$bin")"
[ "$archs" = "arm64" ] || { echo "the binary is $archs, not arm64 only" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/root/Applications" "$out/root/Library/LaunchDaemons" "$out/root/Library/LaunchAgents"
app="$out/root/Applications/Support.app"
mkdir -p "$app/Contents/MacOS"
sed "s/@VERSION@/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp "$bin" "$app/Contents/MacOS/support"
chmod 755 "$app/Contents/MacOS/support"
plutil -lint "$app/Contents/Info.plist" "$here/io.github.sukardaddy.supportmcp.device.plist" "$here/io.github.sukardaddy.supportmcp.helper.plist" "$here/entitlements.plist"

sign=(codesign --force --sign "$identity" --identifier io.github.sukardaddy.supportmcp --options runtime --entitlements "$here/entitlements.plist")
if [ -n "${SUPPORT_SIGN_KEYCHAIN:-}" ]; then sign+=(--keychain "$SUPPORT_SIGN_KEYCHAIN"); fi
if [ "${SUPPORT_SIGN_TIMESTAMP:-}" = "1" ]; then sign+=(--timestamp); else sign+=(--timestamp=none); fi
"${sign[@]}" "$app"
codesign --verify --strict --verbose=2 "$app"

cp "$here/io.github.sukardaddy.supportmcp.device.plist" "$out/root/Library/LaunchDaemons/"
cp "$here/io.github.sukardaddy.supportmcp.helper.plist" "$out/root/Library/LaunchAgents/"
chmod 644 "$out/root/Library/LaunchDaemons/"*.plist "$out/root/Library/LaunchAgents/"*.plist

# The app must land at /Applications/Support.app and nowhere else: the service checks its helpers by that path. By
# default pkgbuild "relocates" an app to wherever a copy with the same id already is, so that is turned off.
pkgbuild --analyze --root "$out/root" "$out/components.plist"
plutil -replace 0.BundleIsRelocatable -bool NO "$out/components.plist"
plutil -replace 0.BundleIsVersionChecked -bool NO "$out/components.plist"
plutil -replace 0.BundleOverwriteAction -string upgrade "$out/components.plist"
pkgbuild --root "$out/root" --component-plist "$out/components.plist" --identifier io.github.sukardaddy.supportmcp.pkg \
    --version "$version" --scripts "$here/scripts" --install-location / --ownership recommended "$out/Support-component.pkg"
sed "s/@VERSION@/$version/g" "$here/distribution.xml" > "$out/distribution.xml"
productbuild --distribution "$out/distribution.xml" --package-path "$out" "$out/Support-$version.pkg"
rm -f "$out/Support-component.pkg"
cp -R "$app" "$out/Support.app"
echo "$out/Support.app"
echo "$out/Support-$version.pkg"
