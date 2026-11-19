import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { powerpointWindowsVersion } from './powerpoint-windows.js'

export async function powerpointVersion(): Promise<string | null> {
  if (process.platform === 'win32') return powerpointWindowsVersion()
  const appPath = '/Applications/Microsoft PowerPoint.app'
  if (process.platform !== 'darwin' || !existsSync(appPath)) return null
  return new Promise((resolve) => {
    const child = spawn('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents/Info.plist')])
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() || null : null))
  })
}
