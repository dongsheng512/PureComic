#!/usr/bin/env bash
# Download john-rocky Real-ESRGAN Anime 4× Core ML model for the reader.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/realesrgan-coreml"
NAME="RealESRGAN_x4plus_anime_6B.mlmodel"
FILE_ID="1qXdLx46Lpqya7Txc5Wvgkd2Dqlnqm3Qm"
mkdir -p "$DEST"
OUT="$DEST/$NAME"
if [[ -f "$OUT" ]]; then
  SZ=$(wc -c < "$OUT" | tr -d ' ')
  if [[ "$SZ" -gt 10000000 ]]; then
    echo "already have $OUT ($SZ bytes)"
    exit 0
  fi
fi
echo "fetch Real-ESRGAN Anime 4× Core ML ($FILE_ID)"
python3 - <<PY
import urllib.request, os
file_id = "${FILE_ID}"
out = r"${OUT}"
url = f"https://drive.google.com/uc?export=download&id={file_id}"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=180) as r:
    data = r.read()
if len(data) < 1_000_000:
    raise SystemExit(f"download too small: {len(data)} bytes")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "wb").write(data)
print("wrote", out, len(data))
PY
ls -lh "$OUT"
echo "ok — restart the app and pick Real-ESRGAN Anime 4×"
