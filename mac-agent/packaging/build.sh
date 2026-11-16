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
#
# SUPPORT_CARGO_FEATURES=preview-permissions builds the permission window's screenshot apps (docs/development.md, "Mac
# permission window"). They must not look like the real apps to macOS, or a privacy prompt or a list entry could land on a
# real app's id. So their Info.plist and signing identifier carry ids of their own (io.github.sukardaddy.supportmcp.
# permissions-preview and ...join.permissions-preview), the names "Support Preview" and "Support Join Preview", and the
# preview Join registers supportmcp-preview:// instead of supportmcp://. The binary itself calls no capture,
# Accessibility or privacy API. Never release such a build.
#
# The macOS update test (.github/workflows/test.yml, docs/development.md "Mac updates") builds test versions with
# SUPPORT_CARGO_FEATURES=test-release, SUPPORT_CARGO_PROFILE=update-test (no LTO, so four builds stay quick),
# SUPPORT_SKIP_JOIN=1 and the test-only variables SUPPORT_TEST_VERSION, SUPPORT_TEST_RELEASE_KEY,
# SUPPORT_TEST_DOWNLOAD_ORIGIN and SUPPORT_TEST_BROKEN. A build without the feature refuses those variables (it does not
# compile), so a release can never carry them.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
agent="$(cd "$here/.." && pwd)"
out="${1:-$agent/target/package}"
target=aarch64-apple-darwin
identity="${SUPPORT_SIGN_IDENTITY:?set SUPPORT_SIGN_IDENTITY to the signing identity (or - for ad hoc, local only)}"

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$agent/app/Cargo.toml" | head -n 1)"
[ -n "$version" ] || { echo "no version in app/Cargo.toml" >&2; exit 1; }
features="${SUPPORT_CARGO_FEATURES:-}"
profile="${SUPPORT_CARGO_PROFILE:-release}"
if [ -n "${SUPPORT_TEST_VERSION:-}" ]; then
    case ",$features," in *,test-release,*) ;; *) echo "SUPPORT_TEST_VERSION needs SUPPORT_CARGO_FEATURES=test-release" >&2; exit 1 ;; esac
    version="$SUPPORT_TEST_VERSION"
fi
preview=0
case ",$features," in *,preview-permissions,*) preview=1 ;; esac
bundle_id=io.github.sukardaddy.supportmcp
join_id=io.github.sukardaddy.supportmcp.join
if [ "$preview" = 1 ]; then
    bundle_id=io.github.sukardaddy.supportmcp.permissions-preview
    join_id=io.github.sukardaddy.supportmcp.join.permissions-preview
fi
# Writes an Info.plist from its template: the version, and for a preview build the preview id and name (and, in the join
# app, the preview link scheme). Fails when a preview build's plist does not carry the preview id.
write_plist() { # template output expected-id
    local template="$1" output="$2" id="$3"
    if [ "$preview" = 1 ]; then
        sed -e "s/@VERSION@/$version/g" \
            -e "s|<string>io\.github\.sukardaddy\.supportmcp\.join</string>|<string>$join_id</string>|" \
            -e "s|<string>io\.github\.sukardaddy\.supportmcp</string>|<string>$bundle_id</string>|" \
            -e 's|<string>Support</string>|<string>Support Preview</string>|' \
            -e 's|<string>Support Join</string>|<string>Support Join Preview</string>|' \
            -e 's|<string>supportmcp</string>|<string>supportmcp-preview</string>|' "$template" > "$output"
    else
        sed "s/@VERSION@/$version/g" "$template" > "$output"
    fi
    plutil -lint "$output"
    [ "$(plutil -extract CFBundleIdentifier raw -o - "$output")" = "$id" ] || { echo "$output does not carry $id" >&2; exit 1; }
}
cargo_args=(build --locked --profile "$profile" --target "$target" -p support-mac)
if [ -n "$features" ]; then cargo_args+=(--features "$features"); fi

echo "Building Support $version for $target (profile $profile${features:+, features $features})"
(cd "$agent" && env -u SUPPORT_JOIN_RELAY_ORIGIN cargo "${cargo_args[@]}" --bin support)
bin="$agent/target/$target/$profile/support"
archs="$(lipo -archs "$bin")"
[ "$archs" = "arm64" ] || { echo "the binary is $archs, not arm64 only" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/root/Applications" "$out/root/Library/LaunchDaemons" "$out/root/Library/LaunchAgents"
app="$out/root/Applications/Support.app"
mkdir -p "$app/Contents/MacOS"
write_plist "$here/Info.plist" "$app/Contents/Info.plist" "$bundle_id"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp "$bin" "$app/Contents/MacOS/support"
chmod 755 "$app/Contents/MacOS/support"
plutil -lint "$app/Contents/Info.plist" "$here/io.github.sukardaddy.supportmcp.device.plist" "$here/io.github.sukardaddy.supportmcp.helper.plist" "$here/entitlements.plist"

sign=(codesign --force --sign "$identity" --identifier "$bundle_id" --options runtime --entitlements "$here/entitlements.plist")
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

if [ "${SUPPORT_SKIP_JOIN:-}" = "1" ]; then
    echo "$out/Support.app"
    echo "$out/Support-$version.pkg"
    exit 0
fi

# ---- Support Join.app: the one-off app, a bundle of its own ----------------------------------------------------------
# Its own binary (support-join, the join role only) and its own bundle id, so its Screen Recording and Accessibility grants
# never mix with the saved app's. Only this bundle registers the supportmcp:// link scheme. It is not in the package: it
# is downloaded as a zip from the support page and runs as the person who opens it.
join_origin="${SUPPORT_JOIN_RELAY_ORIGIN:?set SUPPORT_JOIN_RELAY_ORIGIN to the relay Support Join may join, https://<host>}"
case "$join_origin" in https://*) ;; *) echo "SUPPORT_JOIN_RELAY_ORIGIN must be an https address" >&2; exit 1 ;; esac
echo "Building Support Join $version for $target, joining $join_origin"
(cd "$agent" && SUPPORT_JOIN_RELAY_ORIGIN="$join_origin" cargo "${cargo_args[@]}" --bin support-join)
jbin="$agent/target/$target/$profile/support-join"
jarchs="$(lipo -archs "$jbin")"
[ "$jarchs" = "arm64" ] || { echo "the join binary is $jarchs, not arm64 only" >&2; exit 1; }
japp="$out/Support Join.app"
mkdir -p "$japp/Contents/MacOS"
write_plist "$here/Info-join.plist" "$japp/Contents/Info.plist" "$join_id"
printf 'APPL????' > "$japp/Contents/PkgInfo"
cp "$jbin" "$japp/Contents/MacOS/support-join"
chmod 755 "$japp/Contents/MacOS/support-join"
plutil -lint "$japp/Contents/Info.plist"
jsign=(codesign --force --sign "$identity" --identifier "$join_id" --options runtime --entitlements "$here/entitlements.plist")
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
