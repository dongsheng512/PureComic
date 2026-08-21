#!/usr/bin/env bash
# Copy Core ML models into src-tauri so Tauri can bundle them.
# Usage: ./scripts/prepare-macos-bundle.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_TAURI="$ROOT/apps/desktop/src-tauri"
RES_DIR="$SRC_TAURI/resources"
TP="$ROOT/third_party"

mkdir -p "$RES_DIR"
if [[ -f "$TP/NOTICE" ]]; then
  cp "$TP/NOTICE" "$RES_DIR/NOTICE"
fi
# drop leftover Vulkan copies from older prepares
rm -f "$RES_DIR/checksums.sha256"
for stale in models-cunet models-se models-pro models-nose; do
  rm -rf "$RES_DIR/$stale"
done

# tauri.conf.json resources 已声明，缺失则 fail-fast
for model_dir in waifu2x-coreml realesrgan-coreml realcugan-coreml; do
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
