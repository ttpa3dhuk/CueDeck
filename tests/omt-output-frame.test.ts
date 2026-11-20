import type { NativeImage } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { registerOmtIpc } from '../src/main/omt/outputs'
import type { OmtSettings } from '../src/shared/types'

type Configure = (event: unknown, settings: Partial<OmtSettings>) => Promise<unknown>

const fixture = vi.hoisted(() => ({
  configure: null as Configure | null,
  push: null as ((image: NativeImage) => void) | null,
  encoded: [] as number[],
  sent: [] as number[],
}))

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  ipcMain: { handle: (_channel: string, configure: Configure) => { fixture.configure = configure } },
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../src/main/windows.js', () => ({ createTimerOverlayWindow: vi.fn() }))
vi.mock('../src/main/state.js', async () => {
  const { DEFAULT_OMT_SETTINGS, OMT_OUTPUT_OFF } = await import('../src/shared/types')
  return {
    store: {
      get: () => ({
        omt: {
          ...DEFAULT_OMT_SETTINGS, available: null, error: null,
          outputs: { timer: OMT_OUTPUT_OFF, program: OMT_OUTPUT_OFF, prompter: OMT_OUTPUT_OFF },
        },
      }),
      patch: vi.fn(),
    },
  }
})
vi.mock('../src/main/display-mapping.js', async () => {
  const { DEFAULT_OMT_SETTINGS } = await import('../src/shared/types')
  return {
    getOmtSettings: () => DEFAULT_OMT_SETTINGS,
    setOmtSettings: vi.fn(),
    cleanOmtFps: (value: number) => value,
    cleanOmtName: (value: string) => value,
    cleanOmtResolution: (value: number) => value,
  }
})
vi.mock('../src/main/network-output-source.js', () => ({
  acquireNetworkVideo: (_role: string, _fps: number, push: (image: NativeImage) => void) => {
    fixture.push = push
    return { release: () => { fixture.push = null } }
  },
  acquireProgramAudio: vi.fn(),
}))
vi.mock('../src/main/omt/libomt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/omt/libomt')>(),
  loadOmt: () => ({
    sendCreate: () => ({}),
    sendSetInfo: vi.fn(),
    sendGetAddress: () => 0,
    sendConnections: () => 0,
    sendGetTally: vi.fn(),
    sendDestroy: vi.fn(),
    vmxCreate: () => ({ pixel: 0 }),
    vmxDestroy: vi.fn(),
    vmxEncodeBGRX: {
      async: (vmx: { pixel: number }, data: Buffer, _stride: number, _flags: number, done: (error: null, result: number) => void) => {
        fixture.encoded.push(data[0])
        setTimeout(() => {
          vmx.pixel = data[0]
          done(null, 0)
        }, 5)
      },
    },
    vmxSaveTo: (vmx: { pixel: number }, buffer: Buffer) => {
      buffer[0] = vmx.pixel
      return 1
    },
    send: {
      async: (_inst: unknown, frame: { Data: Buffer }, done: (error: null) => void) => {
        fixture.sent.push(frame.Data[0])
        done(null)
      },
    },
  }),
}))

function frame(pixel: number): NativeImage {
  return {
    getSize: () => ({ width: 32, height: 18 }),
    isEmpty: () => false,
    toBitmap: () => Buffer.alloc(32 * 18 * 4, pixel),
  } as NativeImage
}

afterEach(() => vi.useRealTimers())

it('keeps sending the last static frame after a burst between OMT output ticks', async () => {
  vi.useFakeTimers()
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const fps = { timer: 25, program: 25, prompter: 25 } as const
  const configure = fixture.configure!
  await configure(null, { enabled, fps, programAudio: false })
  try {
    vi.advanceTimersByTime(81)
    fixture.push!(frame(11))
    vi.advanceTimersByTime(3)
    fixture.push!(frame(22))
    vi.advanceTimersByTime(3)
    fixture.push!(frame(33))

    // A static slide emits no more compositor events after its final paint.
    vi.advanceTimersByTime(115)
    expect(fixture.encoded).toEqual([33])
    expect(fixture.sent).toEqual([33, 33])
  } finally {
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})
