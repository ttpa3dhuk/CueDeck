#!/bin/bash
# Reproducible local build of the CueDeck Syphon probe.
# It builds Syphon from the pinned official source and the probe executable.
# It never starts the probe.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"
BUILD="$ROOT/build"
VENDOR="$ROOT/vendor"
SYPHON_COMMIT="f4761677a45b8034a3c2069ec0f3d2553da81fba"
TARBALL="$VENDOR/syphon-framework-${SYPHON_COMMIT}.tar.gz"
SYPHON_URL="https://codeload.github.com/Syphon/Syphon-Framework/tar.gz/${SYPHON_COMMIT}"
SYPHON_SHA256="a3766088c46588c42b087f4e5ff7ae7bb0f83292af59a0aeb8bba69eba5311c5"
ARCH="$(uname -m)"
MIN_MACOS="13.0"

case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "Unsupported host architecture: $ARCH" >&2; exit 2 ;;
esac

mkdir -p "$VENDOR" "$BUILD/tmp" "$BUILD/obj" "$BUILD/src" "$BUILD/modulecache"

if [ ! -f "$TARBALL" ]; then
  echo "==> downloading official Syphon source ($SYPHON_COMMIT)"
  curl -fL --retry 3 --connect-timeout 15 -o "$TARBALL.part" "$SYPHON_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "==> verifying Syphon source archive"
printf '%s  %s\n' "$SYPHON_SHA256" "$TARBALL" | shasum -a 256 -c -

# A fresh source tree each time makes the local Metal patch deterministic.
rm -rf "$BUILD/src"
mkdir -p "$BUILD/src"
tar -xzf "$TARBALL" -C "$BUILD/src"
SRC="$BUILD/src/Syphon-Framework-${SYPHON_COMMIT}"
patch -p1 -d "$SRC" < "$ROOT/patches/syphon-metal-runtime-library.patch"

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
echo "==> host: $ARCH, deployment target: macOS $MIN_MACOS"

rm -rf "$BUILD/include" "$BUILD/obj" "$BUILD/Syphon.framework" "$BUILD/CueDeckSyphonProbe" "$BUILD/CueDeckSyphonHelper" "$BUILD/libcuedeck_syphon_gpu.dylib" "$BUILD/CueDeckGpuAbiProbe"
mkdir -p "$BUILD/include" "$BUILD/obj"
ln -s "$SRC" "$BUILD/include/Syphon"

OBJ_CFLAGS=(-isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS"
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$BUILD/modulecache"
  -I"$BUILD/include" -I"$SRC" -include "$SRC/Syphon_Prefix.pch"
  -DSYPHON_CORE_SHARE -Wno-deprecated-declarations -Wno-unguarded-availability-new)
C_CFLAGS=(-isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS"
  -O2 -I"$SRC" -DSYPHON_CORE_SHARE -Wno-deprecated-declarations)

for f in "$SRC"/*.m; do
  name="$(basename "$f" .m)"
  echo "  CC $name"
  "$CC" "${OBJ_CFLAGS[@]}" -c "$f" -o "$BUILD/obj/$name.o"
done
for f in "$SRC"/*.c; do
  name="$(basename "$f" .c)"
  echo "  CC $name"
  "$CC" "${C_CFLAGS[@]}" -c "$f" -o "$BUILD/obj/$name.o"
done

echo "==> assembling Syphon.framework"
FW="$BUILD/Syphon.framework"
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
  -o "$FW/Versions/A/Syphon" "$BUILD"/obj/*.o

echo "==> building CueDeckSyphonProbe"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$BUILD/modulecache" \
  -F"$BUILD" -I"$FW/Versions/A/Headers" \
  "$ROOT/src/main.m" \
  -framework Syphon -framework Foundation -framework Metal \
  -framework CoreGraphics -framework CoreText -framework CoreVideo -framework IOSurface \
  -Wl,-rpath,@executable_path \
  -o "$BUILD/CueDeckSyphonProbe"

echo "==> building libcuedeck_syphon_gpu.dylib"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$BUILD/modulecache" \
  -F"$BUILD" -I"$FW/Versions/A/Headers" \
  -dynamiclib -Wl,-install_name,@rpath/libcuedeck_syphon_gpu.dylib \
  -Wl,-rpath,@loader_path \
  "$ROOT/src/syphon_gpu_native.m" \
  -framework Syphon -framework Foundation -framework Metal -framework IOSurface -framework CoreVideo -framework CoreGraphics \
  -o "$BUILD/libcuedeck_syphon_gpu.dylib"

echo "==> building CueDeckGpuAbiProbe"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$BUILD/modulecache" \
  -I"$ROOT/src" \
  "$ROOT/src/gpu_abi_probe.m" \
  -L"$BUILD" -lcuedeck_syphon_gpu -framework Foundation \
  -Wl,-rpath,@executable_path \
  -o "$BUILD/CueDeckGpuAbiProbe"

echo "==> building CueDeckSyphonHelper"
"$CC" -isysroot "$SDK" -arch "$ARCH" -mmacosx-version-min="$MIN_MACOS" \
  -O2 -fobjc-arc -fmodules -fmodules-cache-path="$BUILD/modulecache" \
  -F"$BUILD" -I"$FW/Versions/A/Headers" -I"$ROOT/src" \
  "$ROOT/src/helper.m" \
  -framework Syphon -framework Foundation -framework Metal -framework IOSurface -framework CoreVideo \
  -Wl,-rpath,@executable_path \
  -o "$BUILD/CueDeckSyphonHelper"

echo "==> built: $BUILD/CueDeckSyphonProbe"
echo "==> built: $BUILD/CueDeckSyphonHelper"
echo "==> built: $BUILD/libcuedeck_syphon_gpu.dylib"
echo "==> built: $BUILD/CueDeckGpuAbiProbe"
file "$BUILD/CueDeckSyphonProbe" "$BUILD/CueDeckSyphonHelper" "$BUILD/CueDeckGpuAbiProbe" "$BUILD/libcuedeck_syphon_gpu.dylib" "$FW/Versions/A/Syphon"
otool -L "$BUILD/libcuedeck_syphon_gpu.dylib" | sed -n '1,14p'
echo "Build finished. The sender and helpers were NOT started."
