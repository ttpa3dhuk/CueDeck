# CueDeck Spout Receiver (Windows test utility)

Small native D3D11 receiver for the Shuttle: receives a Spout sender on the
GPU, draws it through a full-screen triangle, and shows the sender/size/format/
fps/frame/error counters in the window title. No Resolume, OBS, Electron,
browser are used. Optional `--sample` reads four pixels every half second for
QA; leave it off for performance measurements.

## Status

**Cross-compiled for Windows x64 on 2026-11-01.** Codex reused the existing
Zig/MinGW toolchain on the Mac. The result is a Windows GUI executable; imports
are Windows system DLLs, with no extra C++ runtime DLL. Build records and the
test package are in `../../generated/spout-receiver-20261101/`.

**Ran on Shuttle / Intel UHD 630 on 2026-11-02**, receiving the real CueDeck
audience through Spout. Four-corner colors/orientation, blackout/return,
three same-name reconnects and changing H.264 video samples passed. Raw results
are in `../../generated/spout-windows-20261102/` (local). Other adapters,
resize and multiple-GPU configurations still need testing.
MinGW needs SSSE3 enabled for SpoutCopy.cpp, the D3DCOMPILER_47 import library
and explicit Windows GUI subsystem; CMake supplies these options. The original
VS2022 build remains available below.

## Build (Windows, VS 2022)

1. Obtain official Spout2 source at pinned commit
   `6b68a5b4fdeca6130b851e5f9366467a844860e5` (release `2.007.018`), BSD-2.
   Do not use a random wrapper/fork.
2. From a VS2022 x64 developer prompt:

```bat
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 ^
  -DSPOUT2_ROOT=C:\src\Spout2
cmake --build build --config Release
```

3. Run `CueDeckSpoutReceiver.exe` (optionally `--sender "CueDeck ..."`).
   Esc closes. Counters: sender, width×height, format, fps, frames, errors,
   device adapter. Sender loss/reconnect is reported by SpoutDX and the receiver
   keeps polling; a different sender resets the SRV.

Optional QA flags: `--report <file.jsonl>`, `--sample`, `--seconds <n>`.
The report distinguishes draw count from sender frame counting. Spout's frame
counter can be disabled globally; then `IsFrameNew` does not prove a new sender
frame and the window's draw fps must not be reported as sender cadence.

## GPU path / honesty

- `spoutDX::ReceiveTexture()` copies the sender texturing into its own D3D11
  texture on the GPU (`CopyResource` inside SpoutDX). The receiver then samples
  that texture to its swap chain. This is **GPU→GPU copy + draw**, not
  zero-copy.
- The integrated sender is in [spout-sender](../spout-sender/README.md).
  The older `SpoutSenderAdapter` remains an unused standalone adapter.
- The normal receiver path has no CPU pixel buffer. `--sample` deliberately
  uses a tiny staging texture for four QA pixels, separate from CueDeck's
  publication path. `ReceiveImage` is not used.
- No binaries or Spout source are committed. Keep `SPOUT2_ROOT` outside git or
  in ignored vendor.

## Attribution

Spout2 is BSD-2-Clause, Copyright (c) 2020, Lynn Jarvis. The receiver source is
CueDeck code; see `third-party-notes/SPOUT2.md`. The official receiver example
is LGPL-3 and was consulted for API shape only; this file is an independent
implementation.
