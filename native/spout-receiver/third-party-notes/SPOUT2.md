# Spout2 attribution / pin

- Project: https://github.com/leadedge/Spout2
- Release/tag: `2.007.018`
- Commit: `6b68a5b4fdeca6130b851e5f9366467a844860e5`
- License: BSD-2-Clause, Copyright (c) 2020, Lynn Jarvis
- Source used for API/build shape: `SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.h`,
  `SpoutDX.cpp`; official Windows/Receiver example was inspected.
- No Spout source/binary is redistributed in this worktree. The build expects
  `SPOUT2_ROOT` from the pinned official source.

The official `WinSpoutDX.cpp` receiver example is LGPL-3; no code was copied
from it. The local receiver is an independent D3D11 swap-chain implementation
using the BSD-licensed SpoutDX API.
