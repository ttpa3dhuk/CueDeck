import { win32 } from 'node:path'

/** Prefer the app's runtime, then an explicitly installed NDI runtime. */
export function ndiRuntimeDirectories(
  bundled: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const installed = [env.NDI_RUNTIME_DIR_V6, env.NDI_RUNTIME_DIR_V5, env.NDI_RUNTIME_DIR_V4]
  if (platform === 'darwin') installed.push('/usr/local/lib')
  if (platform === 'win32' && env.ProgramFiles) {
    installed.push(win32.join(env.ProgramFiles, 'NDI', 'NDI 6 Runtime'), win32.join(env.ProgramFiles, 'NDI', 'NDI 5 Runtime'))
  }
  return [...new Set([bundled, ...installed.filter((p): p is string => !!p)])]
}
