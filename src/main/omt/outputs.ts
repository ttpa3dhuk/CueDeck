/**
 * Выходы OMT — источники CueDeck в локальной сети (vMix 29+, OBS с плагином OMT).
 *
 * Таймер с прозрачным фоном: скрытое offscreen-окно рисует страницу overlay
 * (renderer/overlay) на прозрачном фоне → кадры BGRA с альфой (premultiplied,
 * как их отдаёт Chromium) → omt_send. Захват обычного окна альфу не передаёт —
 * поэтому offscreen.
 *
 * Кодируем сами (libvmx) и только когда картинка изменилась: `paint` приходит
 * на изменения (таймер — раз в секунду), а получателю нужен ровный поток —
 * готовый сжатый кадр VMX1 повторяется по своему таймеру 30 раз в секунду.
 * Отдать libomt сырой BGRA 30 раз в секунду — это 30 кодирований 1080p,
 * треть ядра на M-маке впустую (замер 2026-10-08); так — доли процента.
 * Кодирование идёт в рабочем потоке koffi (`.async`) — главный процесс держит
 * IPC всех окон и не должен вставать на кодеке.
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import log from 'electron-log/main'
import { store } from '../state.js'
import { t } from '../../shared/i18n.js'
import type { OmtSettings, OmtStatus } from '../../shared/types.js'
import { cleanOmtName, getOmtSettings, setOmtSettings } from '../display-mapping.js'
import { createOmtOverlayWindow } from '../windows.js'
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

/** Кадр из `paint`: сырой BGRA (premultiplied, как отдаёт Chromium). */
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

/** Один отправитель OMT + окно, которое он показывает. */
class OverlaySender {
  private inst: unknown = null
  private vmx: unknown = null
  private vmxSize = { width: 0, height: 0 }
  private win: BrowserWindow | null = null
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
    private readonly onStatus: (s: { receivers: number; program: boolean; preview: boolean }) => void,
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

    // Offscreen рисует в пикселях экрана (Retina — вдвое больше), а нам нужен
    // ровно 1920×1080: окно делаем меньше на масштаб основного дисплея.
    const sf = screen.getPrimaryDisplay().scaleFactor || 1
    const win = createOmtOverlayWindow(Math.round(WIDTH / sf), Math.round(HEIGHT / sf))
    this.win = win
    win.webContents.setFrameRate(FPS)
    win.webContents.on('paint', (_e, _dirty, image) => {
      const { width, height } = image.getSize()
      if (!width || !height || this.closing) return
      this.pendingRaw = { width, height, buf: image.toBitmap() }
      this.encodeNext()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })

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
    log.info(`omt: выход «${this.address ?? this.name}» запущен, ${WIDTH}×${HEIGHT} ${FPS} к/с`)
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
    lib.vmxEncodeBGRA.async(vmx, raw.buf, raw.width * 4, 0, (err: unknown, hr: number) => {
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
      Flags: OMT_FLAG_ALPHA | OMT_FLAG_PREMULTIPLIED,
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
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
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

let timer: OverlaySender | null = null
let status: OmtStatus = store.get().omt
// Перенастройки идут по очереди: остановка ждёт кадр в работе.
let chain: Promise<unknown> = Promise.resolve()

function publish(patch: Partial<OmtStatus>): void {
  status = { ...status, ...patch }
  store.patch({ omt: status })
}

async function apply(next: OmtSettings): Promise<OmtStatus> {
  const restart = !next.timer || (timer !== null && timer.name !== next.timerName)
  if (timer && restart) {
    const t = timer
    timer = null
    await t.stop()
  }
  publish({ ...next })
  if (!next.timer) {
    publish({ timerState: 'off', timerAddress: null, timerReceivers: 0, timerProgram: false, timerPreview: false, error: null })
    return status
  }
  if (timer) return status
  const lib = loadOmt()
  if (!lib) {
    publish({ available: false, timerState: 'error', error: omtLoadError() })
    return status
  }
  publish({ available: true })
  const sender = new OverlaySender(lib, next.timerName, (s) => {
    if (timer !== sender) return
    publish({ timerReceivers: s.receivers, timerProgram: s.program, timerPreview: s.preview })
  })
  try {
    sender.start()
    timer = sender
    publish({ timerState: 'on', timerAddress: sender.address, error: null })
  } catch (err) {
    const msg = (err as Error).message || String(err)
    log.warn(`omt: выход не поднялся — ${msg}`)
    void sender.stop()
    publish({ timerState: 'error', timerAddress: null, error: msg })
  }
  return status
}

function sanitize(v: Partial<OmtSettings>): OmtSettings {
  const cur = getOmtSettings()
  return {
    timer: v.timer === undefined ? cur.timer : v.timer === true,
    timerName: cleanOmtName(v.timerName ?? cur.timerName, cur.timerName),
    timerMessage: v.timerMessage === undefined ? cur.timerMessage : v.timerMessage === true,
  }
}

/** Поднять выходы по сохранённым настройкам — после регистрации ipc. */
export function initOmt(): void {
  const s = getOmtSettings()
  // Библиотеку не грузим, пока выход не включён: кому OMT не нужен, тот её и не загружает.
  publish({ ...s })
  if (s.timer) chain = chain.then(() => apply(s))
  process.on('exit', () => timer?.destroyNow())
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
