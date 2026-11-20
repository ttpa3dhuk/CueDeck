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
import { app, ipcMain, type NativeImage } from 'electron'
import log from 'electron-log/main'
import { store } from '../state.js'
import { t } from '../../shared/i18n.js'
import { omtFrameSize } from '../../shared/omt-frame-size.js'
import {
  OMT_OUTPUTS,
  OMT_OUTPUT_OFF,
  type OmtOutputId,
  type OmtFps,
  type OmtOutputStatus,
  type OmtResolution,
  type OmtSettings,
  type OmtStatus,
} from '../../shared/types.js'
import { cleanOmtFps, cleanOmtName, cleanOmtResolution, getOmtSettings, setOmtSettings } from '../display-mapping.js'
import { acquireNetworkVideo, acquireProgramVideo, acquireProgramAudio, markProgramTransition, type ProgramAudioChunk } from '../network-output-source.js'
import { isProgramTransition, type ProgramVideoCursor } from '../program-playout.js'
import { programBitmap } from '../program-bitmap-cache.js'
import { NetworkTimerOutput } from '../network-timer-output.js'
import {
  loadOmt,
  omtLoadError,
  OMT_CODEC_FPA1,
  OMT_CODEC_VMX1,
  OMT_FRAME_AUDIO,
  OMT_FLAG_ALPHA,
  OMT_FLAG_PREMULTIPLIED,
  OMT_FRAME_VIDEO,
  OMT_QUALITY_HIGH,
  VMX_COLORSPACE_BT709,
  VMX_PROFILE_OMT_HQ,
  type OmtLib,
} from './libomt.js'


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
 * Метки времени OMT — единицы по 100 нс. Свои, а не «-1» (тогда libomt сама
 * ставит метки и держит частоту, задерживая вызов): со звуком картинке и
 * звуку нужны общие часы, иначе получатель их не сведёт.
 */
function omtNow(): number {
  return Number(process.hrtime.bigint() / 100n)
}

/** Звук ушёл от часов дальше этого — метки звука подтягиваем к часам. */
const AUDIO_RESYNC = 1_500_000 // 150 мс

/**
 * Отправитель OMT: принимает кадры, сжимает только новые, повторяет последний
 * сжатый с постоянной частотой; следит за получателями и tally.
 */
class OmtSender {
  private inst: unknown = null
  private vmx: unknown = null
  private vmxSize = { width: 0, height: 0 }
  /**
   * Свежий кадр, ещё не сжатый. Хранится как NativeImage и превращается в байты
   * (копия ~8 МБ на 1080p, в главном процессе) только когда кодек свободен:
   * подписка на окно приносит до 60 кадров в секунду, а сжать успеваем меньше —
   * копировать те, что всё равно выбросим, нельзя (на i3 это съедало ядро).
   */
  private pendingImage: NativeImage | null = null
  private programCursor: ProgramVideoCursor | null = null
  private programEpoch = -1
  private missedEncodeSlot = false
  private missedSendSlot = false
  private lastSendAt = 0
  private earlySendWake: NodeJS.Timeout | null = null
  private encoding = false
  private encodingStartedAt = 0
  /** Буфер под сжатый кадр — один на отправителя, а не 8 МБ на каждый кадр. */
  private scratch: Buffer | null = null
  /** Счётчики за окно журнала (раз в 10 с, пока есть получатели). */
  private stats = { pushed: 0, encoded: 0, encodeMs: 0, sent: 0, audioChunks: 0, audioSamples: 0, audioBackward: 0, audioResyncs: 0, audioLeadTicks: 0, since: 0 }
  private receivers = 0
  /** Последний сжатый кадр — уходит получателям с постоянной частотой. */
  private current: VmxFrame | null = null
  private currentFresh = false
  private sending: VmxFrame | null = null
  private pump: NodeJS.Timeout | null = null
  /** Когда уйти следующему кадру (мс, performance.now) — счёт от расписания, а не от прошлого вызова: без накопленного опоздания. */
  private nextAt = 0
  private poll: NodeJS.Timeout | null = null
  private closing = false
  private onStopped: (() => void) | null = null
  /** Метка первого семпла и сколько семплов ушло с неё — звук идёт счётчиком, а не часами. */
  private audioBase: number | null = null
  private audioSamples = 0
  address: string | null = null

  constructor(
    private readonly lib: OmtLib,
    readonly name: string,
    readonly size: OmtResolution,
    /** Частота кадров; меняется на лету (setFps). */
    public fps: OmtFps,
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

    this.nextAt = performance.now()
    this.tickPump()
    let lastKey = ''
    const tally = { preview: 0, program: 0 }
    // Tally — 5 раз в секунду (лампа должна загораться сразу, вызов без ожидания
    // и дешёвый), число получателей — раз в секунду.
    let tick = 0
    let receivers = 0
    this.poll = setInterval(() => {
      if (!this.inst) return
      if (tick++ % 5 === 0) receivers = lib.sendConnections(this.inst) as number
      const conns = receivers
      lib.sendGetTally(this.inst, 0, tally)
      // Получатель открывает два соединения: видео+метаданные и звук.
      const s = { receivers: Math.ceil(Math.max(0, conns) / 2), program: tally.program === 1, preview: tally.preview === 1 }
      this.receivers = s.receivers
      this.logStats()
      const key = `${s.receivers}|${s.program}|${s.preview}`
      if (key !== lastKey) {
        lastKey = key
        log.info(`omt: «${this.name}» получателей ${s.receivers}${s.program ? ', в эфире' : ''}${s.preview ? ', в превью' : ''}`)
        this.onStatus(s)
      }
    }, 200)
    log.info(`omt: выход «${this.address ?? this.name}» запущен, ${this.size}p ${this.fps} к/с`)
  }

  /** Повтор последнего кадра с частотой fps. setInterval на 60 к/с давал бы 59 (округление до 17 мс). */
  private tickPump(): void {
    if (this.closing) return
    if (this.encoding && this.programCursor) this.missedEncodeSlot = true
    else this.encodeNext()
    if (this.sending && this.programCursor) this.missedSendSlot = true
    else this.sendCurrent()
    const period = 1000 / this.fps
    this.nextAt += period
    const now = performance.now()
    // Проспали (нагрузка, сон ноутбука) — не догоняем пачкой, а встаём в шаг заново.
    if (this.nextAt < now - period) this.nextAt = now
    this.pump = setTimeout(() => this.tickPump(), Math.max(0, this.nextAt - now))
  }

  /**
   * Раз в 10 с, пока кто-то смотрит: сколько кадров пришло от окна, сжато
   * (и сколько стоит сжатие), отправлено. По ним видно, где узкое место —
   * источник, кодек (процессор) или отправка.
   */
  private logStats(): void {
    const now = performance.now()
    if (!this.stats.since) this.stats.since = now
    const dt = (now - this.stats.since) / 1000
    if (dt < 10) return
    const st = this.stats
    const sourceFrames = this.programCursor ? this.programCursor.takeSourceCaptures() : st.pushed
    if (this.receivers > 0) {
      const enc = st.encoded ? (st.encodeMs / st.encoded).toFixed(0) : '—'
      log.info(
        `omt: «${this.name}» за ${dt.toFixed(0)} с: кадров от источника ${(sourceFrames / dt).toFixed(1)}/с, ` + // i18n-ok: журнал
          `сжато ${(st.encoded / dt).toFixed(1)}/с по ${enc} мс, отправлено ${(st.sent / dt).toFixed(1)}/с (цель ${this.fps})`, // i18n-ok: журнал
      )
      if (st.audioChunks) {
        const coverage = st.audioSamples / 48000 / dt * 100
        log.info(
          `omt: «${this.name}» звук: ${st.audioChunks} кусков за ${dt.toFixed(1)} с, ` + // i18n-ok: журнал
            `семплов ${st.audioSamples}, покрытие ${coverage.toFixed(1)}% времени), ` + // i18n-ok: журнал
            `опоздало >150 мс: ${st.audioResyncs}, откат метки: ${st.audioBackward}, ` + // i18n-ok: журнал
            `счётчик впереди прихода до ${(st.audioLeadTicks / 10000).toFixed(0)} мс`, // i18n-ok: журнал
        )
      }
    }
    this.stats = { pushed: 0, encoded: 0, encodeMs: 0, sent: 0, audioChunks: 0, audioSamples: 0, audioBackward: 0, audioResyncs: 0, audioLeadTicks: 0, since: now }
  }

  setFps(fps: OmtFps): void {
    if (fps === this.fps) return
    this.fps = fps
    log.info(`omt: «${this.name}» ${fps} к/с`)
  }

  /** Keep the newest compositor frame, including the last paint of a static slide. */
  push(image: NativeImage): void {
    if (this.closing || image.isEmpty()) return
    this.stats.pushed++
    this.pendingImage = image
  }

  setProgramCursor(cursor: ProgramVideoCursor | null): void {
    this.programCursor = cursor
    this.programEpoch = cursor?.epoch ?? -1
    this.pendingImage = null
    this.current = null
    this.currentFresh = false
  }

  /** Байты кадра: вписываем в выбранный предел по обеим сторонам, без обрезки. */
  private toRaw(image: NativeImage): RawFrame | null {
    const source = image.getSize()
    const target = omtFrameSize(source.width, source.height, this.size)
    if (!target) return null
    const shared = this.programCursor ? programBitmap(image, target.width, target.height) : null
    const img = shared ? null : source.width !== target.width || source.height !== target.height
      ? image.resize({ ...target, quality: 'good' }) : image
    const { width, height } = shared ?? img!.getSize()
    if (width < 16 || height < 16) return null
    return { width, height, buf: shared?.bitmap ?? img!.toBitmap() }
  }

  /** Сжать самый свежий кадр; пока кодек занят, промежуточные кадры отбрасываются. */
  private encodeNext(): void {
    if (this.encoding || this.closing) return
    if (this.programCursor && this.programEpoch !== this.programCursor.epoch) {
      this.programEpoch = this.programCursor.epoch
      this.current = null
      this.currentFresh = false
    }
    // Program must hand the prepared frame to native send before selecting
    // another source frame. The prompter and timer retain their old cadence.
    if (this.programCursor && this.currentFresh) return
    const selected = this.programCursor?.next(this.fps)
    if (selected?.cut) { this.current = null; this.currentFresh = false }
    const image = selected?.image ?? this.pendingImage
    if (!image) return
    this.pendingImage = null
    const raw = this.toRaw(image)
    if (!raw) return
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
    const encodingEpoch = this.programEpoch
    const encodingFrameId = selected?.id
    const vmx = this.vmx
    const encode = this.alpha ? lib.vmxEncodeBGRA : lib.vmxEncodeBGRX
    const t0 = performance.now()
    this.encodingStartedAt = t0
    encode.async(vmx, raw.buf, raw.width * 4, 0, (err: unknown, hr: number) => {
      // Сохранение — копия в буфер, быстро: делаем здесь же, кодек ещё наш.
      let data: Buffer | null = null
      if (!err && hr === 0 && !this.closing) {
        const need = raw.width * raw.height * 4
        if (!this.scratch || this.scratch.length < need) this.scratch = Buffer.allocUnsafe(need)
        const len = lib.vmxSaveTo(vmx, this.scratch, this.scratch.length) as number
        // Своя копия нужной длины: scratch перезапишет следующий кадр, а этот ещё повторяется.
        if (len > 0) data = Buffer.from(this.scratch.subarray(0, len))
        this.stats.encoded++
        this.stats.encodeMs += performance.now() - t0
      } else if (err || hr !== 0) {
        log.warn(`omt: кадр не сжался (${err ? String(err) : `VMX ${hr}`})`)
      }
      this.encoding = false
      const superseded = encodingFrameId !== undefined && this.programCursor?.superseded(encodingFrameId)
      if (superseded) { this.current = null; this.currentFresh = false }
      if (data && !superseded && (!this.programCursor || encodingEpoch === this.programCursor.epoch)) {
        this.current = { width: raw.width, height: raw.height, data }
        this.currentFresh = true
      }
      if (this.closing) this.finishStop()
      else {
        if (this.programCursor && this.missedEncodeSlot) {
          this.missedEncodeSlot = false
          setTimeout(() => { if (!this.closing && !this.encoding) this.encodeNext() }, 0)
        }
        if (this.programCursor && this.currentFresh && !this.sending)
          setTimeout(() => { if (!this.closing && !this.sending) this.sendCurrent() }, 0)
      }
    })
  }

  private sendCurrent(): void {
    // A moving program frame is already in VMX. Preserve the next transport
    // slot for that completion, instead of filling it with the previous frame.
    // An unusually long encode still gets a bounded old-frame heartbeat.
    if (this.programCursor && this.encoding &&
      performance.now() - this.encodingStartedAt < Math.max(150, 3 * 1000 / this.fps)) return
    if (this.programCursor?.hasFreshCut()) { this.current = null; this.currentFresh = false }
    if (this.programCursor && this.lastSendAt > 0) {
      const remaining = 1000 / this.fps - (performance.now() - this.lastSendAt)
      if (remaining > 1) {
        if (!this.earlySendWake) this.earlySendWake = setTimeout(() => {
          this.earlySendWake = null
          this.sendCurrent()
        }, remaining)
        return
      }
    }
    const f = this.current
    if (!f || !this.inst || this.sending || this.closing) return
    const frame = {
      Type: OMT_FRAME_VIDEO, Timestamp: omtNow(), Codec: OMT_CODEC_VMX1,
      Width: f.width, Height: f.height, Stride: f.width * 4,
      Flags: this.alpha ? OMT_FLAG_ALPHA | OMT_FLAG_PREMULTIPLIED : 0,
      FrameRateN: this.fps, FrameRateD: 1, AspectRatio: f.width / f.height, ColorSpace: VMX_COLORSPACE_BT709,
      SampleRate: 0, Channels: 0, SamplesPerChannel: 0,
      Data: f.data, DataLength: f.data.length,
      CompressedData: null, CompressedLength: 0, FrameMetadata: null, FrameMetadataLength: 0,
    }
    // Буфер должен жить, пока libomt его копирует в рабочем потоке, — держим ссылку.
    this.sending = f
    this.currentFresh = false
    this.lastSendAt = performance.now()
    this.lib.send.async(this.inst, frame, (err: unknown) => {
      this.sending = null
      this.stats.sent++
      if (err) log.warn('omt: кадр не ушёл', err)
      if (this.closing) this.finishStop()
      else if (this.programCursor && this.currentFresh) {
        // VMX may have prepared the next frame while native send held this one.
        // The cadence guard in sendCurrent schedules any remaining wait.
        this.missedSendSlot = false
        setTimeout(() => { if (!this.closing && !this.sending) this.sendCurrent() }, 0)
      }
      else if (this.programCursor && this.missedSendSlot) {
        this.missedSendSlot = false
        if (performance.now() - this.lastSendAt >= 1000 / this.fps - 2)
          setTimeout(() => { if (!this.closing && !this.sending) this.sendCurrent() }, 0)
      }
    })
    // The compressed frame is now owned by native send. Start the next VMX
    // operation without waiting for the next timer tick; at most one prepared
    // frame remains ahead of transport.
    if (this.programCursor)
      setTimeout(() => { if (!this.closing && !this.encoding && !this.currentFresh) this.encodeNext() }, 0)
  }

  /**
   * Звук зала. Метки — счётчиком семплов от первого куска (ровно, без дрожи
   * IPC); ушли от часов дальше 150 мс (пауза в захвате, сон ноутбука) —
   * начинаем отсчёт заново от часов. Поведение прежнее: это A/B-кандидат,
   * здесь только счётчики.
   *
   * Известный дефект: сравнение с часами по модулю откатывает метку назад,
   * когда IPC отдаёт пачку позже; откаты считает `audioBackward` (в журнале
   * «откат метки»). Изменение политики требует отдельного живого прогона.
   */
  pushAudio(chunk: ProgramAudioChunk): void {
    if (!this.inst || this.closing) return
    const { sampleRate, channels, frames, data } = chunk
    if (!sampleRate || !channels || !frames || data.length < frames * channels) return
    const now = omtNow()
    // Метка начала куска — он только что закончился.
    const start = now - Math.round((frames * 1e7) / sampleRate)
    let ts = this.audioBase === null ? start : this.audioBase + Math.round((this.audioSamples * 1e7) / sampleRate)
    const lead = ts - start
    this.stats.audioLeadTicks = Math.max(this.stats.audioLeadTicks, lead)
    if (this.audioBase === null || Math.abs(ts - start) > AUDIO_RESYNC) {
      // Re-anchor direction relative to the sample counter; arrival time does not identify a capture pause.
      if (this.audioBase !== null && start < ts) this.stats.audioBackward++
      else if (this.audioBase !== null) this.stats.audioResyncs++
      this.audioBase = start
      this.audioSamples = 0
      ts = start
    }
    this.audioSamples += frames
    this.stats.audioChunks++
    this.stats.audioSamples += frames
    const buf = Buffer.from(data.buffer, data.byteOffset, frames * channels * 4)
    this.lib.send(this.inst, {
      Type: OMT_FRAME_AUDIO, Timestamp: ts, Codec: OMT_CODEC_FPA1,
      Width: 0, Height: 0, Stride: 0, Flags: 0, FrameRateN: 0, FrameRateD: 0, AspectRatio: 0, ColorSpace: 0,
      SampleRate: sampleRate, Channels: channels, SamplesPerChannel: frames,
      Data: buf, DataLength: buf.length,
      CompressedData: null, CompressedLength: 0, FrameMetadata: null, FrameMetadataLength: 0,
    })
  }

  /** Остановить: дождаться кадра в работе, потом освободить отправителя и кодек. */
  stop(): Promise<void> {
    if (this.pump) clearTimeout(this.pump)
    if (this.earlySendWake) clearTimeout(this.earlySendWake)
    this.earlySendWake = null
    if (this.poll) clearInterval(this.poll)
    this.pump = this.poll = null
    this.pendingImage = null
    this.programCursor = null
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
    if (this.pump) clearTimeout(this.pump)
    if (this.poll) clearInterval(this.poll)
    if (this.inst && !this.sending && !this.encoding) this.lib.sendDestroy(this.inst)
    this.inst = null
  }
}

interface Output {
  readonly sender: OmtSender
  start(): void
  stop(): Promise<void>
  /** Частота меняется на лету: источник в сети не пропадает. */
  setFps(fps: OmtFps): void
}

/**
 * Зал или суфлёр: кадры того окна роли, что сейчас есть. Окна пересоздаются
 * при смене раскладки и экранов — раз в полсекунды проверяем, на то ли окно
 * подписаны.
 */
class WindowOutput implements Output {
  private video: { release(): void } | null = null
  private releaseAudio: (() => void) | null = null
  private releaseCuts: (() => void) | null = null

  constructor(readonly sender: OmtSender, private readonly role: 'audience' | 'speaker') {}

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
    } else this.video = acquireNetworkVideo(this.role, this.sender.fps, image => this.sender.push(image), this.sender.size)
  }

  setFps(fps: OmtFps): void { this.sender.setFps(fps) }

  setAudio(on: boolean): void {
    if (on && !this.releaseAudio) this.releaseAudio = acquireProgramAudio(chunk => this.sender.pushAudio(chunk))
    if (!on) {
      this.releaseAudio?.()
      this.releaseAudio = null
    }
  }

  stop(): Promise<void> {
    this.video?.release()
    this.setAudio(false)
    this.releaseCuts?.()
    this.releaseCuts = null
    this.sender.setProgramCursor(null)
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

/** Настроечная часть статуса (копии, чтобы не делить объекты с файлом настроек). */
function settingsPatch(v: OmtSettings): Partial<OmtStatus> {
  return {
    enabled: { ...v.enabled },
    names: { ...v.names },
    sizes: { ...v.sizes },
    fps: { ...v.fps },
    programAudio: v.programAudio,
    timerMessage: v.timerMessage,
  }
}

function publishOutput(id: OmtOutputId, patch: Partial<OmtOutputStatus>): void {
  publish({ outputs: { ...status.outputs, [id]: { ...status.outputs[id], ...patch } } })
}

function makeOutput(lib: OmtLib, id: OmtOutputId, name: string, size: OmtResolution, fps: OmtFps): Output {
  const onStatus: StatusFn = (s) => {
    if (outputs.get(id) === out) publishOutput(id, s)
  }
  const out: Output =
    id === 'timer'
      ? new NetworkTimerOutput('omt', new OmtSender(lib, name, size, fps, true, onStatus))
      : new WindowOutput(new OmtSender(lib, name, size, fps, false, onStatus), id === 'program' ? 'audience' : 'speaker')
  return out
}

async function apply(next: OmtSettings): Promise<OmtStatus> {
  // Сначала гасим лишнее, переименованное (новое имя = новый источник в сети)
  // и с другим разрешением (окно и кодек — под размер).
  for (const id of OMT_OUTPUTS) {
    const out = outputs.get(id)
    if (out && (!next.enabled[id] || out.sender.name !== next.names[id] || out.sender.size !== next.sizes[id])) {
      outputs.delete(id)
      await out.stop()
      publishOutput(id, { ...OMT_OUTPUT_OFF })
    }
  }
  publish(settingsPatch(next))
  // Что меняется на лету — частота и звук — у работающих выходов.
  for (const [id, out] of outputs) {
    out.setFps(next.fps[id])
    if (out instanceof WindowOutput) out.setAudio(id === 'program' && next.programAudio)
  }
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
    const out = makeOutput(lib, id, next.names[id], next.sizes[id], next.fps[id])
    try {
      outputs.set(id, out)
      out.start()
      if (out instanceof WindowOutput) out.setAudio(id === 'program' && next.programAudio)
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
    sizes: { ...cur.sizes },
    fps: { ...cur.fps },
    programAudio: v.programAudio === undefined ? cur.programAudio : v.programAudio === true,
    timerMessage: v.timerMessage === undefined ? cur.timerMessage : v.timerMessage === true,
  }
  const used = new Set<string>()
  for (const id of OMT_OUTPUTS) {
    if (v.enabled?.[id] !== undefined) out.enabled[id] = v.enabled[id] === true
    if (v.sizes?.[id] !== undefined) out.sizes[id] = cleanOmtResolution(Number(v.sizes[id]), cur.sizes[id])
    if (v.fps?.[id] !== undefined) out.fps[id] = cleanOmtFps(Number(v.fps[id]), cur.fps[id])
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
  publish(settingsPatch(s))
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
