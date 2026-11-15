import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
const exec = promisify(execFile)
export type IdentityRunner = (file: string, args: string[]) => Promise<string>
const run: IdentityRunner = async (file, args) => {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const executable = process.platform === 'win32' && file === 'powershell.exe' ? join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.platform === 'win32' && file === 'reg.exe' ? join(root, 'System32/reg.exe') : file
  return (await exec(executable, args, { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' })).stdout
}

function uuid(text: string): string | null {
  const value = text.match(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/i)?.[0]?.toLowerCase()
  return value && !/^(?:0|-)+$/.test(value) && !/^(?:f|-)+$/.test(value) ? value : null
}
/** Raw identifiers stay in memory. Neither a hostname, username nor a random profile ID is used. */
export async function machineIdentity(platform: NodeJS.Platform = process.platform, execute: IdentityRunner = run): Promise<string> {
  if (platform === 'win32') {
    try {
      const value = uuid(await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID']))
      if (value) return 'hardware:' + value
    } catch { /* Some firmware does not provide a usable SMBIOS UUID. */ }
    const fallback = uuid(await execute('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']))
    if (fallback) return 'windows-installation:' + fallback
  } else if (platform === 'darwin') {
    const result = await execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const value = uuid(result.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? '')
    if (value) return 'hardware:' + value
  }
  throw Error('cloudpub-machine-identity')
}
