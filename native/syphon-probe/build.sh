#!/bin/bash
# Reproducible local build of the CueDeck Syphon probe.
# Default: host architecture into ./build (the existing dev build).
# Packaging: --arch arm64|x86_64 --output-dir build/darwin-arm64|build/darwin-x64
# Environment equivalents: SYPHON_ARCH, SYPHON_OUTPUT_DIR.
# It never starts the probe and never deletes files outside the chosen output.
set -euo pipefail

ROOT="$(cd -P "$(dirname "$0")" && pwd -P)"
cd "$ROOT"
VENDOR="$ROOT/vendor"
SYPHON_COMMIT="f4761677a45b8034a3c2069ec0f3d2553da81fba"
TARBALL="$VENDOR/syphon-framework-${SYPHON_COMMIT}.tar.gz"
SYPHON_URL="https://codeload.github.com/Syphon/Syphon-Framework/tar.gz/${SYPHON_COMMIT}"
SYPHON_SHA256="a3766088c46588c42b087f4e5ff7ae7bb0f83292af59a0aeb8bba69eba5311c5"
PATCH="$ROOT/patches/syphon-metal-runtime-library.patch"
ARCH="${SYPHON_ARCH:-$(uname -m)}"
OUTPUT_DIR="${SYPHON_OUTPUT_DIR:-$ROOT/build}"
MIN_MACOS="13.0"

die() { echo "build.sh: $*" >&2; exit 2; }

usage() {
  cat <<EOF
Usage: ./build.sh [--arch arm64|x86_64] [--output-dir DIR]
  --arch         Target architecture (default: host $(uname -m)).
  --output-dir   Output directory under native/syphon-probe/build
                 (default: native/syphon-probe/build).
Env: SYPHON_ARCH, SYPHON_OUTPUT_DIR. CLI wins.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch) [ "$#" -ge 2 ] || die "missing value for --arch"; ARCH="$2"; shift 2 ;;
    --arch=*) ARCH="${1#*=}"; shift ;;
    --output-dir) [ "$#" -ge 2 ] || die "missing value for --output-dir"; OUTPUT_DIR="$2"; shift 2 ;;
    --output-dir=*) OUTPUT_DIR="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ARCH" in
  arm64|x86_64) ;;
  *) die "unsupported target architecture: $ARCH (expected arm64 or x86_64)" ;;
esac
OUTPUT_DIR="${OUTPUT_DIR%/}"
[ -n "$OUTPUT_DIR" ] || die "empty output directory"
IFS='/' read -ra RAW_PARTS <<< "$OUTPUT_DIR"
for PART in "${RAW_PARTS[@]}"; do
  case "$PART" in .|..) die "refusing . or .. in output directory: $OUTPUT_DIR" ;; esac
done

# Resolve every existing path component and reject symlinks. A build may only
# write below native/syphon-probe/build; never into the repo root or a parent.
case "$OUTPUT_DIR" in /*) RAW_OUT="$OUTPUT_DIR" ;; *) RAW_OUT="$ROOT/$OUTPUT_DIR" ;; esac
mkdir -p "$ROOT/build"
[ ! -L "$ROOT/build" ] || die "refusing symlinked build root: $ROOT/build"
ALLOWED="$(cd -P "$ROOT/build" && pwd -P)"
[ "$RAW_OUT" != "/" ] || die "unsafe output directory: /"
IFS='/' read -ra PARTS <<< "${RAW_OUT#/}"
CUR=""
for PART in "${PARTS[@]}"; do
  CUR="$CUR/$PART"
  [ ! -L "$CUR" ] || die "refusing symlink in output path: $CUR"
done
P="$RAW_OUT"; SUFFIX=""
while [ ! -e "$P" ] && [ "$P" != "/" ]; do
  SUFFIX="/$(basename "$P")$SUFFIX"
  P="$(dirname "$P")"
done
OUT="$(cd -P "$P" && printf '%s%s' "$PWD" "$SUFFIX")"
[ "$OUT" = "$ALLOWED" ] || [[ "$OUT" == "$ALLOWED/"* ]] || die "output must be under $ALLOWED: $OUT"
[ ! -L "$OUT" ] || die "refusing symlinked output directory: $OUT"
if [ -e "$OUT" ] && [ ! -d "$OUT" ]; then die "output is not a directory: $OUT"; fi
mkdir -p "$OUT"
[ -w "$OUT" ] || die "output is not writable: $OUT"

# Remove only this script's own artifacts, and never through a symlink.
clean_tree() {
  local p="$1"
  [ ! -L "$p" ] || die "refusing to remove symlink: $p"
  if [ -e "$p" ]; then rm -rf -- "$p"; fi
}
clean_file() {
  local p="$1"
  [ ! -L "$p" ] || die "refusing to remove symlink: $p"
  if [ -e "$p" ]; then rm -f -- "$p"; fi
}

mkdir -p "$VENDOR"
if [ ! -f "$TARBALL" ]; then
  echo "==> downloading official Syphon source ($SYPHON_COMMIT)"
  curl -fL --retry 3 --connect-timeout 15 -o "$TARBALL.part" "$SYPHON_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "==> verifying Syphon source archive"
printf '%s  %s\n' "$SYPHON_SHA256" "$TARBALL" | shasum -a 256 -c -

WORK="$OUT/.work"
clean_tree "$WORK"
clean_tree "$OUT/Syphon.framework"
clean_file "$OUT/CueDeckSyphonProbe"
clean_file "$OUT/CueDeckSyphonHelper"
clean_file "$OUT/CueDeckGpuAbiProbe"
clean_file "$OUT/libcuedeck_syphon_gpu.dylib"
mkdir -p "$WORK/src" "$WORK/obj" "$WORK/include" "$WORK/modulecache"

echo "==> extracting pinned Syphon source"
tar -xzf "$TARBALL" -C "$WORK/src"
SRC="$WORK/src/Syphon-Framework-${SYPHON_COMMIT}"
[ -d "$SRC" ] || die "unexpected Syphon source layout: $SRC"
patch -p1 --batch -d "$SRC" -i "$PATCH"

SDK="$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
  SDK="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"
fi
if [ ! -d "$SDK" ]; then
  echo "macOS SDK not found" >&2
  exit 3
fi
CC="/usr/bin/clang"
echo "==> SDK: $SDK"
echo "==> host: $(uname -m), target: $ARCH, deployment target: macOS $MIN_MACOS"
echo "==> output: $OUT"
ln -s "$SRC" "$WORK/include/Syphon"

OBJ_CFLAGS=(-isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS"
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$WORK/modulecache"
  -I"$WORK/include" -I"$SRC" -include "$SRC/Syphon_Prefix.pch"
  -DSYPHON_CORE_SHARE -Wno-deprecated-declarations -Wno-unguarded-availability-new)
C_CFLAGS=(-isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS"
  -O2 -I"$SRC" -DSYPHON_CORE_SHARE -Wno-deprecated-declarations)

for f in "$SRC"/*.m; do
  name="$(basename "$f" .m)"
  echo "  CC $name"
  "$CC" "${OBJ_CFLAGS[@]}" -c "$f" -o "$WORK/obj/$name.o"
done
for f in "$SRC"/*.c; do
  name="$(basename "$f" .c)"
  echo "  CC $name"
  "$CC" "${C_CFLAGS[@]}" -c "$f" -o "$WORK/obj/$name.o"
done

echo "==> assembling Syphon.framework ($ARCH)"
FW="$OUT/Syphon.framework"
mkdir -p "$FW/Versions/A/Headers" "$FW/Versions/A/Resources" "$FW/Versions/A/Modules"
cp "$SRC"/*.h "$FW/Versions/A/Headers/"
cp "$SRC/Syphon.modulemap" "$FW/Versions/A/Modules/module.modulemap"
cp "$SRC/License.txt" "$FW/Versions/A/Resources/License.txt"
# The local build-only shader path reads these official sources at runtime.
cp "$SRC/SyphonMetalShaders.metal" "$FW/Versions/A/Resources/SyphonMetalShaders.metal"
cp "$SRC/SyphonServerMetalTypes.h" "$FW/Versions/A/Resources/SyphonServerMetalTypes.h"
cat > "$FW/Versions/A/Resources/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleExecutable</key><string>Syphon</string>
  <key>CFBundleIdentifier</key><string>info.v002.Syphon.local-prototype</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Syphon</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>6-dev</string>
  <key>CFBundleVersion</key><string>6</string>
</dict>
</plist>
PLIST
ln -s A "$FW/Versions/Current"
ln -s Versions/Current/Headers "$FW/Headers"
ln -s Versions/Current/Resources "$FW/Resources"
ln -s Versions/Current/Syphon "$FW/Syphon"

"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -dynamiclib -Wl,-install_name,@rpath/Syphon.framework/Versions/A/Syphon \
  -Wl,-current_version,1 -Wl,-compatibility_version,1 \
  -framework Cocoa -framework OpenGL -framework Metal -framework IOSurface \
  -framework CoreVideo -framework QuartzCore \
  -o "$FW/Versions/A/Syphon" "$WORK"/obj/*.o

echo "==> building CueDeckSyphonProbe"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$WORK/modulecache" \
  -F"$OUT" -I"$FW/Versions/A/Headers" \
  "$ROOT/src/main.m" \
  -framework Syphon -framework Foundation -framework Metal \
  -framework CoreGraphics -framework CoreText -framework CoreVideo -framework IOSurface \
  -Wl,-rpath,@executable_path \
  -o "$OUT/CueDeckSyphonProbe"

echo "==> building libcuedeck_syphon_gpu.dylib"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$WORK/modulecache" \
  -F"$OUT" -I"$FW/Versions/A/Headers" \
  -dynamiclib -Wl,-install_name,@rpath/libcuedeck_syphon_gpu.dylib \
  -Wl,-rpath,@loader_path \
  "$ROOT/src/syphon_gpu_native.m" \
  -framework Syphon -framework Foundation -framework Metal -framework IOSurface -framework CoreVideo -framework CoreGraphics \
  -o "$OUT/libcuedeck_syphon_gpu.dylib"

echo "==> building CueDeckGpuAbiProbe"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$WORK/modulecache" \
  -I"$ROOT/src" \
  "$ROOT/src/gpu_abi_probe.m" \
  -L"$OUT" -lcuedeck_syphon_gpu -framework Foundation \
  -Wl,-rpath,@executable_path \
  -o "$OUT/CueDeckGpuAbiProbe"

echo "==> building CueDeckSyphonHelper"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$WORK/modulecache" \
  -F"$OUT" -I"$FW/Versions/A/Headers" -I"$ROOT/src" \
  "$ROOT/src/helper.m" \
  -framework Syphon -framework Foundation -framework Metal -framework IOSurface -framework CoreVideo \
  -Wl,-rpath,@executable_path \
  -o "$OUT/CueDeckSyphonHelper"

echo "==> built: $OUT/CueDeckSyphonProbe"
echo "==> built: $OUT/CueDeckSyphonHelper"
echo "==> built: $OUT/libcuedeck_syphon_gpu.dylib"
echo "==> built: $OUT/CueDeckGpuAbiProbe"
file "$OUT/CueDeckSyphonProbe" "$OUT/CueDeckSyphonHelper" "$OUT/CueDeckGpuAbiProbe" "$OUT/libcuedeck_syphon_gpu.dylib" "$FW/Versions/A/Syphon"
otool -L "$OUT/libcuedeck_syphon_gpu.dylib" | sed -n '1,4p'
clean_tree "$WORK"
echo "Build finished. The sender and helpers were NOT started."
