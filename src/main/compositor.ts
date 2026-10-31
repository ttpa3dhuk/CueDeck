type CommandLine = {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value: string): void
}

/** Avoid blocking the shared GPU thread in the Windows root swap chain. */
export function configureCompositor(platform: string, commandLine: CommandLine): void {
  if (platform !== 'win32') return
  const enabled = commandLine.getSwitchValue('enable-features')
  const disabled = commandLine.getSwitchValue('disable-features')
  const hasBufferQueue = (list: string): boolean => list.split(',').some(
    feature => /^BufferQueue(?:[<:]|$)/.test(feature.trim()),
  )
  // Keep explicit troubleshooting overrides and unrelated Chromium features.
  if (hasBufferQueue(enabled) || hasBufferQueue(disabled)) return
  // Chromium 152: replace the primary-plane DXGI swap chain with BufferQueue.
  // D3D11 video decoding and DirectComposition remain hardware accelerated.
  commandLine.appendSwitch('enable-features', [enabled, 'BufferQueue'].filter(Boolean).join(','))
}
