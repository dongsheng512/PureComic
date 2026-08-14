#!/usr/bin/env bash
# Download waifu2x-ios Core ML 2× anime models (noise 0–3) for the reader.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/waifu2x-coreml"
mkdir -p "$DEST"

fetch_one() {
  local name="$1"
  if [[ -f "$DEST/$name" && $(stat -f%z "$DEST/$name" 2>/dev/null || stat -c%s "$DEST/$name") -gt 100000 ]]; then
    echo "already have $DEST/$name"
    return 0
  fi
  local url="https://github.com/imxieyi/waifu2x-ios/raw/master/waifu2x/models/${name}"
  echo "fetch $url"
  curl -fL --retry 3 -o "$DEST/$name" "$url"
  if head -c 20 "$DEST/$name" | grep -q 'version https://git-lfs'; then
    echo "got a Git LFS pointer; trying media.githubusercontent.com"
    rm -f "$DEST/$name"
    curl -fL --retry 3 -o "$DEST/$name" \
      "https://media.githubusercontent.com/media/imxieyi/waifu2x-ios/master/waifu2x/models/${name}"
  fi
  ls -lh "$DEST/$name"
}

for n in 0 1 2 3; do
  fetch_one "up_anime_noise${n}_scale2x_model.mlmodel"
done
echo "ok — restart the app to use Waifu2x Core ML"
