#!/usr/bin/env bash
# Download, extract, and pin waifu2x-ncnn-vulkan + models into third_party/.
#
# Usage:
#   ./scripts/fetch-waifu2x.sh              # current host platform
#   ./scripts/fetch-waifu2x.sh --target darwin-arm64
#   ./scripts/fetch-waifu2x.sh --all        # all platforms in pin file (for packaging CI)
#   ./scripts/fetch-waifu2x.sh --tag 20250504
#   ./scripts/fetch-waifu2x.sh --skip-verify
#
# Env:
#   GITHUB_TOKEN   optional, higher API rate limit
#   COMIC_ROOT     repo root (default: parent of scripts/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${COMIC_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PIN_FILE="$ROOT/third_party/waifu2x.pin.json"
THIRD="$ROOT/third_party"
BIN_ROOT="$THIRD/waifu2x-ncnn-vulkan/bin"
CACHE="$THIRD/.cache/waifu2x"
CHECKSUMS="$THIRD/checksums.sha256"
MODELS_DEST="$THIRD/models-cunet"

TARGET=""
DO_ALL=0
SKIP_VERIFY=0
TAG_OVERRIDE=""

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --all) DO_ALL=1; shift ;;
    --tag) TAG_OVERRIDE="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }
}

need_cmd curl
need_cmd unzip
need_cmd shasum || need_cmd sha256sum

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

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
      case "$arch" in
        x86_64|amd64) echo "linux-x64" ;;
        *) echo "unsupported arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    msys*|mingw*|cygwin*)
      echo "windows-x64"
      ;;
    *)
      echo "unsupported OS: $os" >&2
      exit 1
      ;;
  esac
}

json_get() {
  # minimal JSON read via python (available on macOS/dev machines)
  local expr="$1"
  python3 - "$PIN_FILE" "$expr" <<'PY'
import json,sys
pin=json.load(open(sys.argv[1]))
expr=sys.argv[2]
# expr like tag | assets.darwin-arm64.name
cur=pin
for part in expr.split('.'):
    if part.isdigit():
        cur=cur[int(part)]
    else:
        cur=cur[part]
if isinstance(cur,(dict,list)):
    print(json.dumps(cur))
else:
    print(cur)
PY
}

github_headers() {
  local h=(-fsSL -H "Accept: application/vnd.github+json")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    h+=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  printf '%q ' "${h[@]}"
}

download_asset() {
  local target="$1"
  local tag name binary url zip_path extract_dir dest_dir dest_bin

  tag="${TAG_OVERRIDE:-$(json_get tag)}"
  name="$(json_get "assets.${target}.name")"
  binary="$(json_get "assets.${target}.binary")"

  mkdir -p "$CACHE" "$BIN_ROOT/$target" "$MODELS_DEST"
  zip_path="$CACHE/${tag}-${name}"
  primary="https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/${tag}/${name}"
  # Optional mirror prefix, e.g. https://ghfast.top/  or https://mirror.ghproxy.com/
  mirrors=()
  if [[ -n "${COMIC_GITHUB_MIRROR:-}" ]]; then
    mirrors+=("${COMIC_GITHUB_MIRROR}")
  fi
  # Common fallbacks when github.com is slow/blocked
  mirrors+=(
    "https://ghfast.top/"
    "https://mirror.ghproxy.com/"
    "https://ghproxy.net/"
  )

  echo "==> [${target}] tag=${tag}"
  echo "    asset=${name}"

  if [[ ! -f "$zip_path" ]]; then
    echo "    downloading..."
    ok=0
    # try primary first, then mirrors
    for prefix in "" "${mirrors[@]}"; do
      url="${prefix}${primary}"
      echo "    try: $url"
      if curl -fL --retry 2 --retry-delay 1 --connect-timeout 20 --max-time 600 \
          -o "$zip_path.partial" "$url"; then
        # basic zip magic check
        if unzip -t "$zip_path.partial" >/dev/null 2>&1; then
          mv "$zip_path.partial" "$zip_path"
          ok=1
          break
        fi
        echo "    not a valid zip, next..."
        rm -f "$zip_path.partial"
      fi
      rm -f "$zip_path.partial"
    done
    if [[ "$ok" -ne 1 ]]; then
      echo "下载失败。请检查网络 / pin 文件 tag 与 asset 名：" >&2
      echo "  https://github.com/nihui/waifu2x-ncnn-vulkan/releases" >&2
      echo "  或设置 COMIC_GITHUB_MIRROR=https://your-mirror/" >&2
      exit 1
    fi
  else
    echo "    cache hit: $zip_path"
  fi

  extract_dir="$CACHE/extract-${target}-${tag}"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  unzip -q -o "$zip_path" -d "$extract_dir"

  # find binary anywhere in extract tree
  dest_dir="$BIN_ROOT/$target"
  dest_bin="$dest_dir/$binary"
  found="$(find "$extract_dir" -type f -name "$binary" | head -n 1 || true)"
  if [[ -z "$found" ]]; then
    # windows sometimes nests differently
    found="$(find "$extract_dir" -type f \( -name 'waifu2x-ncnn-vulkan' -o -name 'waifu2x-ncnn-vulkan.exe' \) | head -n 1 || true)"
  fi
  if [[ -z "$found" ]]; then
    echo "解压后未找到二进制 $binary" >&2
    find "$extract_dir" -type f | head -40 >&2
    exit 1
  fi

  mkdir -p "$dest_dir"
  cp -f "$found" "$dest_bin"
  chmod +x "$dest_bin" 2>/dev/null || true

  # copy sibling dylibs/dlls next to binary if present
  found_dir="$(dirname "$found")"
  shopt -s nullglob
  for extra in "$found_dir"/*.{dylib,so,dll,json} "$found_dir"/vcomp*.dll; do
    [[ -f "$extra" ]] || continue
    base="$(basename "$extra")"
    [[ "$base" == "$binary" ]] && continue
    cp -f "$extra" "$dest_dir/$base"
  done
  shopt -u nullglob

  # models: prefer models-cunet
  models_src=""
  for cand in models-cunet models; do
    hit="$(find "$extract_dir" -type d -name "$cand" | head -n 1 || true)"
    if [[ -n "$hit" ]]; then
      models_src="$hit"
      break
    fi
  done
  if [[ -n "$models_src" ]]; then
    echo "    models: $models_src -> $MODELS_DEST"
    # merge copy
    rsync -a --delete "$models_src"/ "$MODELS_DEST"/ 2>/dev/null || {
      rm -rf "$MODELS_DEST"
      mkdir -p "$MODELS_DEST"
      cp -R "$models_src"/. "$MODELS_DEST"/
    }
  else
    echo "    warning: no models dir in archive (keep existing models-cunet if any)"
  fi

  # update checksum line for this binary
  sum="$(sha256_file "$dest_bin")"
  rel="waifu2x-ncnn-vulkan/bin/${target}/$(basename "$dest_bin")"
  touch "$CHECKSUMS"
  # remove old line for this path
  if [[ -f "$CHECKSUMS" ]]; then
    grep -v "  ${rel}\$" "$CHECKSUMS" > "$CHECKSUMS.tmp" || true
    mv "$CHECKSUMS.tmp" "$CHECKSUMS"
  fi
  echo "${sum}  ${rel}" >> "$CHECKSUMS"

  # models checksums (optional aggregate file list)
  if [[ -d "$MODELS_DEST" ]]; then
    while IFS= read -r -d '' f; do
      relm="models-cunet/${f#"$MODELS_DEST"/}"
      # skip regenerating every model every time if huge — still pin all for integrity
      s="$(sha256_file "$f")"
      grep -v "  ${relm}\$" "$CHECKSUMS" > "$CHECKSUMS.tmp" 2>/dev/null || true
      mv "$CHECKSUMS.tmp" "$CHECKSUMS"
      echo "${s}  ${relm}" >> "$CHECKSUMS"
    done < <(find "$MODELS_DEST" -type f -print0 | sort -z)
  fi

  echo "    installed: $dest_bin"
  echo "    sha256: $sum"

  if [[ "$SKIP_VERIFY" -eq 0 ]]; then
    "$SCRIPT_DIR/verify-waifu2x.sh" --target "$target" || true
  fi
}

main() {
  if [[ ! -f "$PIN_FILE" ]]; then
    echo "missing pin file: $PIN_FILE" >&2
    exit 1
  fi
  mkdir -p "$THIRD" "$BIN_ROOT" "$CACHE"

  # header for checksums
  if [[ ! -f "$CHECKSUMS" ]] || ! grep -q 'waifu2x-ncnn-vulkan' "$CHECKSUMS" 2>/dev/null; then
    {
      echo "# Auto-updated by scripts/fetch-waifu2x.sh — do not hand-edit casually"
      echo "# Format: <sha256>  <path-relative-to-third_party/>"
    } > "$CHECKSUMS"
  fi

  if [[ "$DO_ALL" -eq 1 ]]; then
    for t in darwin-arm64 darwin-x64 linux-x64 windows-x64; do
      download_asset "$t" || echo "skip/fail $t" >&2
    done
  else
    t="${TARGET:-$(detect_target)}"
    download_asset "$t"
  fi

  echo ""
  echo "Done. Layout:"
  echo "  $BIN_ROOT/"
  ls -la "$BIN_ROOT"/* 2>/dev/null || true
  echo "  models: $MODELS_DEST"
  echo "  checksums: $CHECKSUMS"
  echo ""
  echo "Run real engine:"
  echo "  COMIC_USE_MOCK=0 cargo run -p comic-cli -- doctor"
}

main
