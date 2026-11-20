import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { store } from '../state.js'
import {
  NDI_OUTPUTS,
  NDI_OUTPUT_OFF,
  type NdiOutputId,
  type NdiFps,
  type NdiOutputStatus,
  type NdiResolution,
  type NdiSettings,
  type NdiStatus,
} from '../../shared/types.js'
import { cleanNdiFps, cleanNdiName, cleanNdiResolution, getNdiSettings, setNdiSettings } from '../display-mapping.js'
import { acquireNetworkVideo, acquireProgramVideo, acquireProgramAudio, markProgramTransition } from '../network-output-source.js'
import { isProgramTransition } from '../program-playout.js'
import { NetworkTimerOutput } from '../network-timer-output.js'
import { loadNdi, ndiLoadError, type NdiLib } from './libndi.js'
import { NdiSender } from './sender.js'

interface Output {
  readonly sender: NdiSender
  start(): void
  stop(): Promise<void>
  /** Частота меняется на лету: источник в сети не пропадает. */
  setFps(fps: NdiFps): void
}

class WindowOutput implements Output {
  private video: { release(): void } | null = null
  private releaseAudio: (() => void) | null = null
  private releaseCuts: (() => void) | null = null

  constructor(
    readonly sender: NdiSender,
    private readonly role: 'audience' | 'speaker',
  ) {}

  start(): void {
    this.sender.start()
    if (this.role === 'audience') {
      const lease = acquireProgramVideo(this.sender.fps, this.sender.size)
      this.sender.setProgramCursor(lease.cursor)
      this.video = lease
      let before = store.get()
      this.releaseCuts = store.onChange((state, patch) => {
        if (isProgramTransition(patch, before)) markProgramTransition()
        before = state
      })
    } else this.video = this.acquireVideo(this.sender.fps)
  }

  private acquireVideo(fps: NdiFps): ReturnType<typeof acquireNetworkVideo> {
    return acquireNetworkVideo(this.role, fps, (image) => this.sender.push(image), this.sender.size)
  }

  setFps(fps: NdiFps): void {
    if (this.sender.fps === fps) return
    if (this.role === 'audience') { this.sender.setFps(fps); return }
    const next = this.acquireVideo(fps)
    this.video?.release()
    this.video = next
    this.sender.setFps(fps)
  }

  setAudio(enabled: boolean): void {
    if (this.role !== 'audience') return
    if (enabled && !this.releaseAudio) {
      this.releaseAudio = acquireProgramAudio((chunk) => this.sender.pushAudio(chunk))
    } else if (!enabled && this.releaseAudio) {
      this.releaseAudio()
      this.releaseAudio = null
    }
  }

  stop(): Promise<void> {
    this.setAudio(false)
    this.video?.release()
    this.video = null
    this.releaseCuts?.()
    this.releaseCuts = null
    this.sender.setProgramCursor(null)
    return this.sender.stop()
  }
}

const outputs = new Map<NdiOutputId, Output>()
let status: NdiStatus = store.get().ndi
// Перенастройки идут по очереди: остановка ждёт кадр в работе.
let chain: Promise<unknown> = Promise.resolve()
let shutdown: Promise<void> | null = null

function publish(patch: Partial<NdiStatus>): void {
  status = { ...status, ...patch }
  store.patch({ ndi: status })
}

/** Настроечная часть статуса (копии, чтобы не делить объекты с файлом настроек). */
function settingsPatch(v: NdiSettings): Partial<NdiStatus> {
  return {
    enabled: { ...v.enabled },
    names: { ...v.names },
    sizes: { ...v.sizes },
    fps: { ...v.fps },
    programAudio: v.programAudio,
    timerMessage: v.timerMessage,
  }
}

function publishOutput(id: NdiOutputId, patch: Partial<NdiOutputStatus>): void {
  publish({ outputs: { ...status.outputs, [id]: { ...status.outputs[id], ...patch } } })
}

function makeOutput(lib: NdiLib, id: NdiOutputId, name: string, size: NdiResolution, fps: NdiFps): Output {
  const onStatus = (s: Partial<NdiOutputStatus>): void => {
    if (outputs.get(id) !== out) return
    if (s.state !== 'error') {
      publishOutput(id, s)
      return
    }
    publishOutput(id, { ...NDI_OUTPUT_OFF, ...s })
    // The sender releases its native handle. Also release the capture and
    // overlay, then allow a future configure request to retry the output.
    chain = chain.then(async () => {
      if (outputs.get(id) !== out) return
      outputs.delete(id)
      await out.stop()
    }).catch((error) => log.warn('ndi: failed output cleanup', error))
  }
  const out: Output =
    id === 'timer'
      ? new NetworkTimerOutput('ndi', new NdiSender(lib, name, size, fps, true, onStatus))
      : new WindowOutput(new NdiSender(lib, name, size, fps, false, onStatus), id === 'program' ? 'audience' : 'speaker')
  return out
}

async function apply(next: NdiSettings): Promise<NdiStatus> {
  // Сначала гасим лишнее, переименованное (новое имя = новый источник в сети)
  // и с другим разрешением (окно — под размер).
  for (const id of NDI_OUTPUTS) {
    const out = outputs.get(id)
    if (out && (!next.enabled[id] || out.sender.name !== next.names[id] || out.sender.size !== next.sizes[id])) {
      outputs.delete(id)
      await out.stop()
    }
    if (!next.enabled[id] && status.outputs[id].state !== 'off') publishOutput(id, NDI_OUTPUT_OFF)
  }
  publish(settingsPatch(next))

  const failed = new Set<NdiOutputId>()
  for (const [id, out] of outputs) {
    try {
      out.setFps(next.fps[id])
      if (out instanceof WindowOutput) out.setAudio(next.programAudio)
    } catch (error) {
      failed.add(id)
      await failOutput(id, out, error)
    }
  }
  const wanted = NDI_OUTPUTS.filter((id) => next.enabled[id] && !outputs.has(id) && !failed.has(id))
  if (wanted.length === 0) return status
  const lib = loadNdi()
  if (!lib) {
    const error = ndiLoadError()
    publish({ available: false, error })
    for (const id of wanted) publishOutput(id, { state: 'error', error })
    return status
  }
  publish({ available: true, error: null })
  for (const id of wanted) {
    const out = makeOutput(lib, id, next.names[id], next.sizes[id], next.fps[id])
    try {
      outputs.set(id, out)
      out.start()
      if (out instanceof WindowOutput) out.setAudio(id === 'program' && next.programAudio)
      publishOutput(id, { ...NDI_OUTPUT_OFF, state: 'on', address: out.sender.address })
    } catch (error) {
      await failOutput(id, out, error)
    }
  }
  return status
}

async function failOutput(id: NdiOutputId, out: Output, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  log.warn(`ndi: выход ${id} — ${message}`)
  outputs.delete(id)
  await out.stop()
  publishOutput(id, { ...NDI_OUTPUT_OFF, state: 'error', error: message })
}

/** Пришедшее из окна «Настройки» → чистые настройки; имена разные (иначе два источника с одним именем). */
function sanitize(v: Partial<NdiSettings>): NdiSettings {
  const cur = getNdiSettings()
  const out: NdiSettings = {
    enabled: { ...cur.enabled },
    names: { ...cur.names },
    sizes: { ...cur.sizes },
    fps: { ...cur.fps },
    programAudio: v.programAudio === undefined ? cur.programAudio : v.programAudio === true,
    timerMessage: v.timerMessage === undefined ? cur.timerMessage : v.timerMessage === true,
  }
  const used = new Set<string>()
  for (const id of NDI_OUTPUTS) {
    if (v.enabled?.[id] !== undefined) out.enabled[id] = v.enabled[id] === true
    if (v.sizes?.[id] !== undefined) out.sizes[id] = cleanNdiResolution(Number(v.sizes[id]), cur.sizes[id])
    if (v.fps?.[id] !== undefined) out.fps[id] = cleanNdiFps(Number(v.fps[id]), cur.fps[id])
    const base = cleanNdiName(v.names?.[id] ?? cur.names[id], cur.names[id])
    let name = base
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${base} (${suffix})`
    used.add(name.toLowerCase())
    out.names[id] = name
  }
  return out
}

/** Поднять выходы по сохранённым настройкам — после регистрации ipc. */
export function initNdi(): void {
  const s = getNdiSettings()
  // Библиотеку не грузим, пока выход не включён: кому NDI не нужен, тот её и не загружает.
  publish(settingsPatch(s))
  if (NDI_OUTPUTS.some((id) => s.enabled[id])) {
    chain = chain.then(() => apply(s)).catch((error) => log.warn('ndi: startup failed', error))
  }
  process.on('exit', () => {
    for (const out of outputs.values()) out.sender.destroyNow()
  })
}

export function shutdownNdi(): Promise<void> {
  shutdown ??= chain.then(async () => {
    await Promise.all([...outputs.values()].map((out) => out.stop()))
    outputs.clear()
  })
  return shutdown
}

export function registerNdiIpc(): void {
  ipcMain.handle('ndi:configure', async (_e, v: Partial<NdiSettings>) => {
    if (shutdown) return { ok: false, status }
    const run = chain.then(() => {
      if (shutdown) return status
      const next = sanitize(v ?? {})
      setNdiSettings(next)
      return apply(next)
    })
    chain = run.catch(() => undefined)
    return { ok: true, status: await run }
  })
}
