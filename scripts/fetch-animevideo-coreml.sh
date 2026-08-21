#!/usr/bin/env bash
# Convert official realesr-animevideov3 weights to Core ML mlpackage for the reader.
# Needs: uv (runs torch/coremltools ephemeral). sha256 of the source pth is pinned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/animevideo-coreml"
PIN="$ROOT/third_party/animevideo-coreml.pin.json"
CACHE="$ROOT/third_party/.cache/animevideo-coreml"
mkdir -p "$DEST" "$CACHE"

if [[ ! -f "$PIN" ]]; then
  echo "missing pin: $PIN" >&2
  exit 1
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

PTH_URL="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['weights']['url'])")"
PTH_SHA="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['weights']['sha256'])")"
PTH="$CACHE/realesr-animevideov3.pth"

if [[ ! -f "$PTH" ]]; then
  echo "downloading $PTH_URL"
  curl -sL -o "$PTH" "$PTH_URL"
fi
got="$(sha256_file "$PTH")"
if [[ "$got" != "$PTH_SHA" ]]; then
  echo "sha256 mismatch for $PTH: $got != $PTH_SHA" >&2
  exit 1
fi

OUT_NAME="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['models'][0]['name'])")"
OUT="$DEST/$OUT_NAME"
if [[ -d "$OUT" || -f "$OUT" ]]; then
  echo "already converted: $OUT"
  exit 0
fi

# 快路径:优先拉取本仓库 Release 的预转换包(免 uv/torch/coremltools);
# 失败则回落到源权重本地转换
PKG_URL="$(python3 -c "import json; d=json.load(open(r'''$PIN''')).get('package'); print(d['url'] if d else '')")"
PKG_SHA="$(python3 -c "import json; d=json.load(open(r'''$PIN''')).get('package'); print(d['zip_sha256'] if d else '')")"
if [[ -n "$PKG_URL" ]]; then
  PKG_ZIP="$CACHE/$OUT_NAME.zip"
  if curl -fsL --retry 3 -o "$PKG_ZIP" "$PKG_URL"; then
    got="$(sha256_file "$PKG_ZIP")"
    if [[ "$got" == "$PKG_SHA" ]]; then
      unzip -q -o "$PKG_ZIP" -d "$DEST"
      if [[ -d "$OUT" ]]; then
        echo "done (hosted package): $OUT"
        exit 0
      fi
      echo "hosted package unpack missing $OUT, falling back to conversion" >&2
    else
      echo "hosted package sha256 mismatch ($got != $PKG_SHA), falling back to conversion" >&2
    fi
  else
    echo "hosted package unavailable, falling back to conversion" >&2
  fi
fi

# 转换脚本自带数值校验（fp16 vs fp32 PSNR ≥40dB），失败即非零退出
uv run --with torch --with coremltools --with pillow --with numpy \
  python3 "$ROOT/scripts/convert-animevideo-coreml.py" \
  --weights "$PTH" --out "$OUT"

echo "done: $OUT"
