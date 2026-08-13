#!/usr/bin/env bash
# Download realcugan-ncnn-vulkan + models-se/pro/nose into third_party/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${COMIC_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PIN_FILE="$ROOT/third_party/realcugan.pin.json"
THIRD="$ROOT/third_party"
BIN_ROOT="$THIRD/realcugan-ncnn-vulkan/bin"
CACHE="$THIRD/.cache/realcugan"
DEST_ROOT="$THIRD/realcugan-ncnn-vulkan"

TARGET=""
TAG_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --tag) TAG_OVERRIDE="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--target darwin-arm64]"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }; }
need_cmd curl
need_cmd unzip

detect_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin)
      case "$arch" in
        arm64|aarch64) echo "darwin-arm64" ;;
        x86_64) echo "darwin-x64" ;;
        *) echo "unsupported arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    linux)
      echo "linux-x64"
      ;;
    *)
      echo "unsupported OS: $os" >&2; exit 1
      ;;
  esac
}

json_get() {
  python3 - "$PIN_FILE" "$1" <<'PY'
import json,sys
pin=json.load(open(sys.argv[1]))
cur=pin
for part in sys.argv[2].split('.'):
    cur=cur[int(part)] if part.isdigit() else cur[part]
print(cur if not isinstance(cur,(dict,list)) else __import__('json').dumps(cur))
PY
}

TARGET="${TARGET:-$(detect_target)}"
tag="${TAG_OVERRIDE:-$(json_get tag)}"
name="$(json_get "assets.${TARGET}.name")"
binary="$(json_get "assets.${TARGET}.binary")"
mkdir -p "$CACHE" "$BIN_ROOT/$TARGET"
zip_path="$CACHE/${tag}-${name}"
primary="https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/${tag}/${name}"
mirrors=()
if [[ -n "${COMIC_GITHUB_MIRROR:-}" ]]; then
  mirrors+=("${COMIC_GITHUB_MIRROR}")
fi
mirrors+=("https://ghfast.top/" "https://ghproxy.net/")

echo "==> realcugan [${TARGET}] tag=${tag} asset=${name}"
if [[ ! -f "$zip_path" ]]; then
  ok=0
  for prefix in "" "${mirrors[@]}"; do
    url="${prefix}${primary}"
    echo "    try: $url"
    if curl -fL --retry 2 --retry-delay 1 --connect-timeout 20 --max-time 600 \
        -o "$zip_path.partial" "$url" && unzip -t "$zip_path.partial" >/dev/null 2>&1; then
      mv "$zip_path.partial" "$zip_path"
      ok=1
      break
    fi
    rm -f "$zip_path.partial"
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "下载失败: $primary" >&2
    exit 1
  fi
fi

extract_dir="$CACHE/extract-${TARGET}-${tag}"
rm -rf "$extract_dir"
mkdir -p "$extract_dir"
unzip -q -o "$zip_path" -d "$extract_dir"
found="$(find "$extract_dir" -type f -name "$binary" | head -n 1 || true)"
if [[ -z "$found" ]]; then
  found="$(find "$extract_dir" -type f -name 'realcugan-ncnn-vulkan*' | head -n 1 || true)"
fi
if [[ -z "$found" ]]; then
  echo "解压后未找到二进制" >&2
  find "$extract_dir" -type f | head -40 >&2
  exit 1
fi
mkdir -p "$BIN_ROOT/$TARGET"
cp -f "$found" "$BIN_ROOT/$TARGET/$binary"
chmod +x "$BIN_ROOT/$TARGET/$binary" 2>/dev/null || true
found_dir="$(dirname "$found")"
shopt -s nullglob
for extra in "$found_dir"/*.{dylib,so,dll}; do
  [[ -f "$extra" ]] || continue
  cp -f "$extra" "$BIN_ROOT/$TARGET/"
done
shopt -u nullglob

for cand in models-se models-pro models-nose; do
  hit="$(find "$extract_dir" -type d -name "$cand" | head -n 1 || true)"
  if [[ -n "$hit" ]]; then
    echo "    models: $hit -> $DEST_ROOT/$cand"
    rm -rf "$DEST_ROOT/$cand"
    mkdir -p "$DEST_ROOT/$cand"
    cp -R "$hit"/. "$DEST_ROOT/$cand"/
  fi
done

echo "OK  $BIN_ROOT/$TARGET/$binary"
ls -d "$DEST_ROOT"/models-* 2>/dev/null || true
