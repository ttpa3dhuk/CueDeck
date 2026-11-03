import { isAbsolute, join, resolve } from 'node:path'
import { release } from 'node:os'

/** The native Syphon bundle targets macOS 13 (Darwin 22) and later. */
export function macSyphonSupported(kernelRelease = release()): boolean {
  return Number(kernelRelease.split('.')[0]) >= 22
}

/** Native paths are main-process configuration, never renderer input. */
export function localGpuNativePath(
  platform: NodeJS.Platform,
  packaged: boolean,
  appPath: string,
  resourcesPath: string,
  env: NodeJS.ProcessEnv,
): string {
  // Packaged Windows uses the bundled DLL; development overrides cannot replace it.
  if (packaged && platform === 'win32') return join(resourcesPath, 'spout', 'cuedeck_spout_gpu.dll')
  if (packaged && platform === 'darwin') return join(resourcesPath, 'syphon', 'libcuedeck_syphon_gpu.dylib')
  const configured = platform === 'win32' ? env.CUEDECK_SPOUT_GPU_NATIVE : env.CUEDECK_SYPHON_GPU_NATIVE
  if (configured) return isAbsolute(configured) ? configured : resolve(appPath, configured)
  return platform === 'win32'
    ? join(appPath, 'native', 'spout-sender', 'build', 'cuedeck_spout_gpu.dll')
    : join(appPath, 'native', 'syphon-probe', 'build', 'libcuedeck_syphon_gpu.dylib')
}
