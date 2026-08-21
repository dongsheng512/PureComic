#!/usr/bin/env bash
# Convert official Real-CUGAN SE 2× weights to Core ML mlpackage for the reader.
# Needs: python3, torch, coremltools (macOS). sha256 of the source zip is pinned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/realcugan-coreml"
PIN="$ROOT/third_party/realcugan-coreml.pin.json"
CACHE="$ROOT/third_party/.cache/realcugan-coreml"
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

ZIP_URL="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['weights_zip']['url'])")"
ZIP_SHA="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['weights_zip']['sha256'])")"
UPCUNET_URL="$(python3 -c "import json; print(json.load(open(r'''$PIN'''))['upcunet_py'])")"
ZIP="$CACHE/updated_weights.zip"
UPCUNET="$CACHE/upcunet_v3.py"

need_convert=0
python3 - "$PIN" "$DEST" <<'PY' || need_convert=1
import json, os, sys
pin = json.load(open(sys.argv[1]))
dest = sys.argv[2]
for m in pin["models"]:
    p = os.path.join(dest, m["mlpackage"])
    if not os.path.isdir(p):
        sys.exit(1)
print("all mlpackages present")
PY

if [[ "$need_convert" -eq 0 ]]; then
  echo "already have $DEST"
  exit 0
fi

# 快路径:优先拉取本仓库 Release 的预转换包(免 torch/coremltools);
# 失败则回落到源权重本地转换
fetch_hosted_packages() {
  python3 - "$PIN" "$DEST" <<'PY' || return 1
import hashlib, json, os, subprocess, sys
pin = json.load(open(sys.argv[1]))
dest = sys.argv[2]
pkgs = pin.get("packages")
if not pkgs:
    sys.exit(1)
for it in pkgs["items"]:
    d = os.path.join(dest, it["mlpackage"])
    if os.path.isdir(d):
        continue
    zdir = os.path.join(dest, ".cache-zip")
    os.makedirs(zdir, exist_ok=True)
    z = os.path.join(zdir, it["mlpackage"] + ".zip")
    subprocess.run(
        ["curl", "-fL", "--retry", "3", "-o", z, pkgs["base_url"] + it["mlpackage"] + ".zip"],
        check=True,
    )
    h = hashlib.sha256(open(z, "rb").read()).hexdigest()
    if h != it["zip_sha256"]:
        print(f"zip sha256 mismatch: {it['mlpackage']}", file=sys.stderr)
        sys.exit(1)
    subprocess.run(["unzip", "-q", "-o", z, "-d", dest], check=True)
    if not os.path.isdir(d):
        print(f"unpack missing dir: {it['mlpackage']}", file=sys.stderr)
        sys.exit(1)
print("hosted packages ok")
PY
}

if fetch_hosted_packages; then
  echo "done (hosted packages)"
  exit 0
fi
echo "hosted packages unavailable, falling back to source conversion"

if [[ ! -f "$ZIP" ]] || [[ "$(sha256_file "$ZIP")" != "$ZIP_SHA" ]]; then
  echo "fetch $ZIP_URL"
  curl -fL --retry 3 -o "$ZIP" "$ZIP_URL"
fi
got="$(sha256_file "$ZIP")"
if [[ "$got" != "$ZIP_SHA" ]]; then
  echo "checksum mismatch: updated_weights.zip" >&2
  echo "  expect $ZIP_SHA" >&2
  echo "  got    $got" >&2
  exit 1
fi

if [[ ! -f "$UPCUNET" ]]; then
  echo "fetch upcunet_v3.py"
  curl -fL --retry 3 -o "$UPCUNET" "$UPCUNET_URL"
fi

python3 -c "import torch, coremltools" >/dev/null 2>&1 || {
  echo "需要 python3 包: torch 与 coremltools。例如: pip3 install torch coremltools" >&2
  exit 1
}

WORKDIR="$CACHE/weights"
mkdir -p "$WORKDIR"
unzip -o -q "$ZIP" -d "$CACHE"
WDIR="$CACHE/updated_weights"
if [[ ! -d "$WDIR" ]]; then
  WDIR="$(find "$CACHE" -type d -name updated_weights | head -1)"
fi

python3 - "$PIN" "$WDIR" "$DEST" "$UPCUNET" "$ROOT" <<'PY'
import json, os, subprocess, sys
pin, wdir, dest, upcunet, root = sys.argv[1:]
script = os.path.join(root, "scripts/convert-realcugan-coreml.py")
for m in pin["models"]:
    out = os.path.join(dest, m["mlpackage"])
    if os.path.isdir(out):
        print("have", out)
        continue
    pth = os.path.join(wdir, m["pth"])
    if not os.path.isfile(pth):
        raise SystemExit(f"missing {pth}")
    print("convert", m["pth"], "->", m["mlpackage"])
    subprocess.check_call([
        sys.executable, script,
        "--weights", pth,
        "--upcunet", upcunet,
        "--out", out,
    ])
print("ok", dest)
PY

echo "ok — restart the app to use Real-CUGAN Core ML"
