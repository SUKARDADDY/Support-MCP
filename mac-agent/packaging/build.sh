#!/bin/bash
# Builds Support.app and Support-<version>.pkg for Apple silicon (call 4) from mac-agent/, on a Mac, and Support Join.app
# (the one-off app) zipped as Support-<version>.zip.
#
#   SUPPORT_SIGN_IDENTITY="<identity name or SHA-1>" SUPPORT_JOIN_RELAY_ORIGIN=https://<relay> \
#       [SUPPORT_SIGN_KEYCHAIN=<keychain>] mac-agent/packaging/build.sh [out dir]
#
# SUPPORT_JOIN_RELAY_ORIGIN is the one support server Support Join will join; it is built into that app (a link for any
# other server is refused before anything is sent). It is the production relay's address, https://<host> with no path.
# The repository's wrangler.toml route is a placeholder, so the address comes from here and from nowhere else. The
# saved app is built first and without it, so Support.app carries no relay address of this kind.
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
(cd "$agent" && env -u SUPPORT_JOIN_RELAY_ORIGIN cargo build --release --locked --target "$target" -p support-mac --bin support)
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

# ---- Support Join.app: the one-off app, a bundle of its own ----------------------------------------------------------
# Its own binary (support-join, the join role only) and its own bundle id, so its Screen Recording and Accessibility grants
# never mix with the saved app's. Only this bundle registers the supportmcp:// link scheme. It is not in the package: it
# is downloaded as a zip from the support page and runs as the person who opens it.
join_origin="${SUPPORT_JOIN_RELAY_ORIGIN:?set SUPPORT_JOIN_RELAY_ORIGIN to the relay Support Join may join, https://<host>}"
case "$join_origin" in https://*) ;; *) echo "SUPPORT_JOIN_RELAY_ORIGIN must be an https address" >&2; exit 1 ;; esac
echo "Building Support Join $version for $target, joining $join_origin"
(cd "$agent" && SUPPORT_JOIN_RELAY_ORIGIN="$join_origin" cargo build --release --locked --target "$target" -p support-mac --bin support-join)
jbin="$agent/target/$target/release/support-join"
jarchs="$(lipo -archs "$jbin")"
[ "$jarchs" = "arm64" ] || { echo "the join binary is $jarchs, not arm64 only" >&2; exit 1; }
japp="$out/Support Join.app"
mkdir -p "$japp/Contents/MacOS"
sed "s/@VERSION@/$version/g" "$here/Info-join.plist" > "$japp/Contents/Info.plist"
printf 'APPL????' > "$japp/Contents/PkgInfo"
cp "$jbin" "$japp/Contents/MacOS/support-join"
chmod 755 "$japp/Contents/MacOS/support-join"
plutil -lint "$japp/Contents/Info.plist"
jsign=(codesign --force --sign "$identity" --identifier io.github.sukardaddy.supportmcp.join --options runtime --entitlements "$here/entitlements.plist")
if [ -n "${SUPPORT_SIGN_KEYCHAIN:-}" ]; then jsign+=(--keychain "$SUPPORT_SIGN_KEYCHAIN"); fi
if [ "${SUPPORT_SIGN_TIMESTAMP:-}" = "1" ]; then jsign+=(--timestamp); else jsign+=(--timestamp=none); fi
"${jsign[@]}" "$japp"
codesign --verify --strict --verbose=2 "$japp"
# ditto keeps the signature, the permissions and the extended attributes that a plain zip loses.
ditto -c -k --keepParent "$japp" "$out/Support-$version.zip"

echo "$out/Support.app"
echo "$out/Support-$version.pkg"
echo "$japp"
echo "$out/Support-$version.zip"
