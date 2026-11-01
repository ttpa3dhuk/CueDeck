# Third-party notices

## Syphon Framework

This prototype builds and links the official Syphon Framework from source:

- Project: https://github.com/Syphon/Syphon-Framework
- Source revision: `f4761677a45b8034a3c2069ec0f3d2553da81fba` (2026-09-21)
- Source archive: https://codeload.github.com/Syphon/Syphon-Framework/tar.gz/f4761677a45b8034a3c2069ec0f3d2553da81fba
- Source archive SHA-256: `a3766088c46588c42b087f4e5ff7ae7bb0f83292af59a0aeb8bba69eba5311c5`
- License: BSD 3-Clause, Copyright 2010-2023 Tom Butterworth, Anton Marini,
  Maxime Touroute and Philippe Chaurand. The full text is kept in
  `Syphon-LICENSE.txt` and copied into the built framework's Resources.

The public Syphon SDK 5 release was also inspected but is not used:

- https://github.com/Syphon/Syphon-Framework/releases/tag/5
- `Syphon.SDK.5.zip` SHA-256: `8a8993da2d39f84b7fbd9ad0071a8f300e947635a52c6c5a521c88df5ccb882f`
- Reason rejected: its `Syphon` binary is x86_64-only and it predates the
  Metal server. This Mac is arm64; Rosetta is not a suitable base for a new
  output path.

The local build applies one narrowly scoped patch to the official
`SyphonServerRendererMetal.m`: the renderer compiles its official bundled
Metal shader source at runtime instead of loading a precompiled
`default.metallib`. This is necessary because the installed Xcode 27.2 does
not have Apple's optional Metal command-line toolchain component. It does not
change Syphon's public API or the Metal/IOSurface transport.

This prototype does not redistribute the Syphon source or binary. The build
script downloads the immutable commit archive above into the ignored `vendor/`
directory; the extracted root is `Syphon-Framework-<commit>`. It never follows
`refs/heads/main`.
