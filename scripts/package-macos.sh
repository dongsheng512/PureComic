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
  # lock 文件已入库：用 npm ci 保证可复现
  npm ci
fi

echo "building $RUST_TARGET (app + dmg)"
npx tauri build --bundles app,dmg --target "$RUST_TARGET"

OUT="$ROOT/target/$RUST_TARGET/release/bundle"
echo
echo "done. artifacts:"
echo "  $OUT"
ls -lh "$OUT/macos" 2>/dev/null || true
ls -lh "$OUT/dmg" 2>/dev/null || true

# ── 防启动台图标堆积 ─────────────────────────────────────────────
# tauri build 生成的 .app 会被 LaunchServices 自动注册，启动台随之多一个图标；
# 构建产物每打一次就多一份，用户侧会看到多个 PureComic。这里在打包结束后把
# target 下的那份反注册掉——它只是中间产物，正式分发走 DMG 挂载安装。
# （若曾把构建产物 .app 拖进 /Applications 安装过，那条注册不受影响。）
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -d "$OUT/macos/PureComic.app" ]]; then
  "$LSREG" -u "$OUT/macos/PureComic.app" >/dev/null 2>&1 || true
  echo "(unregistered build-product app from LaunchServices)"
fi

echo
echo "Not notarized. First open: right-click Open, or System Settings > Privacy & Security."
