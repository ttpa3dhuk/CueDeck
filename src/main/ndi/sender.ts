import type { NativeImage } from 'electron'
import os from 'node:os'
import log from 'electron-log/main'
import { t } from '../../shared/i18n.js'
import type { NdiFps, NdiResolution, NdiOutputStatus } from '../../shared/types.js'
import { NDI_FOURCC_BGRA, NDI_FOURCC_BGRX, NDI_FRAME_FORMAT_PROGRESSIVE, NDI_TIMECODE_SYNTHESIZE, type NdiLib } from './libndi-native.js'

import { ndiFrameSize } from './frame-size.js'
import type { ProgramVideoCursor } from '../program-playout.js'
import { programBitmap } from '../program-bitmap-cache.js'

/** Кадр для NDI: BGRA c прямой альфой либо BGRX. */
interface RawFrame {
  width: number
  height: number
  buf: Buffer
}

type StatusFn = (s: Partial<NdiOutputStatus>) => void

/** Кусок звука из общего захвата эфира: float по каналам подряд (planar). */
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
export class NdiSender {
  private inst: unknown = null
  /** Последний принятый кадр — уходит получателям с постоянной частотой. */
  private current: RawFrame | null = null
  private pendingImage: NativeImage | null = null
  private programCursor: ProgramVideoCursor | null = null
  private programEpoch = -1
  private missedNativeSlot = false
  private lastSubmitAt = 0
  private earlyWake: NodeJS.Timeout | null = null
  /** Кадр, отправленный последним: держим ссылку, пока NDI его кодирует. */
  private lastSent: RawFrame | null = null
  private pump: NodeJS.Timeout | null = null
  private nextAt = 0
  private poll: NodeJS.Timeout | null = null
  private closing = false
  private sending: RawFrame | null = null
  private stopping: Promise<void> | null = null
  private destroying = false
  private onStopped: (() => void) | null = null
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
    this.inst = lib.sendCreate({ p_ndi_name: this.name, p_groups: null, clock_video: false, clock_audio: false })
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
    if (this.sending && this.programCursor) this.missedNativeSlot = true
    else this.sendCurrent()
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
    const st = this.stats
    const sourceFrames = this.programCursor ? this.programCursor.takeSourceCaptures() : st.pushed
    if (this.receivers > 0) {
      log.info(
        `ndi: «${this.name}» за ${dt.toFixed(0)} с: кадров от источника ${(sourceFrames / dt).toFixed(1)}/с, ` + // i18n-ok: журнал
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

  /** Keep only the latest image; conversion happens at output cadence, never in the shared tap. */
  push(image: NativeImage): void {
    if (this.closing || image.isEmpty()) return
    this.stats.pushed++
    this.pendingImage = image
  }

  setProgramCursor(cursor: ProgramVideoCursor | null): void {
    this.programCursor = cursor
    this.programEpoch = cursor?.epoch ?? -1
    this.current = null
    this.pendingImage = null
  }

  /** Байты кадра; шире выбранного разрешения (Retina, 4K-проектор) — ужимаем. */
  private toRaw(image: NativeImage): RawFrame | null {
    const source = image.getSize()
    const target = ndiFrameSize(source.width, source.height, this.size)
    if (!target) return null
    const shared = this.programCursor ? programBitmap(image, target.width, target.height) : null
    const img = shared ? null : source.width !== target.width || source.height !== target.height
      ? image.resize({ ...target, quality: 'good' }) : image
    const { width, height } = shared ?? img!.getSize()
    if (width < 16 || height < 16) return null
    const bitmap = shared?.bitmap ?? img!.toBitmap()
    if (bitmap.length !== width * height * 4) return null
    if (!this.alpha) return { width, height, buf: bitmap }

    // Chromium bitmaps have premultiplied alpha. NDI BGRA expects straight alpha.
    const buf = Buffer.from(bitmap)
    for (let offset = 0; offset < buf.length; offset += 4) {
      const alpha = buf[offset + 3]
      if (alpha === 0 || alpha === 255) continue
      for (let channel = offset; channel < offset + 3; channel++) {
        buf[channel] = Math.min(255, Math.round(buf[channel] * 255 / alpha))
      }
    }
    return { width, height, buf }
  }

  private sendCurrent(): void {
    if (!this.inst || this.closing || this.sending) return
    if (this.programCursor && this.lastSubmitAt > 0) {
      const remaining = 1000 / this.fps - (performance.now() - this.lastSubmitAt)
      if (remaining > 1) {
        if (!this.earlyWake) this.earlyWake = setTimeout(() => {
          this.earlyWake = null
          this.sendCurrent()
        }, remaining)
        return
      }
    }
    if (this.programCursor) {
      if (this.programEpoch !== this.programCursor.epoch) {
        this.programEpoch = this.programCursor.epoch
        this.current = null
      }
      const selected = this.programCursor.next(this.fps)
      if (selected) {
        const raw = this.toRaw(selected.image)
        if (raw) this.current = raw
      }
    }
    if (this.pendingImage) {
      const image = this.pendingImage
      this.pendingImage = null
      const raw = this.toRaw(image)
      if (raw) this.current = raw
    }
    const f = this.current
    if (!f) return
    const frame = {
      xres: f.width,
      yres: f.height,
      FourCC: this.alpha ? NDI_FOURCC_BGRA : NDI_FOURCC_BGRX,
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
    // NDI's async API may wait for the previous frame. Run the FFI call off
    // main, with one outstanding call and only the latest pending image.
    // Both buffers stay alive until native has returned from the next send.
    this.sending = f
    this.lastSubmitAt = performance.now()
    const complete = (error: Error | null): void => {
      if (!error) { this.lastSent = f; this.stats.sent++ }
      this.sending = null
      if (error) {
        this.onStatus({ state: 'error', error: error.message })
        void this.stop()
      }
      if (this.closing) this.finishStop()
      else if (this.programCursor && this.missedNativeSlot) {
        this.missedNativeSlot = false
        // One overdue slot, never a recursive native call from a sync mock.
        if (performance.now() - this.lastSubmitAt >= 1000 / this.fps - 2)
          setTimeout(() => { if (!this.closing && !this.sending) this.sendCurrent() }, 0)
      }
    }
    try { this.lib.sendVideoAsync.async(this.inst, frame, complete) }
    catch (error) { complete(error as Error) }
  }

  /**
   * Звук зала. Метки NDI синтезирует сам (NDI_TIMECODE_SYNTHESIZE) и сводит со
   * звуком видео; отдаём planar float (FLTP), каналы подряд.
   */
  pushAudio(chunk: NdiAudioChunk): void {
    if (!this.inst || this.closing) return
    const { sampleRate, channels, frames, data } = chunk
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isInteger(channels) || channels < 1 || channels > 16 ||
      !Number.isInteger(frames) || frames < 1 || frames > sampleRate || data.length < frames * channels) return
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
    if (this.stopping) return this.stopping
    if (this.pump) clearTimeout(this.pump)
    if (this.earlyWake) clearTimeout(this.earlyWake)
    this.earlyWake = null
    if (this.poll) clearInterval(this.poll)
    this.pump = this.poll = null
    this.current = null
    this.pendingImage = null
    this.programCursor = null
    this.closing = true
    this.stopping = new Promise((resolve) => { this.onStopped = resolve })
    this.finishStop()
    return this.stopping
  }

  private finishStop(): void {
    if (this.sending || this.destroying) return
    const complete = (): void => {
      this.inst = null
      this.current = this.lastSent = null
      this.onStopped?.()
      this.onStopped = null
    }
    if (!this.inst) { complete(); return }
    this.destroying = true
    // Destroy also synchronizes the last NDI send. Retain its buffer and keep
    // the event loop available until the native completion callback.
    const destroyed = (error: Error | null): void => {
      if (error) {
        log.warn(`ndi: source destruction failed: ${error.message}`)
        // Do not reuse a handle whose destruction outcome is unknown.
      }
      log.info(`ndi: «${this.name}» остановлен`)
      complete()
    }
    try { this.lib.sendDestroy.async(this.inst, destroyed) }
    catch (error) { destroyed(error as Error) }
  }

  /** Process exit must never race a native call that is still in flight. */
  destroyNow(): void {
    this.closing = true
    if (this.pump) clearTimeout(this.pump)
    if (this.poll) clearInterval(this.poll)
    if (this.inst && !this.sending && !this.destroying) this.lib.sendDestroy(this.inst)
    this.inst = null
  }
}
