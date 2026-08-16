#!/usr/bin/env bash
# Download waifu2x-ios Core ML 2× anime models (noise 0–3) for the reader.
# sha256 is required (third_party/waifu2x-coreml.pin.json).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/waifu2x-coreml"
PIN="$ROOT/third_party/waifu2x-coreml.pin.json"
mkdir -p "$DEST"

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

verify_one() {
  local name="$1" expect="$2" dest="$DEST/$name"
  local got
  got="$(sha256_file "$dest" | tr '[:upper:]' '[:lower:]')"
  expect="$(echo "$expect" | tr '[:upper:]' '[:lower:]')"
  if [[ "$got" != "$expect" ]]; then
    echo "checksum mismatch: $name" >&2
    echo "  expect $expect" >&2
    echo "  got    $got" >&2
    return 1
  fi
  return 0
}

fetch_one() {
  local name="$1" url="$2" expect="$3"
  if [[ -f "$DEST/$name" ]] && verify_one "$name" "$expect"; then
    echo "already have $DEST/$name"
    return 0
  fi
  rm -f "$DEST/$name"
  echo "fetch $url"
  curl -fL --retry 3 -o "$DEST/$name" "$url"
  if head -c 20 "$DEST/$name" | grep -q 'version https://git-lfs'; then
    echo "got a Git LFS pointer; trying media.githubusercontent.com" >&2
    rm -f "$DEST/$name"
    curl -fL --retry 3 -o "$DEST/$name" \
      "https://media.githubusercontent.com/media/imxieyi/waifu2x-ios/master/waifu2x/models/${name}"
  fi
  verify_one "$name" "$expect"
  ls -lh "$DEST/$name"
}

python3 - "$PIN" <<'PY' | while IFS=$'\t' read -r name url sha; do
import json, sys
pin = json.load(open(sys.argv[1]))
for m in pin["models"]:
    print(f"{m['name']}\t{m['url']}\t{m['sha256']}")
PY
  fetch_one "$name" "$url" "$sha"
done

echo "ok — restart the app to use Waifu2x Core ML"
