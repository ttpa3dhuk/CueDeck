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
 * Отправка (`send_video_async_v2`) возвращается сразу, кодирование идёт в
 * потоках NDI, поэтому главный процесс не встаёт.
 */
import { BrowserWindow, ipcMain, screen, type NativeImage } from 'electron'
import os from 'node:os'
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
import { loadNdi, ndiLoadError, NDI_FOURCC_BGRA, NDI_FRAME_FORMAT_PROGRESSIVE, NDI_TIMECODE_SYNTHESIZE, type NdiLib } from './libndi.js'

/** Ширина кадра 16:9 для разрешения выхода. */
function widthOf(res: NdiResolution): number {
  return Math.round((res * 16) / 9)
}

/** Кадр, ещё не отданный: BGRA (у таймера альфа premultiplied). */
interface RawFrame {
  width: number
  height: number
  buf: Buffer
}

type StatusFn = (s: Partial<NdiOutputStatus>) => void

/** Кусок звука от окна звука NDI (renderer/ndi-audio): float по каналам подряд (planar). */
export interface NdiAudioChunk {
  sampleRate: number
  channels: number
  frames: number
  data: Float32Array
}

/** Полное имя источника в сети у получателя: «КОМПЬЮТЕР (имя)». */
function displayName(name: string): string {
  const host = os.hostname().replace(/\.local$/i, '')
  return `${host} (${name})`
}

/**
 * Отправитель NDI: принимает кадры, отдаёт последний с постоянной частотой;
 * следит за получателями и tally.
 */
class NdiSender {
  private inst: unknown = null
  /** Последний принятый кадр — уходит получателям с постоянной частотой. */
  private current: RawFrame | null = null
  /** Кадр, отправленный последним: держим ссылку, пока NDI его кодирует. */
  private lastSent: RawFrame | null = null
  private pump: NodeJS.Timeout | null = null
  private nextAt = 0
  private poll: NodeJS.Timeout | null = null
  private closing = false
  private onStopped: (() => void) | null = null
  /** Когда принят прошлый кадр от источника — чаще частоты выхода не берём. */
  private lastAcceptAt = 0
  private stats = { pushed: 0, sent: 0, since: 0 }
  private receivers = 0
  address: string | null = null

  constructor(
    private readonly lib: NdiLib,
    readonly name: string,
    readonly size: NdiResolution,
    /** Частота кадров; меняется на лету (setFps). */
    public fps: NdiFps,
    private readonly alpha: boolean,
    private readonly onStatus: StatusFn,
  ) {}

  start(): void {
    const { lib } = this
    this.inst = lib.sendCreate({ p_ndi_name: this.name, p_groups: null, clock_video: true, clock_audio: false })
    if (!this.inst) throw new Error(t('не удалось создать источник NDI'))
    this.address = displayName(this.name)

    this.nextAt = performance.now()
    this.tickPump()
    let lastKey = ''
    const tally = { on_program: false, on_preview: false }
    // Tally — 5 раз в секунду (лампа должна загораться сразу), число
    // получателей — раз в секунду.
    let tick = 0
    let receivers = 0
    this.poll = setInterval(() => {
      if (!this.inst) return
      if (tick++ % 5 === 0) receivers = lib.sendConnections(this.inst, 0) as number
      lib.sendGetTally(this.inst, tally, 0)
      const s = { receivers: Math.max(0, receivers), program: tally.on_program === true, preview: tally.on_preview === true }
      this.receivers = s.receivers
      this.logStats()
      const key = `${s.receivers}|${s.program}|${s.preview}`
      if (key !== lastKey) {
        lastKey = key
        log.info(`ndi: «${this.name}» получателей ${s.receivers}${s.program ? ', в эфире' : ''}${s.preview ? ', в превью' : ''}`)
        this.onStatus(s)
      }
    }, 200)
    log.info(`ndi: выход «${this.address}» запущен, ${this.size}p ${this.fps} к/с`)
  }

  /** Повтор последнего кадра с частотой fps. setInterval на 60 к/с давал бы 59 (округление до 17 мс). */
  private tickPump(): void {
    if (this.closing) return
    this.sendCurrent()
    const period = 1000 / this.fps
    this.nextAt += period
    const now = performance.now()
    // Проспали (нагрузка, сон ноутбука) — не догоняем пачкой, а встаём в шаг заново.
    if (this.nextAt < now - period) this.nextAt = now
    this.pump = setTimeout(() => this.tickPump(), Math.max(0, this.nextAt - now))
  }

  /** Раз в 10 с, пока кто-то смотрит: сколько кадров пришло от окна и отправлено. */
  private logStats(): void {
    const now = performance.now()
    if (!this.stats.since) this.stats.since = now
    const dt = (now - this.stats.since) / 1000
    if (dt < 10) return
    if (this.receivers > 0) {
      const st = this.stats
      log.info(
        `ndi: «${this.name}» за ${dt.toFixed(0)} с: кадров от источника ${(st.pushed / dt).toFixed(1)}/с, ` + // i18n-ok: журнал
          `отправлено ${(st.sent / dt).toFixed(1)}/с (цель ${this.fps})`, // i18n-ok: журнал
      )
    }
    this.stats = { pushed: 0, sent: 0, since: now }
  }

  setFps(fps: NdiFps): void {
    if (fps === this.fps) return
    this.fps = fps
    log.info(`ndi: «${this.name}» ${fps} к/с`)
  }

  /** Новый кадр от источника. Чаще частоты выхода — пропускаем (90% периода — запас на дрожь). */
  push(image: NativeImage): void {
    if (this.closing || image.isEmpty()) return
    const now = performance.now()
    if (now - this.lastAcceptAt < 900 / this.fps) return
    this.lastAcceptAt = now
    this.stats.pushed++
    const raw = this.toRaw(image)
    if (raw) this.current = raw
  }

  /** Байты кадра; шире выбранного разрешения (Retina, 4K-проектор) — ужимаем. */
  private toRaw(image: NativeImage): RawFrame | null {
    let img = image
    const maxWidth = widthOf(this.size)
    if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' })
    const { width, height } = img.getSize()
    if (width < 16 || height < 16) return null
    return { width, height, buf: img.toBitmap() }
  }

  private sendCurrent(): void {
    const f = this.current
    if (!f || !this.inst || this.closing) return
    const frame = {
      xres: f.width,
      yres: f.height,
      FourCC: NDI_FOURCC_BGRA,
      frame_rate_N: this.fps,
      frame_rate_D: 1,
      picture_aspect_ratio: f.width / f.height,
      frame_format_type: NDI_FRAME_FORMAT_PROGRESSIVE,
      timecode: NDI_TIMECODE_SYNTHESIZE,
      p_data: f.buf,
      line_stride_in_bytes: f.width * 4,
      p_metadata: null,
      timestamp: 0n,
    }
    // Возвращается сразу (кодирование — в потоках NDI). Буфер должен жить до
    // следующей отправки — держим ссылку; прошлую отпускаем только сейчас.
    this.lib.sendVideoAsync(this.inst, frame)
    this.lastSent = f
    this.stats.sent++
  }

  /**
   * Звук зала. Метки NDI синтезирует сам (NDI_TIMECODE_SYNTHESIZE) и сводит со
   * звуком видео; отдаём planar float (FLTP), каналы подряд.
   */
  pushAudio(chunk: NdiAudioChunk): void {
    if (!this.inst || this.closing) return
    const { sampleRate, channels, frames, data } = chunk
    if (!sampleRate || !channels || !frames || data.length < frames * channels) return
    const buf = Buffer.from(data.buffer, data.byteOffset, frames * channels * 4)
    this.lib.sendAudio(this.inst, {
      sample_rate: sampleRate,
      no_channels: channels,
      no_samples: frames,
      timecode: NDI_TIMECODE_SYNTHESIZE,
      p_data: buf,
      channel_stride_in_bytes: frames * 4,
      p_metadata: null,
      timestamp: 0n,
    })
  }

  /** Остановить: освободить отправителя. */
  stop(): Promise<void> {
    if (this.pump) clearTimeout(this.pump)
    if (this.poll) clearInterval(this.poll)
    this.pump = this.poll = null
    this.current = null
    this.closing = true
    return new Promise((resolve) => {
      this.onStopped = resolve
      this.finishStop()
    })
  }

  private finishStop(): void {
    if (this.inst) {
      this.lib.sendDestroy(this.inst)
      log.info(`ndi: выход «${this.name}» остановлен`)
    }
    this.inst = null
    this.current = this.lastSent = null
    this.onStopped?.()
    this.onStopped = null
  }

  /** Выход программы: без ожиданий — процесс всё равно завершается. */
  destroyNow(): void {
    this.closing = true
    if (this.pump) clearTimeout(this.pump)
    if (this.poll) clearInterval(this.poll)
    if (this.inst) this.lib.sendDestroy(this.inst)
    this.inst = null
  }
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
    // Offscreen рисует в пикселях экрана (Retina — вдвое больше), а нам нужно
    // ровно выбранное разрешение: окно делаем меньше на масштаб основного дисплея.
    const sf = screen.getPrimaryDisplay().scaleFactor || 1
    const { size } = this.sender
    const win = createNdiOverlayWindow(Math.round(widthOf(size) / sf), Math.round(size / sf))
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
    const real = getActiveWindows().get(this.role)
    let target: BrowserWindow
    if (real && !real.isDestroyed()) {
      releaseGhost(this.role, this.holder)
      target = real
    } else {
      target = acquireGhost(this.role, this.holder, () => this.createGhost())
    }
    if (target === this.win) return
    this.unsubscribe()
    this.win = target
    const wc = target.webContents
    wc.beginFrameSubscription(false, (image) => this.sender.push(image))
    // Кадры приходят только на изменения — первый, пока на экране статичный слайд, вызываем сами.
    const kick = (): void => {
      if (!target.isDestroyed()) wc.invalidate()
    }
    if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(kick, 300))
    else kick()
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
    const w = this.win
    this.win = null
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.endFrameSubscription()
      } catch {
        // окно уже уходит
      }
    }
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
  const onStatus: StatusFn = (s) => {
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
    const next = sanitize(v ?? {})
    setNdiSettings(next)
    const run = chain.then(() => apply(next))
    chain = run.catch(() => undefined)
    return { ok: true, status: await run }
  })
}
