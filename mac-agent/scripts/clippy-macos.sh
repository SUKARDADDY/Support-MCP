#!/usr/bin/env bash
# Lints the Mac app for the Mac target (aarch64-apple-darwin), from Linux as well as from a Mac.
#
# On Linux the macOS-only code (app/src/mac/, the Support and Support Join binaries) is not
# compiled by a plain `cargo clippy`, and `ring` needs a C compiler for the Mac target. This
# script makes a throwaway one from zig (`zig cc -target aarch64-macos`) and runs clippy with
# warnings denied, so a review on Linux checks that code instead of only reading it. It links
# nothing, so no Apple SDK is needed.
#
# Usage, from anywhere in the repository:
#   mac-agent/scripts/clippy-macos.sh                                # the app as shipped
#   mac-agent/scripts/clippy-macos.sh --features preview-permissions # extra cargo arguments go before `--`
#
# zig is found as $ZIG, then `zig` on PATH, then the `ziglang` Python package
# (`python3 -m pip install --user ziglang`). The target is added to the pinned toolchain when missing.
set -euo pipefail

cd "$(dirname "$0")/.."
target=aarch64-apple-darwin

if ! rustup target list --installed | grep -qx "$target"; then
  rustup target add "$target"
fi

if [ "$(uname -s)" = Darwin ]; then
  exec cargo clippy --locked --target "$target" -p support-mac --all-targets "$@" -- -D warnings
fi

if [ -n "${ZIG:-}" ]; then
  zig=("$ZIG")
elif command -v zig >/dev/null 2>&1; then
  zig=(zig)
elif python3 -c 'import ziglang' >/dev/null 2>&1; then
  zig=(python3 -m ziglang)
else
  echo "clippy-macos: no zig found. Set ZIG, put zig on PATH, or run: python3 -m pip install --user ziglang" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# cc-rs passes Apple's own flags; zig takes the target from -target and refuses these.
{
  echo '#!/usr/bin/env bash'
  printf 'zig=('
  printf '%q ' "${zig[@]}"
  echo ')'
  cat <<'EOF'
args=()
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -arch) skip=1 ;;
    -gfull | -mmacosx-version-min=* | --target=*) ;;
    *) args+=("$a") ;;
  esac
done
exec "${zig[@]}" cc -target aarch64-macos "${args[@]}"
EOF
} >"$tmp/cc"
chmod +x "$tmp/cc"

CC_aarch64_apple_darwin="$tmp/cc" cargo clippy --locked --target "$target" -p support-mac --all-targets "$@" -- -D warnings
