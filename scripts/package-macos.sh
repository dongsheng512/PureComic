#!/usr/bin/env bash
# Build a macOS .app + .dmg for MVP-A (this host architecture only).
# Usage: ./scripts/package-macos.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"

"$SCRIPT_DIR/prepare-macos-bundle.sh"

HOST="$(uname -m)"
case "$HOST" in
  arm64|aarch64) RUST_TARGET="aarch64-apple-darwin" ;;
  x86_64) RUST_TARGET="x86_64-apple-darwin" ;;
  *) echo "unsupported mac arch: $HOST" >&2; exit 1 ;;
esac

if ! rustup target list --installed | grep -qx "$RUST_TARGET"; then
  echo "installing rust target $RUST_TARGET"
  rustup target add "$RUST_TARGET"
fi

cd "$DESKTOP"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo "building $RUST_TARGET (app + dmg)"
npx tauri build --bundles app,dmg --target "$RUST_TARGET"

OUT="$ROOT/target/$RUST_TARGET/release/bundle"
echo
echo "done. artifacts:"
echo "  $OUT"
ls -lh "$OUT/macos" 2>/dev/null || true
ls -lh "$OUT/dmg" 2>/dev/null || true
echo
echo "Not notarized. First open: right-click Open, or System Settings > Privacy & Security."
