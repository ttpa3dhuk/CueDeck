import { acquireFrameTap, type FrameTapLease } from '../frame-tap.js'
import { stopGpuAudienceForNormalOutput } from '../gpu-audience-arbiter.js'
/**
 * Выходы NDI — источники CueDeck в локальной сети (OBS, vMix, Wirecast и др.).
 *
 * - **Таймер** — скрытое offscreen-окно рисует страницу overlay
 *   (renderer/ndi-overlay) на прозрачном фоне; кадры приходят событием `paint`
 *   вместе с альфой (premultiplied, как отдаёт Chromium).
 * - **Зал / суфлёр** — подписка на кадры (`beginFrameSubscription`) того окна,
 *   что сейчас в раскладке. Нет такого окна (solo, «оператор + зал») — держим
 *   скрытое (acquireGhost в windows.ts, общее с трансляцией, монитором и OMT).
 *
 * В отличие от OMT (libvmx) свой кодек не нужен: NDI принимает сырой BGRA и
 * кодирует сам. Отдаём последний кадр по своему таймеру с частотой fps —
 * получателю нужен ровный поток, а кадры источника приходят только на изменения.
 * Вызов отправки выполняется через асинхронный FFI; одновременно в работе
 * один кадр, а ожидающий заменяется самым свежим.
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import log from 'electron-log/main'
import { store } from '../state.js'
import { t } from '../../shared/i18n.js'
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
import { allowAudienceCapture } from '../stream/streamer.js'
import {
  acquireGhost,
  createHiddenAudienceWindow,
  createHiddenSpeakerWindow,
  createNdiAudioWindow,
  createNdiOverlayWindow,
  getActiveWindows,
  releaseGhost,
} from '../windows.js'
import { loadNdi, ndiLoadError, type NdiLib } from './libndi.js'
import { NdiSender, type NdiAudioChunk } from './sender.js'

/** Ширина кадра 16:9 для разрешения выхода. */
function widthOf(res: NdiResolution): number {
  return Math.round((res * 16) / 9)
}

interface Output {
  readonly sender: NdiSender
  start(): void
  stop(): Promise<void>
  /** Частота меняется на лету: источник в сети не пропадает. */
  setFps(fps: NdiFps): void
}

/** Таймер: своё offscreen-окно на прозрачном фоне. */
class TimerOutput implements Output {
  private win: BrowserWindow | null = null

  constructor(readonly sender: NdiSender) {}

  start(): void {
    this.sender.start()
    // Electron 44 OSR uses the explicit 1x scale set by the window factory.
    const { size } = this.sender
    const win = createNdiOverlayWindow(widthOf(size), size)
    this.win = win
    win.webContents.setFrameRate(this.sender.fps)
    win.webContents.on('paint', (_e, _dirty, image) => this.sender.push(image))
  }

  setFps(fps: NdiFps): void {
    this.sender.setFps(fps)
    if (this.win && !this.win.isDestroyed()) this.win.webContents.setFrameRate(fps)
  }

  stop(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    return this.sender.stop()
  }
}

/**
 * Зал или суфлёр: кадры того окна роли, что сейчас есть. Окна пересоздаются
 * при смене раскладки и экранов — раз в полсекунды проверяем, на то ли окно
 * подписаны.
 */
class WindowOutput implements Output {
  private tap: FrameTapLease | null = null
  private win: BrowserWindow | null = null
  private watch: NodeJS.Timeout | null = null
  /** Окно звука (только у зала): снимает звук вкладки зала. */
  audioWin: BrowserWindow | null = null
  private readonly holder: string

  constructor(
    readonly sender: NdiSender,
    private readonly role: 'audience' | 'speaker',
  ) {
    this.holder = `ndi-${role}`
  }

  start(): void {
    this.sender.start()
    this.follow()
    this.watch = setInterval(() => this.follow(), 500)
  }

  setFps(fps: NdiFps): void {
    this.sender.setFps(fps)
  }

  /** Звук эфира (только у зала) — включается и выключается без перезапуска источника. */
  setAudio(on: boolean): void {
    if (this.role !== 'audience') return
    if (on && !this.audioWin) {
      const aw = createNdiAudioWindow()
      allowAudienceCapture(aw)
      this.audioWin = aw
      aw.on('closed', () => {
        if (this.audioWin === aw) this.audioWin = null
      })
      log.info(`ndi: «${this.sender.name}» со звуком`)
    } else if (!on && this.audioWin) {
      if (!this.audioWin.isDestroyed()) this.audioWin.destroy()
      this.audioWin = null
      log.info(`ndi: «${this.sender.name}» без звука`)
    }
  }

  private follow(): void {
    if (this.role === 'audience') stopGpuAudienceForNormalOutput('ndi')
    const real = getActiveWindows().get(this.role)
    let target: BrowserWindow
    if (real && !real.isDestroyed()) {
      releaseGhost(this.role, this.holder)
      target = real
    } else {
      target = acquireGhost(this.role, this.holder, () => this.createGhost())
    }
    if (target === this.win) return
    // A tab capture can remain alive but silent after its source window is
    // destroyed. Do not rely solely on the audio track's `ended` event.
    const restartAudio = this.audioWin !== null
    if (restartAudio) this.setAudio(false)
    this.unsubscribe()
    this.win = target
    const wc = target.webContents
    try {
      this.tap = acquireFrameTap(wc, this.holder, (image) => this.sender.push(image))
    } catch (error) {
      this.win = null
      if (restartAudio) this.setAudio(true)
      log.warn(`ndi: frame subscription failed: ${String(error)}`)
      return
    }
    // Кадры приходят только на изменения — первый, пока на экране статичный слайд, вызываем сами.
    const kick = (): void => {
      if (!target.isDestroyed()) wc.invalidate()
    }
    if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(kick, 300))
    else kick()
    if (restartAudio) this.setAudio(true)
    log.info(`ndi: «${this.sender.name}» снимает окно «${target.getTitle()}»`)
  }

  /**
   * Зал — ровно выбранное разрешение в пикселях (на Retina вдвое меньше в
   * точках): там только слайд во весь экран. Суфлёр — как настоящий, 1920×1080
   * точек: его вёрстка в пикселях CSS, в другом размере всё стало бы крупнее
   * или мельче; лишнее разрешение ужмёт push().
   */
  private createGhost(): BrowserWindow {
    if (this.role === 'speaker') return createHiddenSpeakerWindow()
    const sf = screen.getPrimaryDisplay().scaleFactor || 1
    const { size } = this.sender
    return createHiddenAudienceWindow(Math.round(widthOf(size) / sf), Math.round(size / sf))
  }

  private unsubscribe(): void {
    this.tap?.release()
    this.tap = null
    this.win = null
  }

  stop(): Promise<void> {
    if (this.watch) clearInterval(this.watch)
    this.watch = null
    this.unsubscribe()
    if (this.audioWin && !this.audioWin.isDestroyed()) this.audioWin.destroy()
    this.audioWin = null
    releaseGhost(this.role, this.holder)
    return this.sender.stop()
  }
}

const outputs = new Map<NdiOutputId, Output>()
let status: NdiStatus = store.get().ndi
// Перенастройки идут по очереди: остановка ждёт кадр в работе.
let chain: Promise<unknown> = Promise.resolve()

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
    if (outputs.get(id) === out) publishOutput(id, s)
  }
  const out: Output =
    id === 'timer'
      ? new TimerOutput(new NdiSender(lib, name, size, fps, true, onStatus))
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
      publishOutput(id, { ...NDI_OUTPUT_OFF })
    }
  }
  publish(settingsPatch(next))
  // Что меняется на лету — частота и звук — у работающих выходов.
  for (const [id, out] of outputs) {
    out.setFps(next.fps[id])
    if (out instanceof WindowOutput) out.setAudio(id === 'program' && next.programAudio)
  }
  const wanted = NDI_OUTPUTS.filter((id) => next.enabled[id] && !outputs.has(id))
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
    } catch (err) {
      const msg = (err as Error).message || String(err)
      log.warn(`ndi: выход ${id} не поднялся — ${msg}`)
      outputs.delete(id)
      void out.stop()
      publishOutput(id, { ...NDI_OUTPUT_OFF, state: 'error', error: msg })
    }
  }
  return status
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
    let name = cleanNdiName(v.names?.[id] ?? cur.names[id], cur.names[id])
    if (used.has(name.toLowerCase())) name = `${name} ${id}`
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
  if (NDI_OUTPUTS.some((id) => s.enabled[id])) chain = chain.then(() => apply(s))
  process.on('exit', () => {
    for (const out of outputs.values()) out.sender.destroyNow()
  })
}

export function registerNdiIpc(): void {
  // Звук зала — только от окна звука текущего выхода «Зал».
  ipcMain.on('ndi:audio', (e, chunk: NdiAudioChunk) => {
    const out = outputs.get('program')
    if (!(out instanceof WindowOutput) || !out.audioWin || out.audioWin.webContents !== e.sender) return
    if (!chunk || !(chunk.data instanceof Float32Array)) return
    out.sender.pushAudio(chunk)
  })
  ipcMain.handle('ndi:configure', async (_e, v: Partial<NdiSettings>) => {
    const run = chain.then(() => {
      const next = sanitize(v ?? {})
      setNdiSettings(next)
      return apply(next)
    })
    chain = run.catch(() => undefined)
    return { ok: true, status: await run }
  })
}
