import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {} }))
import { StateStore } from '../src/main/state'
import { defaultSpeakerTimerStyle } from '../src/shared/speaker-timer-style'

it('resets the speaker timer appearance through the real IPC handler, preserving countdown and hall timer', () => {
  const store = new StateStore()
  store.patch({ timerPosition: 'free', timerScale: 2.5, timerFree: { x: .2, y: .8 }, timerFont: 'serif', timerColor: '#123456', timerWarnColors: false })
  store.patchTimer({ durationMs: 123000, elapsedMs: 45000, running: true, startedAt: 123 })
  const before = store.get()
  const text = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
  const source = text.slice(text.indexOf("  ipcMain.handle('timer:reset-style',"), text.indexOf("  ipcMain.handle('timer:set-position',"))
  let handler!: (event: unknown) => void
  const persist = Object.fromEntries(['Position', 'Scale', 'Free', 'Font', 'Color', 'WarnColors'].map(k => ['setTimer' + k, vi.fn()]))
  runInNewContext(ts.transpile(source), { ipcMain: { handle: (_: string, fn: typeof handler) => { handler = fn } }, store, defaultSpeakerTimerStyle, requireOperator: vi.fn(), ...persist })
  handler({})
  expect(store.get()).toMatchObject(defaultSpeakerTimerStyle())
  expect(store.get().timer).toBe(before.timer)
  expect(store.get().audienceTimer).toBe(before.audienceTimer)
  expect(store.get().timerMode).toBe(before.timerMode)
  for (const fn of Object.values(persist)) expect(fn).toHaveBeenCalledOnce()
})
