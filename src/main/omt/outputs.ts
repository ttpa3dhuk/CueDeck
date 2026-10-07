/**
 * Выходы OMT — источники CueDeck в локальной сети (vMix 29+, OBS с плагином OMT).
 *
 * - **Таймер** — скрытое offscreen-окно рисует страницу overlay
 *   (renderer/overlay) на прозрачном фоне; кадры приходят событием `paint`
 *   вместе с альфой (premultiplied, как отдаёт Chromium). Захват обычного
 *   окна альфу не передаёт — поэтому offscreen.
 * - **Зал / суфлёр** — подписка на кадры (`beginFrameSubscription`) того окна,
 *   что сейчас в раскладке. Нет такого окна (solo, «оператор + зал») — держим
 *   скрытое (acquireGhost в windows.ts, общее с трансляцией и монитором).
 *
 * Кодируем сами (libvmx) и только когда картинка изменилась, а готовый сжатый
 * кадр VMX1 повторяем по своему таймеру 30 раз в секунду: получателю нужен
 * ровный поток, а кадры приходят только на изменения. Отдать libomt сырой BGRA
 * 30 раз в секунду — это 30 кодирований 1080p, треть ядра на M-маке впустую
 * (замер 2026-10-08); так неподвижная картинка стоит доли процента.
 * Кодирование идёт в рабочем потоке koffi (`.async`) — главный процесс держит
 * IPC всех окон и не должен вставать на кодеке.
 */
import { app, BrowserWindow, ipcMain, screen, type NativeImage } from 'electron'
import log from 'electron-log/main'
import { store } from '../state.js'
import { t } from '../../shared/i18n.js'
import {
  OMT_OUTPUTS,
  OMT_OUTPUT_OFF,
  type OmtOutputId,
  type OmtOutputStatus,
  type OmtSettings,
  type OmtStatus,
} from '../../shared/types.js'
import { cleanOmtName, getOmtSettings, setOmtSettings } from '../display-mapping.js'
import {
  acquireGhost,
  createHiddenAudienceWindow,
  createHiddenSpeakerWindow,
  createOmtOverlayWindow,
  getActiveWindows,
  releaseGhost,
} from '../windows.js'
import {
  loadOmt,
  omtLoadError,
  OMT_CODEC_VMX1,
  OMT_FLAG_ALPHA,
  OMT_FLAG_PREMULTIPLIED,
  OMT_FRAME_VIDEO,
  OMT_QUALITY_HIGH,
  VMX_COLORSPACE_BT709,
  VMX_PROFILE_OMT_HQ,
  type OmtLib,
} from './libomt.js'

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30

/** Кадр, ещё не сжатый: BGRA (у таймера альфа premultiplied). */
interface RawFrame {
  width: number
  height: number
  buf: Buffer
}

/** Сжатый кадр VMX1 — его и повторяем. */
interface VmxFrame {
  width: number
  height: number
  data: Buffer
}

type StatusFn = (s: Partial<OmtOutputStatus>) => void

/**
 * Отправитель OMT: принимает кадры, сжимает только новые, повторяет последний
 * сжатый с постоянной частотой; раз в секунду — получатели и tally.
 */
class OmtSender {
  private inst: unknown = null
  private vmx: unknown = null
  private vmxSize = { width: 0, height: 0 }
  /** Свежий кадр, ещё не сжатый (пока кодек занят предыдущим). */
  private pendingRaw: RawFrame | null = null
  private encoding = false
  /** Последний сжатый кадр — уходит получателям с постоянной частотой. */
  private current: VmxFrame | null = null
  private sending: VmxFrame | null = null
  private pump: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private closing = false
  private onStopped: (() => void) | null = null
  address: string | null = null

  constructor(
    private readonly lib: OmtLib,
    readonly name: string,
    private readonly alpha: boolean,
    private readonly onStatus: StatusFn,
  ) {}

  start(): void {
    const { lib } = this
    this.inst = lib.sendCreate(this.name, OMT_QUALITY_HIGH)
    if (!this.inst) throw new Error(t('не удалось создать источник OMT'))
    lib.sendSetInfo(this.inst, {
      ProductName: 'CueDeck',
      Manufacturer: 'CueDeck',
      Version: app.getVersion(),
      Reserved1: '',
      Reserved2: '',
      Reserved3: '',
    })
    const addr = Buffer.alloc(1024)
    const n = lib.sendGetAddress(this.inst, addr, addr.length) as number
    this.address = n > 1 ? addr.toString('utf8', 0, n - 1) : null

    this.pump = setInterval(() => this.sendCurrent(), Math.round(1000 / FPS))
    let lastKey = ''
    const tally = { preview: 0, program: 0 }
    this.poll = setInterval(() => {
      if (!this.inst) return
      const conns = lib.sendConnections(this.inst) as number
      lib.sendGetTally(this.inst, 0, tally)
      // Получатель открывает два соединения: видео+метаданные и звук.
      const s = { receivers: Math.ceil(Math.max(0, conns) / 2), program: tally.program === 1, preview: tally.preview === 1 }
      const key = `${s.receivers}|${s.program}|${s.preview}`
      if (key !== lastKey) {
        lastKey = key
        log.info(`omt: «${this.name}» получателей ${s.receivers}${s.program ? ', в эфире' : ''}${s.preview ? ', в превью' : ''}`)
        this.onStatus(s)
      }
    }, 1000)
    log.info(`omt: выход «${this.address ?? this.name}» запущен`)
  }

  /** Новый кадр от источника. Больше 1920 по ширине (Retina, 4K-проектор) — ужимаем. */
  push(image: NativeImage): void {
    if (this.closing || image.isEmpty()) return
    let img = image
    if (img.getSize().width > WIDTH) img = img.resize({ width: WIDTH, quality: 'good' })
    const { width, height } = img.getSize()
    if (width < 16 || height < 16) return
    this.pendingRaw = { width, height, buf: img.toBitmap() }
    this.encodeNext()
  }

  /** Сжать самый свежий кадр; пока кодек занят, промежуточные кадры отбрасываются. */
  private encodeNext(): void {
    const raw = this.pendingRaw
    if (!raw || this.encoding || this.closing) return
    this.pendingRaw = null
    const { lib } = this
    if (!this.vmx || this.vmxSize.width !== raw.width || this.vmxSize.height !== raw.height) {
      if (this.vmx) lib.vmxDestroy(this.vmx)
      this.vmx = lib.vmxCreate({ width: raw.width, height: raw.height }, VMX_PROFILE_OMT_HQ, VMX_COLORSPACE_BT709)
      this.vmxSize = { width: raw.width, height: raw.height }
      if (!this.vmx) {
        log.warn(`omt: VMX_Create не создал кодек ${raw.width}×${raw.height}`)
        return
      }
    }
    this.encoding = true
    const vmx = this.vmx
    const encode = this.alpha ? lib.vmxEncodeBGRA : lib.vmxEncodeBGRX
    encode.async(vmx, raw.buf, raw.width * 4, 0, (err: unknown, hr: number) => {
      // Сохранение — копия в буфер, быстро: делаем здесь же, кодек ещё наш.
      let data: Buffer | null = null
      if (!err && hr === 0 && !this.closing) {
        const out = Buffer.allocUnsafe(raw.width * raw.height * 4)
        const len = lib.vmxSaveTo(vmx, out, out.length) as number
        if (len > 0) data = out.subarray(0, len)
      } else if (err || hr !== 0) {
        log.warn(`omt: кадр не сжался (${err ? String(err) : `VMX ${hr}`})`)
      }
      this.encoding = false
      if (data) this.current = { width: raw.width, height: raw.height, data }
      if (this.closing) this.finishStop()
      else this.encodeNext()
    })
  }

  private sendCurrent(): void {
    const f = this.current
    if (!f || !this.inst || this.sending || this.closing) return
    const frame = {
      Type: OMT_FRAME_VIDEO, Timestamp: -1, Codec: OMT_CODEC_VMX1,
      Width: f.width, Height: f.height, Stride: f.width * 4,
      Flags: this.alpha ? OMT_FLAG_ALPHA | OMT_FLAG_PREMULTIPLIED : 0,
      FrameRateN: FPS, FrameRateD: 1, AspectRatio: f.width / f.height, ColorSpace: VMX_COLORSPACE_BT709,
      SampleRate: 0, Channels: 0, SamplesPerChannel: 0,
      Data: f.data, DataLength: f.data.length,
      CompressedData: null, CompressedLength: 0, FrameMetadata: null, FrameMetadataLength: 0,
    }
    // Буфер должен жить, пока libomt его копирует в рабочем потоке, — держим ссылку.
    this.sending = f
    this.lib.send.async(this.inst, frame, (err: unknown) => {
      this.sending = null
      if (err) log.warn('omt: кадр не ушёл', err)
      if (this.closing) this.finishStop()
    })
  }

  /** Остановить: дождаться кадра в работе, потом освободить отправителя и кодек. */
  stop(): Promise<void> {
    if (this.pump) clearInterval(this.pump)
    if (this.poll) clearInterval(this.poll)
    this.pump = this.poll = null
    this.pendingRaw = null
    this.closing = true
    return new Promise((resolve) => {
      this.onStopped = resolve
      this.finishStop()
    })
  }

  private finishStop(): void {
    if (this.sending || this.encoding) return
    if (this.inst) {
      this.lib.sendDestroy(this.inst)
      log.info(`omt: выход «${this.name}» остановлен`)
    }
    if (this.vmx) this.lib.vmxDestroy(this.vmx)
    this.inst = this.vmx = null
    this.current = null
    this.onStopped?.()
    this.onStopped = null
  }

  /** Выход программы: без ожиданий — что в работе, не трогаем, процесс всё равно завершается. */
  destroyNow(): void {
    this.closing = true
    if (this.pump) clearInterval(this.pump)
    if (this.poll) clearInterval(this.poll)
    if (this.inst && !this.sending && !this.encoding) this.lib.sendDestroy(this.inst)
    this.inst = null
  }
}

interface Output {
  readonly sender: OmtSender
  start(): void
  stop(): Promise<void>
}

/** Таймер: своё offscreen-окно на прозрачном фоне. */
class TimerOutput implements Output {
  private win: BrowserWindow | null = null

  constructor(readonly sender: OmtSender) {}

  start(): void {
    this.sender.start()
    // Offscreen рисует в пикселях экрана (Retina — вдвое больше), а нам нужен
    // ровно 1920×1080: окно делаем меньше на масштаб основного дисплея.
    const sf = screen.getPrimaryDisplay().scaleFactor || 1
    const win = createOmtOverlayWindow(Math.round(WIDTH / sf), Math.round(HEIGHT / sf))
    this.win = win
    win.webContents.setFrameRate(FPS)
    win.webContents.on('paint', (_e, _dirty, image) => this.sender.push(image))
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
  private readonly holder: string

  constructor(
    readonly sender: OmtSender,
    private readonly role: 'audience' | 'speaker',
  ) {
    this.holder = `omt-${role}`
  }

  start(): void {
    this.sender.start()
    this.follow()
    this.watch = setInterval(() => this.follow(), 500)
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
    log.info(`omt: «${this.sender.name}» снимает окно «${target.getTitle()}»`)
  }

  /**
   * Зал — ровно 1920×1080 в пикселях (на Retina вдвое меньше в точках): там
   * только слайд во весь экран. Суфлёр — как настоящий, 1920×1080 точек: его
   * вёрстка в пикселях CSS, в уменьшенном окне всё стало бы вдвое крупнее;
   * лишнее разрешение ужмёт push().
   */
  private createGhost(): BrowserWindow {
    if (this.role === 'speaker') return createHiddenSpeakerWindow()
    const sf = screen.getPrimaryDisplay().scaleFactor || 1
    return createHiddenAudienceWindow(Math.round(WIDTH / sf), Math.round(HEIGHT / sf))
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
    releaseGhost(this.role, this.holder)
    return this.sender.stop()
  }
}

const outputs = new Map<OmtOutputId, Output>()
let status: OmtStatus = store.get().omt
// Перенастройки идут по очереди: остановка ждёт кадр в работе.
let chain: Promise<unknown> = Promise.resolve()

function publish(patch: Partial<OmtStatus>): void {
  status = { ...status, ...patch }
  store.patch({ omt: status })
}

function publishOutput(id: OmtOutputId, patch: Partial<OmtOutputStatus>): void {
  publish({ outputs: { ...status.outputs, [id]: { ...status.outputs[id], ...patch } } })
}

function makeOutput(lib: OmtLib, id: OmtOutputId, name: string): Output {
  const onStatus: StatusFn = (s) => {
    if (outputs.get(id) === out) publishOutput(id, s)
  }
  const out: Output =
    id === 'timer'
      ? new TimerOutput(new OmtSender(lib, name, true, onStatus))
      : new WindowOutput(new OmtSender(lib, name, false, onStatus), id === 'program' ? 'audience' : 'speaker')
  return out
}

async function apply(next: OmtSettings): Promise<OmtStatus> {
  // Сначала гасим лишнее и переименованное (новое имя = новый источник в сети).
  for (const id of OMT_OUTPUTS) {
    const out = outputs.get(id)
    if (out && (!next.enabled[id] || out.sender.name !== next.names[id])) {
      outputs.delete(id)
      await out.stop()
      publishOutput(id, { ...OMT_OUTPUT_OFF })
    }
  }
  publish({ enabled: { ...next.enabled }, names: { ...next.names }, timerMessage: next.timerMessage })
  const wanted = OMT_OUTPUTS.filter((id) => next.enabled[id] && !outputs.has(id))
  if (wanted.length === 0) return status
  const lib = loadOmt()
  if (!lib) {
    const error = omtLoadError()
    publish({ available: false, error })
    for (const id of wanted) publishOutput(id, { state: 'error', error })
    return status
  }
  publish({ available: true, error: null })
  for (const id of wanted) {
    const out = makeOutput(lib, id, next.names[id])
    try {
      outputs.set(id, out)
      out.start()
      publishOutput(id, { ...OMT_OUTPUT_OFF, state: 'on', address: out.sender.address })
    } catch (err) {
      const msg = (err as Error).message || String(err)
      log.warn(`omt: выход ${id} не поднялся — ${msg}`)
      outputs.delete(id)
      void out.stop()
      publishOutput(id, { ...OMT_OUTPUT_OFF, state: 'error', error: msg })
    }
  }
  return status
}

/** Пришедшее из окна «Настройки» → чистые настройки; имена разные (иначе два источника с одним именем). */
function sanitize(v: Partial<OmtSettings>): OmtSettings {
  const cur = getOmtSettings()
  const out: OmtSettings = {
    enabled: { ...cur.enabled },
    names: { ...cur.names },
    timerMessage: v.timerMessage === undefined ? cur.timerMessage : v.timerMessage === true,
  }
  const used = new Set<string>()
  for (const id of OMT_OUTPUTS) {
    if (v.enabled?.[id] !== undefined) out.enabled[id] = v.enabled[id] === true
    let name = cleanOmtName(v.names?.[id] ?? cur.names[id], cur.names[id])
    if (used.has(name.toLowerCase())) name = `${name} ${id}`
    used.add(name.toLowerCase())
    out.names[id] = name
  }
  return out
}

/** Поднять выходы по сохранённым настройкам — после регистрации ipc. */
export function initOmt(): void {
  const s = getOmtSettings()
  // Библиотеку не грузим, пока выход не включён: кому OMT не нужен, тот её и не загружает.
  publish({ enabled: { ...s.enabled }, names: { ...s.names }, timerMessage: s.timerMessage })
  if (OMT_OUTPUTS.some((id) => s.enabled[id])) chain = chain.then(() => apply(s))
  process.on('exit', () => {
    for (const out of outputs.values()) out.sender.destroyNow()
  })
}

export function registerOmtIpc(): void {
  ipcMain.handle('omt:configure', async (_e, v: Partial<OmtSettings>) => {
    const next = sanitize(v ?? {})
    setOmtSettings(next)
    const run = chain.then(() => apply(next))
    chain = run.catch(() => undefined)
    return { ok: true, status: await run }
  })
}
