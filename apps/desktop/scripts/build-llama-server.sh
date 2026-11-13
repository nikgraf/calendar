#!/usr/bin/env bash
# Builds llama.cpp's llama-server for the Mac bundle: one static arm64
# binary with the Metal shaders embedded, from the llama.cpp commit llama.rn
# vendors, so the Mac runs the Assistant's model on the same llama.cpp as
# the iPhone (and as the bench scored it). Output: llama/.build/llama-server,
# which forge.config.cjs ships in Resources.
#
# LLAMA_CPP_SRC=<checkout> builds from a local llama.cpp checkout at that
# commit instead of fetching it. A build whose commit and script are
# unchanged is kept.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=llama/.build
VERSIONS="$(node -p "require('node:path').join(require('node:path').dirname(require.resolve('llama.rn/package.json', { paths: ['../ios'] })), 'vendor/VERSIONS')")"
COMMIT="$(sed -n 's/^LLAMA_CPP_COMMIT=//p' "$VERSIONS")"
[ -n "$COMMIT" ] || { echo "no LLAMA_CPP_COMMIT in $VERSIONS" >&2; exit 1; }
STAMP="$COMMIT $(shasum -a 256 "$0" | cut -d' ' -f1)"

if [ -x "$OUT/llama-server" ] && [ "$(cat "$OUT/STAMP" 2>/dev/null)" = "$STAMP" ]; then
  echo "llama-server is up to date ($COMMIT)"
  exit 0
fi

mkdir -p "$OUT"
SRC="${LLAMA_CPP_SRC:-$OUT/src}"
if [ -z "${LLAMA_CPP_SRC:-}" ]; then
  if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$COMMIT" ]; then
    rm -rf "$SRC"
    git init -q "$SRC"
    git -C "$SRC" fetch -q --depth 1 https://github.com/ggml-org/llama.cpp "$COMMIT"
    git -C "$SRC" checkout -q FETCH_HEAD
  fi
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] \
  || { echo "$SRC is not at llama.cpp $COMMIT" >&2; exit 1; }

# Static (no dylibs beside it), Metal embedded (no .metallib), not tuned to
# the build Mac's CPU, and nothing that downloads at build or run time. A
# fresh build folder: CMake refuses a cache made from another checkout.
rm -rf "$OUT/cmake"
cmake -S "$SRC" -B "$OUT/cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=27.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_UI=OFF \
  -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_CONNECT=OFF \
  -DLLAMA_OPENSSL=OFF > "$OUT/cmake.log"
cmake --build "$OUT/cmake" --config Release --target llama-server -j "$(sysctl -n hw.ncpu)" >> "$OUT/cmake.log"

cp "$OUT/cmake/bin/llama-server" "$OUT/llama-server"
# Only the system's libraries may be linked: the binary is moved into the app bundle alone.
if otool -L "$OUT/llama-server" | tail -n +2 | grep -vE '^\s+(/usr/lib/|/System/Library/)'; then
  echo "llama-server links a library outside the system" >&2
  exit 1
fi
echo "$STAMP" > "$OUT/STAMP"
echo "built llama-server ($COMMIT)"
