#!/usr/bin/env bash
# Download john-rocky Real-ESRGAN Anime 4× Core ML model for the reader.
# sha256 is required (third_party/realesrgan-coreml.pin.json).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/realesrgan-coreml"
PIN="$ROOT/third_party/realesrgan-coreml.pin.json"
mkdir -p "$DEST"

if [[ ! -f "$PIN" ]]; then
  echo "missing pin: $PIN" >&2
  exit 1
fi

NAME="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['models'][0]['name'])")"
FILE_URL="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['models'][0]['url'])")"
EXPECT="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['models'][0]['sha256'])")"
OUT="$DEST/$NAME"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

verify() {
  local got
  got="$(sha256_file "$OUT" | tr '[:upper:]' '[:lower:]')"
  local exp
  exp="$(echo "$EXPECT" | tr '[:upper:]' '[:lower:]')"
  if [[ "$got" != "$exp" ]]; then
    echo "checksum mismatch: $NAME" >&2
    echo "  expect $exp" >&2
    echo "  got    $got" >&2
    return 1
  fi
  return 0
}

if [[ -f "$OUT" ]] && verify; then
  echo "already have $OUT"
  exit 0
fi

echo "fetch Real-ESRGAN Anime 4× Core ML"
python3 - <<PY
import urllib.request, os
out = r"${OUT}"
url = r"${FILE_URL}"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=180) as r:
    data = r.read()
if len(data) < 1_000_000:
    raise SystemExit(f"download too small: {len(data)} bytes")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "wb").write(data)
print("wrote", out, len(data))
PY

verify
ls -lh "$OUT"
echo "ok — restart the app and pick Real-ESRGAN Anime 4×"
