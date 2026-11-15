import { posix, win32 } from 'node:path'
export function cloudpubConfigPaths(platform: NodeJS.Platform, home: string, appData?: string): string[] {
  if (platform === 'win32') return [win32.join(appData ?? win32.join(home, 'AppData', 'Roaming'), 'cloudpub', 'client.toml')]
  if (platform === 'darwin') return [posix.join(home, 'Library/Application Support/cloudpub/client.toml'), posix.join(home, '.config/cloudpub/client.toml')]
  return [posix.join(home, '.config/cloudpub/client.toml')]
}
export function cloudpubAppPaths(platform: NodeJS.Platform, home: string, preferred?: string): string[] {
  if (platform !== 'darwin') return preferred ? [preferred] : []
  const bundles = [preferred, ...['/Applications', posix.join(home, 'Applications')].flatMap(dir => ['CloudPub.app', 'Cloudpub.app', 'cloudpub.app'].map(name => posix.join(dir, name)))].filter((p): p is string => Boolean(p))
  return [...bundles.flatMap(p => p.endsWith('.app') ? ['cloudpub', 'clo'].map(name => posix.join(p, 'Contents/MacOS', name)) : [p]), '/opt/homebrew/bin/clo', '/usr/local/bin/clo', '/opt/homebrew/bin/cloudpub', '/usr/local/bin/cloudpub']
}
