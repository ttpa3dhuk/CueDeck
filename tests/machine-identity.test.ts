import { describe, expect, it, vi } from 'vitest'
import { machineIdentity } from '../src/main/machine-identity'
import { clickerComputerName } from '../src/main/cloudpub'
import { cloudpubAppPaths, cloudpubConfigPaths } from '../src/main/cloudpub-paths'
const id = '12345678-1234-5678-9012-123456789abc'
describe('stable machine identity on Windows and macOS', () => {
  it('uses the Windows hardware UUID deterministically without a hostname or profile seed', async () => {
    const run = vi.fn(async () => id.toUpperCase() + '\r\n')
    const first = await machineIdentity('win32', run)
    expect(clickerComputerName(first)).toBe(clickerComputerName(await machineIdentity('win32', run)))
    expect(first).toBe('hardware:' + id)
    expect(run.mock.calls).toHaveLength(2)
  })
  it('uses Windows MachineGuid only if firmware has no usable UUID', async () => {
    const run = vi.fn(async (file: string) => file === 'powershell.exe' ? '00000000-0000-0000-0000-000000000000' : 'MachineGuid REG_SZ ' + id)
    expect(await machineIdentity('win32', run)).toBe('windows-installation:' + id)
  })
  it('reads only IOPlatformUUID on macOS and normalizes case across launches', async () => {
    const run = vi.fn(async () => '"OtherUUID" = "ffffffff-ffff-ffff-ffff-ffffffffffff"\n"IOPlatformUUID" = "' + id.toUpperCase() + '"')
    expect(await machineIdentity('darwin', run)).toBe('hardware:' + id)
    expect(run).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
  })
  it('fails instead of silently generating a different random computer code', async () => {
    await expect(machineIdentity('darwin', async () => 'no UUID')).rejects.toThrow('cloudpub-machine-identity')
  })
  it('finds macOS app bundles, Homebrew CLI and both supported config locations', () => {
    expect(cloudpubAppPaths('darwin', '/Users/test')).toContain('/Applications/CloudPub.app/Contents/MacOS/cloudpub')
    expect(cloudpubAppPaths('darwin', '/Users/test')).toContain('/opt/homebrew/bin/clo')
    expect(cloudpubAppPaths('darwin', '/Users/test', '/Custom/cloudpub.app')).toContain('/Custom/cloudpub.app/Contents/MacOS/cloudpub')
    expect(cloudpubConfigPaths('darwin', '/Users/test')).toEqual(['/Users/test/Library/Application Support/cloudpub/client.toml', '/Users/test/.config/cloudpub/client.toml'])
    expect(cloudpubConfigPaths('win32', 'C:\\Users\\test', 'C:\\Roaming')).toEqual(['C:\\Roaming\\cloudpub\\client.toml'])
  })
})
