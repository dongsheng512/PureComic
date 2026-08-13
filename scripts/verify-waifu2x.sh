#!/usr/bin/env bash
# Verify third_party checksums for waifu2x binary + models.
#
# Usage:
#   ./scripts/verify-waifu2x.sh
#   ./scripts/verify-waifu2x.sh --target darwin-arm64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${COMIC_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
THIRD="$ROOT/third_party"
CHECKSUMS="$THIRD/checksums.sha256"
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ ! -f "$CHECKSUMS" ]]; then
  echo "no checksums file: $CHECKSUMS" >&2
  exit 1
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

fail=0
checked=0
while read -r sum path; do
  [[ -z "${sum:-}" || "$sum" =~ ^# ]] && continue
  [[ -z "${path:-}" ]] && continue
  if [[ -n "$TARGET" && "$path" == waifu2x-ncnn-vulkan/bin/* ]]; then
    case "$path" in
      *"/bin/${TARGET}/"*) ;;
      *) continue ;;
    esac
  fi
  f="$THIRD/$path"
  if [[ ! -f "$f" ]]; then
    echo "MISSING  $path" >&2
    fail=1
    continue
  fi
  got="$(sha256_file "$f")"
  got_l="$(echo "$got" | tr '[:upper:]' '[:lower:]')"
  sum_l="$(echo "$sum" | tr '[:upper:]' '[:lower:]')"
  if [[ "$got_l" != "$sum_l" ]]; then
    echo "MISMATCH $path" >&2
    echo "  expect $sum" >&2
    echo "  got    $got" >&2
    fail=1
  else
    echo "OK       $path"
    checked=$((checked + 1))
  fi
done < <(grep -v '^#' "$CHECKSUMS" | grep -v '^$' || true)

if [[ "$checked" -eq 0 && -z "$TARGET" ]]; then
  echo "No checksum entries found. Run scripts/fetch-waifu2x.sh first." >&2
  exit 1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "Verification failed." >&2
  exit 1
fi
echo "Verified $checked file(s)."
