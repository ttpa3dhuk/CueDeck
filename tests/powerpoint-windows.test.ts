import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PowerpointExportError } from '../src/main/powerpoint-error'
import { exportPowerpointWindows, powerpointWindowsVersion, runPowerpointPowerShell, windowsPowerpointExportScript } from '../src/main/powerpoint-windows'
import { powerpointCacheSha } from '../src/main/powerpoint-static'

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  mock.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => { vi.useRealTimers() })
function reply(value: unknown) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(value)))
  child.emit('close', 0)
}

it('encodes Unicode/apostrophes as data, without interpolating source paths as PowerShell', () => {
  const source = "C:\\Decks\\Михеев ' $(exit 3).pptx"
  const output = 'C:\\cache\\кадры.pdf'
  const script = windowsPowerpointExportScript(source, output)
  expect(script).not.toContain(source)
  const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1]
  expect(JSON.parse(Buffer.from(payload!, 'base64').toString('utf8'))).toEqual({ source, output })
})

it('detects Windows PowerPoint version without creating a COM application', async () => {
  const result = powerpointWindowsVersion()
  const args = mock.spawn.mock.calls[0][1] as string[]
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
  expect(script).not.toContain('New-Object -ComObject')
  expect(args).toContain('-STA')
  expect(args).not.toContain('-ExecutionPolicy')
  reply({ path: 'C:\\Office\\POWERPNT.EXE', version: '16.0.17932.21056' })
  await expect(result).resolves.toBe('16.0.17932.21056')
})

it('does not start automation after an already-aborted request', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(exportPowerpointWindows('source', 'output', controller.signal)).rejects.toMatchObject({ uncertain: false })
  expect(mock.spawn).not.toHaveBeenCalled()
})

it('waits for in-flight COM cleanup on cancellation, then rejects without killing the client', async () => {
  const controller = new AbortController()
  const result = exportPowerpointWindows('source', 'output', controller.signal)
  let done = false
  void result.catch(() => { done = true })
  controller.abort()
  await Promise.resolve()
  expect(done).toBe(false)
  expect(child.kill).not.toHaveBeenCalled()
  reply({ ok: true, cleanupConfirmed: true })
  await expect(result).rejects.toMatchObject({ uncertain: false })
})

it('marks a timed-out COM call uncertain, leaving its client alive to close its own deck', async () => {
  vi.useFakeTimers()
  const result = runPowerpointPowerShell('test', 30)
  const rejection = expect(result).rejects.toMatchObject({ uncertain: true })
  await vi.advanceTimersByTimeAsync(31)
  await rejection
  expect(child.kill).not.toHaveBeenCalled()
  reply({ ok: true, cleanupConfirmed: true })
})

it('distinguishes a confirmed export failure from an unconfirmed document close', async () => {
  const failed = exportPowerpointWindows('source', 'output')
  reply({ ok: false, error: 'Export failed', cleanupConfirmed: true })
  await expect(failed).rejects.toMatchObject({ uncertain: false })
  const unclosed = exportPowerpointWindows('source', 'output')
  reply({ ok: true, cleanupConfirmed: false, cleanupError: 'RPC disconnected' })
  await expect(unclosed).rejects.toMatchObject({ uncertain: true })
})

it('treats an invalid or missing reply as uncertain and never claims success', async () => {
  const result = exportPowerpointWindows('source', 'output')
  child.stdout.emit('data', Buffer.from('unexpected text')); child.emit('close', 0)
  await expect(result).rejects.toBeInstanceOf(PowerpointExportError)
  const missing = exportPowerpointWindows('source', 'output')
  reply(null)
  await expect(missing).rejects.toMatchObject({ uncertain: true })
})

it('separates Windows and Mac rendering for an identical source and Office version', () => {
  const sha = 'b'.repeat(40)
  expect(powerpointCacheSha(sha, '16.0', 'win32')).not.toBe(powerpointCacheSha(sha, '16.0', 'darwin'))
})
