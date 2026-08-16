#!/usr/bin/env bash
# Copy waifu2x sidecar + models into src-tauri so Tauri can bundle them.
# Usage: ./scripts/prepare-macos-bundle.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_TAURI="$ROOT/apps/desktop/src-tauri"
BIN_DIR="$SRC_TAURI/binaries"
RES_DIR="$SRC_TAURI/resources"
TP="$ROOT/third_party"

if [[ ! -d "$TP/models-cunet" ]] || [[ -z "$(ls -A "$TP/models-cunet" 2>/dev/null | grep -v gitkeep || true)" ]]; then
  echo "models-cunet 缺失，先运行 ./scripts/fetch-waifu2x.sh" >&2
  exit 1
fi

HOST="$(uname -m)"
case "$HOST" in
  arm64|aarch64) TRIPLE_DIR="darwin-arm64"; RUSTC_TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE_DIR="darwin-x64"; RUSTC_TRIPLE="x86_64-apple-darwin" ;;
  *) echo "不支持的 mac 架构: $HOST" >&2; exit 1 ;;
esac

SRC_BIN="$TP/waifu2x-ncnn-vulkan/bin/$TRIPLE_DIR/waifu2x-ncnn-vulkan"
if [[ ! -f "$SRC_BIN" ]]; then
  echo "找不到引擎: $SRC_BIN" >&2
  echo "请运行 ./scripts/fetch-waifu2x.sh" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$RES_DIR"
# Tauri externalBin: <path>-<rustc-target-triple>
cp "$SRC_BIN" "$BIN_DIR/waifu2x-ncnn-vulkan-$RUSTC_TRIPLE"
chmod +x "$BIN_DIR/waifu2x-ncnn-vulkan-$RUSTC_TRIPLE"

rm -rf "$RES_DIR/models-cunet"
mkdir -p "$RES_DIR/models-cunet"
cp -R "$TP/models-cunet/." "$RES_DIR/models-cunet/"
cp "$TP/NOTICE" "$RES_DIR/NOTICE"
if [[ -f "$TP/checksums.sha256" ]]; then
  cp "$TP/checksums.sha256" "$RES_DIR/checksums.sha256"
fi

echo "已准备 sidecar: $BIN_DIR/waifu2x-ncnn-vulkan-$RUSTC_TRIPLE"
echo "已准备模型:     $RES_DIR/models-cunet"

CUGAN_BIN="$TP/realcugan-ncnn-vulkan/bin/$TRIPLE_DIR/realcugan-ncnn-vulkan"
# tauri.conf.json 的 externalBin/resources 已声明 realcugan，缺失时 fail-fast
# 而不是打出「默认引擎静默缺失」的包
if [[ ! -f "$CUGAN_BIN" ]]; then
  echo "找不到引擎: $CUGAN_BIN" >&2
  echo "请运行 ./scripts/fetch-realcugan.sh" >&2
  exit 1
fi
for pack in models-se models-pro models-nose; do
  if [[ ! -d "$TP/realcugan-ncnn-vulkan/$pack" ]]; then
    echo "缺少 realcugan 模型包: $TP/realcugan-ncnn-vulkan/$pack" >&2
    echo "请运行 ./scripts/fetch-realcugan.sh" >&2
    exit 1
  fi
done
cp "$CUGAN_BIN" "$BIN_DIR/realcugan-ncnn-vulkan-$RUSTC_TRIPLE"
chmod +x "$BIN_DIR/realcugan-ncnn-vulkan-$RUSTC_TRIPLE"
for pack in models-se models-pro models-nose; do
  rm -rf "$RES_DIR/$pack"
  mkdir -p "$RES_DIR/$pack"
  cp -R "$TP/realcugan-ncnn-vulkan/$pack/." "$RES_DIR/$pack/"
done
echo "已准备 sidecar: $BIN_DIR/realcugan-ncnn-vulkan-$RUSTC_TRIPLE"

# 阅读器 Core ML 模型：tauri.conf resources 已声明，缺失则 fail-fast
for model_dir in waifu2x-coreml realesrgan-coreml; do
  if [[ ! -d "$TP/$model_dir" ]] || [[ -z "$(ls -A "$TP/$model_dir" 2>/dev/null || true)" ]]; then
    echo "缺少 Core ML 模型: $TP/$model_dir" >&2
    echo "请运行 ./scripts/fetch-${model_dir}.sh" >&2
    exit 1
  fi
  rm -rf "$RES_DIR/$model_dir"
  mkdir -p "$RES_DIR/$model_dir"
  cp -R "$TP/$model_dir/." "$RES_DIR/$model_dir/"
  echo "已准备模型:     $RES_DIR/$model_dir"
done
