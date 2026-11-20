import type { NativeImage } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { registerOmtIpc } from '../src/main/omt/outputs'
import type { OmtSettings } from '../src/shared/types'
import log from 'electron-log/main'

type Configure = (event: unknown, settings: Partial<OmtSettings>) => Promise<unknown>

const fixture = vi.hoisted(() => ({
  configure: null as Configure | null,
  push: null as ((image: NativeImage) => void) | null,
  encoded: [] as number[],
  sent: [] as number[],
  holdSend: false,
  sendDone: [] as Array<(error: null) => void>,
  encodeDelay: 5,
  supersededOld: false,
  nextId: 0,
  sourceCount: 0, lastSourceCount: 0,
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
      onChange: () => () => {},
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
  acquireProgramVideo: () => {
    let pending: NativeImage | null = null
    fixture.lastSourceCount = fixture.sourceCount
    fixture.push = image => {
      pending = image
      fixture.sourceCount++
    }
    return {
      cursor: {
        epoch: 0,
        takeSourceCaptures: () => {
          const count = fixture.sourceCount - fixture.lastSourceCount
          fixture.lastSourceCount = fixture.sourceCount
          return count
        },
        cutIsDue: () => false,
        hasFreshCut: () => fixture.supersededOld && fixture.nextId <= 1,
        superseded: (id: number) => fixture.supersededOld && id === 1,
        next: () => {
          const image = pending
          pending = null
          return image ? { image, id: ++fixture.nextId, epoch: 0, cut: fixture.supersededOld } : null
        },
      },
      release: () => { fixture.push = null },
    }
  },
  acquireProgramAudio: vi.fn(),
  markProgramTransition: vi.fn(),
}))
vi.mock('../src/main/omt/libomt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/omt/libomt')>(),
  loadOmt: () => ({
    sendCreate: () => ({}),
    sendSetInfo: vi.fn(),
    sendGetAddress: () => 0,
    sendConnections: () => 2,
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
        }, fixture.encodeDelay)
      },
    },
    vmxSaveTo: (vmx: { pixel: number }, buffer: Buffer) => {
      buffer[0] = vmx.pixel
      return 1
    },
    send: {
      async: (_inst: unknown, frame: { Data: Buffer }, done: (error: null) => void) => {
        fixture.sent.push(frame.Data[0])
        if (fixture.holdSend) fixture.sendDone.push(done)
        else done(null)
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

it('logs accepted source captures even when encode selects fewer frames', async () => {
  vi.useFakeTimers()
  vi.mocked(log.info).mockClear()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
  fixture.sourceCount = fixture.lastSourceCount = 0; fixture.holdSend = false
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 30, program: 30, prompter: 30 }, programAudio: false })
  try {
    for (let id = 0; id < 30; id++) {
      fixture.push!(frame(id))
      vi.advanceTimersByTime(333)
    }
    vi.advanceTimersByTime(400)
    const row = vi.mocked(log.info).mock.calls.map(([message]) => String(message))
      .find(message => message.includes('кадров от источника'))
    expect(row).toMatch(/кадров от источника [1-9]/)
  } finally { await configure(null, { enabled: { ...enabled, program: false } }) }
})

it('keeps sending the last static frame after a burst between OMT output ticks', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
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

it('does not overwrite a prepared program frame while native send is busy', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
  fixture.holdSend = true
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 25, program: 25, prompter: 25 }, programAudio: false })
  try {
    vi.advanceTimersByTime(81)
    fixture.push!(frame(11))
    vi.advanceTimersByTime(48)
    expect(fixture.sent).toEqual([11])
    fixture.push!(frame(22))
    vi.advanceTimersByTime(40)
    fixture.push!(frame(33))
    vi.advanceTimersByTime(40)
    expect(fixture.encoded).toEqual([11, 22])
    fixture.holdSend = false
    fixture.sendDone.shift()!(null)
    vi.advanceTimersByTime(50)
    expect(fixture.encoded).toEqual([11, 22, 33])
    expect(fixture.sent.slice(0, 3)).toEqual([11, 22, 33])
  } finally {
    fixture.holdSend = false
    for (const done of fixture.sendDone.splice(0)) done(null)
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})

it('starts the next program encode after handing a fresh frame to native send', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
  fixture.holdSend = true
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 30, program: 30, prompter: 30 }, programAudio: false })
  try {
    fixture.push!(frame(11))
    for (let ms = 0; ms < 100 && fixture.encoded.length === 0; ms++) vi.advanceTimersByTime(1)
    expect(fixture.encoded).toEqual([11])
    fixture.push!(frame(22))
    for (let ms = 0; ms < 100 && fixture.sent.length === 0; ms++) vi.advanceTimersByTime(1)
    expect(fixture.sent).toEqual([11])
    // A native transport call is still in flight. VMX may work on the next
    // program frame without replacing the compressed frame held by send.
    vi.advanceTimersByTime(10)
    expect(fixture.encoded).toContain(22)
    expect(fixture.sent).toEqual([11])
  } finally {
    fixture.holdSend = false
    for (const done of fixture.sendDone.splice(0)) done(null)
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})

it('discards an old encode completion once a new scene frame is eligible', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 150; fixture.supersededOld = false; fixture.nextId = 0
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 25, program: 25, prompter: 25 }, programAudio: false })
  try {
    vi.advanceTimersByTime(81)
    fixture.push!(frame(11))
    vi.advanceTimersByTime(100)
    fixture.push!(frame(33))
    fixture.supersededOld = true
    vi.advanceTimersByTime(300)
    expect(fixture.encoded).toEqual([11, 33])
    expect(fixture.sent).not.toContain(11)
    expect(fixture.sent).toContain(33)
  } finally {
    fixture.encodeDelay = 5; fixture.supersededOld = false
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})

it('reserves a free program send slot while a new moving frame is encoding', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 25, program: 25, prompter: 25 }, programAudio: false })
  try {
    vi.advanceTimersByTime(81)
    fixture.push!(frame(11))
    vi.advanceTimersByTime(89) // t=170: first frame already sending as heartbeat.
    const before = fixture.sent.length
    expect(before).toBeGreaterThan(0)
    fixture.encodeDelay = 70
    fixture.push!(frame(22))
    vi.advanceTimersByTime(99) // t=269: VMX is still busy.
    expect(fixture.sent).toHaveLength(before)
    vi.advanceTimersByTime(11) // t=280: encoded frame is ready and submitted.
    expect(fixture.sent.at(-1)).toBe(22)
  } finally {
    fixture.encodeDelay = 5
    vi.advanceTimersByTime(200)
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})

it('keeps a bounded heartbeat if program encoding stalls unusually long', async () => {
  vi.useFakeTimers()
  fixture.encoded.length = fixture.sent.length = fixture.sendDone.length = 0
  fixture.encodeDelay = 5; fixture.supersededOld = false; fixture.nextId = 0
  registerOmtIpc()
  const enabled = { timer: false, program: true, prompter: false }
  const configure = fixture.configure!
  await configure(null, { enabled, fps: { timer: 25, program: 25, prompter: 25 }, programAudio: false })
  try {
    vi.advanceTimersByTime(81)
    fixture.push!(frame(11))
    vi.advanceTimersByTime(89)
    const before = fixture.sent.length
    fixture.encodeDelay = 500
    fixture.push!(frame(22))
    vi.advanceTimersByTime(179) // t=349, encode started at t=200.
    expect(fixture.sent).toHaveLength(before)
    vi.advanceTimersByTime(12) // t=361, watchdog may repeat the static current.
    expect(fixture.sent.length).toBeGreaterThan(before)
    expect(fixture.sent.at(-1)).toBe(11)
  } finally {
    vi.advanceTimersByTime(600)
    fixture.encodeDelay = 5
    await configure(null, { enabled: { ...enabled, program: false } })
  }
})
