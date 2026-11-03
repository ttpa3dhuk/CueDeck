# Windows Spout output

CueDeck shares its audience picture with a local Spout receiver. The actual audience renderer produces an Electron offscreen GPU texture. A native worker opens its DXGI NT handle on the matching graphics adapter and calls SpoutDX `SendTexture`.

This includes a GPU copy into Spout's shared texture. It does not map picture pixels into CPU memory. Electron's texture stays alive until a D3D11 event query confirms that the copy has finished, because releasing it earlier lets Chromium reuse the buffer.

Settings → Outputs shows **Spout** on Windows and **Syphon** on macOS. The internal `syphon` settings/IPC name is shared for compatibility.

## Build

Requirements: CMake 3.24+, Windows x64 C++ toolchain and official [Spout2](https://github.com/leadedge/Spout2/tree/6b68a5b4fdeca6130b851e5f9366467a844860e5) at commit `6b68a5b4fdeca6130b851e5f9366467a844860e5` (BSD-2-Clause).

Set `SPOUT2_ROOT` to the pinned source directory. For a cross-build, also set `SPOUT2_TOOLCHAIN` to an explicit Windows CMake toolchain file. Native Windows builds use Visual Studio 2022 x64.

```sh
npm run prepare:spout
npm run verify:spout
npm run test:spout-build
```

The helper writes `build/cuedeck_spout_gpu.dll` and a local build manifest. Packaging verifies the DLL's architecture, hashes and source inputs. It also checks the SDK fingerprint against the official commit archive; a directory name alone cannot establish its origin. Missing or stale native files stop packaging. Keep `SPOUT2_ROOT` set when packaging Windows.

The DLL and [Spout2 license](../spout-receiver/third-party-notes/SPOUT2-LICENSE.txt) are bundled under `resources/spout`. No Spout installation is needed on an end user's computer.

## Checks and remaining work

The Windows x64 candidate was tested on Shuttle / Intel UHD 630 with Electron 44.7.2 and the independent [native receiver](../spout-receiver/README.md). Checks covered four-corner colors/orientation, blackout/return, three off/on cycles, looping H.264 video, OMT takeover and a windowed audience takeover. Raw evidence and limitations are in `../../generated/spout-windows-20261102/` (local).

One offscreen audience renderer now feeds both Spout and a display-only physical GPU window. The display uses no additional media decoder. A 600-second Windows H.264 run, static resize, output restarts, PPTX video and stream takeover were tested; evidence and scoped limits are in `../../generated/spout-stability-20261103/` (local).

There is no sound in the local GPU output. OMT Audience and a stream take priority; restart Spout explicitly after the conflict ends. Real second-display/fullscreen, multiple-GPU machines and Windows Resolume/OBS still need testing.

macOS packages include architecture-specific Syphon native resources. An installed arm64 Electron 44 candidate was tested with Arena; x64 native selftests under Rosetta do not establish Intel hardware compatibility.
