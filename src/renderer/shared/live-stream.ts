/**
 * Живой вход в рендерере: пул постоянно удерживаемых потоков с внешних
 * устройств (USB-капчер HDMI, камера, айфон по Continuity).
 *
 * Устройство запоминается меткой (см. src/shared/live.ts), поэтому здесь на
 * каждом открытии делается резолв метка→deviceId через enumerateDevices.
 *
 * **Почему пул, а не поток на элемент.** Просьба Азата 2026-08-02: устройство
 * должно быть занято приложением с момента добавления в плейлист и до удаления
 * оттуда. Брать и отпускать его на каждое переключение превью/эфира нельзя:
 * капчер каждый раз пересогласовывает формат (секунда чёрного кадра), а
 * Continuity-камера айфона на отпускании вообще выходит из режима показа и
 * сама обратно не возвращается. Поэтому поток живёт в пуле, а <video> просто
 * подключается к нему через srcObject.
 *
 * Каждое окно (оператор / суфлёр / зал) держит свой пул. Это не «трижды занять
 * устройство»: Chromium открывает его физически один раз в capture-сервисе и
 * раздаёт копию каждому клиенту — проверено спайком на трёх окнах.
 * Оператор удерживает ВСЕ живые записи плейлиста (он и есть «держатель»),
 * зал и суфлёр — только то, что сейчас в эфире.
 */

import { cropWindowStream } from './window-crop'
import { OmtStream } from './omt-stream'
import { LiveAudio } from './live-audio'
import { parseLiveUri, normalizeWindowCrop } from '../../shared/live'
import { t } from '../../shared/i18n'

export type LiveStatus = 'off' | 'connecting' | 'live' | 'error'

export interface LiveState {
  status: LiveStatus
  /** Человеческий текст для плашки «нет сигнала»; null, когда всё хорошо. */
  message: string | null
}

const OFF: LiveState = { status: 'off', message: null }

/** Просим FullHD — иначе Chromium может молча выбрать 640×480. */
const VIDEO_CONSTRAINTS = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
}

/**
 * Вся «улучшайзинг»-обработка выключена принудительно. Это грабля номер один:
 * по умолчанию Chromium считает любой аудиовход микрофоном и включает эхо-
 * подавление, шумодав и авто-громкость — музыка диджея после этого звучит как
 * телефонный разговор.
 */
const AUDIO_PROCESSING_OFF = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

/**
 * Потолок ожидания getUserMedia. Обязателен: Electron запускается с
 * `--disable-features=TimeoutHangingVideoCaptureStarts`, то есть штатная защита
 * Chromium от зависшего старта захвата выключена. Без своего таймаута вызов на
 * подвисшем устройстве (выдернули на горячую, Continuity в плохом состоянии)
 * не возвращается никогда — и переподключение не наступает вообще.
 */
const OPEN_TIMEOUT_MS = 8000

/** Как часто проверяем живость потоков и пробуем поднять упавшие. */
const WATCHDOG_MS = 2000
/** Сколько подряд тиков «кадры не идут» терпим до пересборки потока. */
const STALL_TICKS = 3
/** Пауза между попытками переподключения после ошибки. */
const RETRY_MS = 5000

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Метка → устройство. Точное совпадение, иначе вхождение: метки одного и того
 * же устройства слегка разъезжаются между ОС и перевтыканиями (Windows
 * дописывает к имени vid:pid).
 */
function findDevice(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  label: string,
): MediaDeviceInfo | undefined {
  const pool = devices.filter((d) => d.kind === kind)
  const want = normalizeLabel(label)
  return (
    pool.find((d) => normalizeLabel(d.label) === want) ??
    pool.find((d) => normalizeLabel(d.label).includes(want) || want.includes(normalizeLabel(d.label)))
  )
}

class TimeoutError extends Error {
  constructor() {
    super('timeout')
    this.name = 'TimeoutError'
  }
}

/**
 * Ждать не дольше `ms`. Поток, который приехал после срока, гасим — иначе
 * устройство останется занятым ничьим захватом.
 */
function withTimeout(p: Promise<MediaStream>, ms: number): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      settled = true
      reject(new TimeoutError())
    }, ms)
    p.then(
      (stream) => {
        if (settled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        window.clearTimeout(timer)
        resolve(stream)
      },
      (err) => {
        if (settled) return
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Список устройств с настоящими метками. Пока доступ не выдан, браузер отдаёт
 * метки пустыми — берём разовый поток, чтобы их разблокировать, и сразу гасим.
 * Только для модалки выбора: в рабочем цикле пула эта проба недопустима, она
 * дёргает постороннюю камеру и может подвиснуть вместе с ней.
 */
export async function listMediaDevices(): Promise<MediaDeviceInfo[]> {
  let devices = await navigator.mediaDevices.enumerateDevices()
  if (devices.some((d) => d.kind === 'videoinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true })
      probe.getTracks().forEach((t) => t.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch {
      /* доступ не дали — вернём что есть, метки будут пустыми */
    }
  }
  return devices
}

function humanError(err: unknown, deviceLabel: string): string {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return t('Нет доступа к камере. Системные настройки → Конфиденциальность → Камера')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return t('Устройство занято другой программой: {name}', { name: deviceLabel })
  }
  if (name === 'OverconstrainedError') {
    return t('Устройство не отдаёт запрошенный формат: {name}', { name: deviceLabel })
  }
  if (name === 'NotFoundError') return t('Устройство не найдено: {name}', { name: deviceLabel })
  if (name === 'TimeoutError') return t('Устройство не отвечает: {name}', { name: deviceLabel })
  return t('Не удалось открыть вход: {name}', { name: deviceLabel })
}

/** Что источник реально отдаёт — для плашки диагностики у оператора. */
export interface LiveSettings {
  width: number
  height: number
  /** Частота кадров, заявленная устройством (не измеренная). */
  frameRate: number
}

interface PoolEntry {
  uri: string
  windowId?: string
  checkingWindow?: boolean
  missingWindowChecks?: number
  rawStream?: MediaStream
  disposeCrop?: () => void
  setCropFps?: (fps: number) => void
  setOmtAudio?: (enabled: boolean) => void
  fpsRevision?: number
  stream: MediaStream | null
  state: LiveState
  settings: LiveSettings | null
  /** Идёт getUserMedia — второй раз не дёргаем. */
  opening: boolean
  /** Время следующей попытки после ошибки (Date.now()). */
  retryAt: number
  /** Сколько тиков подряд от устройства не идут кадры. */
  stallTicks: number
}

/**
 * Пул живых входов окна. `retain()` задаёт, какие источники держать открытыми;
 * всё остальное отпускается. Вызывается на каждом изменении состояния, поэтому
 * обязан быть идемпотентным.
 */
export class LivePool {
  private entries = new Map<string, PoolEntry>()
  private listeners = new Set<() => void>()
  private timer: number | null = null

  constructor() {
    // Капчер могли воткнуть позже, кабель — передёрнуть, айфон — вернуть в
    // режим показа. Любое изменение списка устройств = повод попробовать снова
    // прямо сейчас, не дожидаясь окна ретрая.
    navigator.mediaDevices.addEventListener('devicechange', () => {
      for (const e of this.entries.values()) if (e.state.status === 'error') e.retryAt = 0
      this.tick()
    })
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  /** Держать открытыми ровно эти источники (и никакие другие). */
  retain(uris: string[]): void {
    const wanted = new Set(uris.filter(Boolean))
    // Слушатели пула сами дёргают retain() в ответ на onChange — уведомляем
    // только когда набор реально изменился, иначе получаем вечный цикл.
    let changed = false

    // The URI stores audio preference, but switching it must keep video alive.
    for (const uri of wanted) {
      if (this.entries.has(uri)) continue
      const source = parseLiveUri(uri)
      if (source?.kind !== 'omt') continue
      for (const [oldUri, entry] of this.entries) {
        const old = parseLiveUri(oldUri)
        if (wanted.has(oldUri) || entry.opening || !entry.stream || old?.kind !== 'omt' ||
            source.omtAddress !== old.omtAddress) continue
        this.entries.delete(oldUri)
        entry.uri = uri
        this.entries.set(uri, entry)
        entry.setOmtAudio?.(!!source.audioLabel)
        changed = true
        break
      }
    }

    // Changing only FPS retains the native desktop session and the crop canvas.
    for (const uri of wanted) {
      if (this.entries.has(uri)) continue
      const source = parseLiveUri(uri)
      if (source?.kind !== 'window') continue
      for (const [oldUri, entry] of this.entries) {
        const old = parseLiveUri(oldUri)
        if (wanted.has(oldUri) || entry.opening || !entry.stream || old?.kind !== 'window') continue
        if (source.windowId !== old.windowId || source.videoLabel !== old.videoLabel ||
            JSON.stringify(normalizeWindowCrop(source.windowCrop)) !== JSON.stringify(normalizeWindowCrop(old.windowCrop))) continue
        this.entries.delete(oldUri)
        entry.uri = uri
        this.entries.set(uri, entry)
        const revision = entry.fpsRevision = (entry.fpsRevision ?? 0) + 1
        void window.api.live.windowFps(source.windowFps).then(async fps => {
          if (this.entries.get(entry.uri) !== entry || entry.fpsRevision !== revision) return
          entry.setCropFps?.(fps)
          if (entry.settings) entry.settings.frameRate = fps
          if (this.entries.get(entry.uri) === entry) this.notify()
        }).catch(error => console.warn('Window capture FPS:', error))
        changed = true
        break
      }
    }

    for (const [uri, entry] of this.entries) {
      if (wanted.has(uri)) continue
      this.close(entry)
      this.entries.delete(uri)
      changed = true
    }
    for (const uri of wanted) {
      if (this.entries.has(uri)) continue
      changed = true
      this.entries.set(uri, {
        uri,
        stream: null,
        state: { status: 'connecting', message: null },
        settings: null,
        opening: false,
        retryAt: 0,
        stallTicks: 0,
      })
    }

    if (this.entries.size > 0 && this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), WATCHDOG_MS)
    } else if (this.entries.size === 0 && this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    this.tick()
    if (changed) this.notify()
  }

  get(uri: string | null): MediaStream | null {
    if (!uri) return null
    return this.entries.get(uri)?.stream ?? null
  }

  stateOf(uri: string | null): LiveState {
    if (!uri) return OFF
    return this.entries.get(uri)?.state ?? OFF
  }

  /** A temporary editor borrows raw tracks without opening another desktop capture. */
  borrowWindowSource(id: string, name: string): MediaStream | null {
    for (const entry of this.entries.values()) {
      const source = parseLiveUri(entry.uri)
      const raw = entry.rawStream ?? entry.stream
      if (source?.kind === 'window' && source.videoLabel === name && entry.windowId === id && raw) {
        const tracks = raw.getVideoTracks().filter(track => track.readyState === 'live')
        if (tracks.length) return raw
      }
    }
    return null
  }

  settingsOf(uri: string | null): LiveSettings | null {
    if (!uri) return null
    return this.entries.get(uri)?.settings ?? null
  }

  private close(entry: PoolEntry): void {
    entry.disposeCrop?.()
    entry.disposeCrop = undefined
    entry.setCropFps = undefined
    entry.setOmtAudio = undefined
    entry.rawStream = undefined
    if (entry.stream) {
      entry.stream.getTracks().forEach((t) => t.stop())
      entry.stream = null
    }
    entry.settings = null
  }

  private setState(entry: PoolEntry, status: LiveStatus, message: string | null): void {
    if (entry.state.status === status && entry.state.message === message) return
    entry.state = { status, message }
    this.notify()
  }

  /** Один проход: поднять недостающее, пересобрать зависшее. */
  private tick(): void {
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (entry.opening) continue

      if (entry.stream) {
        const source = parseLiveUri(entry.uri)
        // Network liveness is measured by received video, not a canvas track's muted bit.
        if (source?.kind === 'omt') continue
        if (source?.kind === 'window' && !entry.checkingWindow) {
          entry.checkingWindow = true
          const checkedStream = entry.stream
          void window.api.live.resolveWindow(source).then((id) => {
            if (this.entries.get(entry.uri) !== entry || entry.stream !== checkedStream) return
            entry.missingWindowChecks = 0
            if (id !== entry.windowId) {
              this.close(entry)
              this.setState(entry, 'connecting', null)
              void this.open(entry)
            }
          }).catch(() => {
            if (this.entries.get(entry.uri) !== entry || entry.stream !== checkedStream) return
            // An absent inventory entry is not evidence that this still-live capture ended.
            // macOS can omit the window during Spaces/fullscreen transitions.
            entry.missingWindowChecks = (entry.missingWindowChecks ?? 0) + 1
          }).finally(() => { entry.checkingWindow = false })
        }
        const track = (entry.rawStream ?? entry.stream).getVideoTracks()[0]
        // `ended` — устройство ушло совсем; `muted` — источник временно не
        // отдаёт кадры (ровно это выглядит как «картинка замерла»).
        const dead = !track || track.readyState === 'ended'
        const stalled = source?.kind !== 'window' && Boolean(track && track.muted)
        entry.stallTicks = stalled ? entry.stallTicks + 1 : 0
        if (dead || entry.stallTicks >= STALL_TICKS) {
          this.close(entry)
          entry.stallTicks = 0
          this.setState(entry, 'connecting', null)
          void this.open(entry)
        }
        continue
      }

      if (now >= entry.retryAt) void this.open(entry)
    }
  }

  private async open(entry: PoolEntry): Promise<void> {
    const source = parseLiveUri(entry.uri)
    if (!source) {
      this.setState(entry, 'error', t('Внешний вход задан неверно'))
      entry.retryAt = Number.MAX_SAFE_INTEGER
      return
    }
    entry.opening = true
    try {
      if (source.kind === 'omt') {
        const network = new OmtStream(source.omtAddress!, true, state => {
          if (this.entries.get(entry.uri) !== entry) return
          entry.settings = { width: state.width, height: state.height, frameRate: state.frameRate }
          this.setState(entry, state.status, state.message)
        })
        entry.stream = network.stream
        entry.setOmtAudio = enabled => network.setAudioEnabled(enabled)
        network.setAudioEnabled(!!source.audioLabel)
        entry.disposeCrop = () => network.dispose()
        entry.retryAt = 0
        this.setState(entry, 'connecting', null)
        return
      }
      let stream: MediaStream
      let windowFps = 30
      let nativeFps = 30
      if (source.kind === 'window') {
        const id = await window.api.live.resolveWindow(source)
        windowFps = await window.api.live.windowFps(source.windowFps)
        nativeFps = await window.api.live.windowFps(60)
        entry.windowId = id
        if (!this.entries.has(entry.uri)) return
        stream = await withTimeout(navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: {
            chromeMediaSource: 'desktop', chromeMediaSourceId: id,
            maxWidth: 1920, maxHeight: 1080, maxFrameRate: nativeFps,
          } } as unknown as MediaTrackConstraints,
        }), OPEN_TIMEOUT_MS)
      } else {
        // Здесь именно enumerateDevices, без пробы разблокировки меток: проба
        // берёт постороннюю камеру и на подвисшем железе виснет вместе с ней.
        const devices = await navigator.mediaDevices.enumerateDevices()
        // Пока ждали, запись могли убрать из плейлиста.
        if (!this.entries.has(entry.uri)) return

        const cam = findDevice(devices, 'videoinput', source.videoLabel)
        if (!cam) {
          entry.retryAt = Date.now() + RETRY_MS
          this.setState(entry, 'error', t('Устройство не найдено: {name}', { name: source.videoLabel }))
          return
        }
        const mic = source.audioLabel
          ? findDevice(devices, 'audioinput', source.audioLabel)
          : undefined

        // Звук тянем всегда, когда он задан у источника: подключать его позже
        // означало бы пересобрать поток и моргнуть картинкой в зале. Кто его
        // реально слышит, решают muted у элементов (audioRole/shouldMute).
        stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: cam.deviceId }, ...VIDEO_CONSTRAINTS },
            audio: mic ? { deviceId: { exact: mic.deviceId }, ...AUDIO_PROCESSING_OFF } : false,
          }),
          OPEN_TIMEOUT_MS,
        )
      }

      if (!this.entries.has(entry.uri)) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      if (source.kind === 'window') {
        const raw = stream
        const cropped = await cropWindowStream(raw, normalizeWindowCrop(source.windowCrop), windowFps, nativeFps)
        if (this.entries.get(entry.uri) !== entry) {
          cropped.dispose()
          cropped.stream.getTracks().forEach((t) => t.stop())
          return
        }
        entry.rawStream = raw
        entry.disposeCrop = cropped.dispose
        entry.setCropFps = cropped.setFps
        stream = cropped.stream
      }
      const track = stream.getVideoTracks()[0]
      const st = track?.getSettings() ?? {}
      entry.stream = stream
      entry.settings = {
        width: st.width ?? 0,
        height: st.height ?? 0,
        frameRate: source.kind === 'window' ? windowFps : Math.round(st.frameRate ?? 0),
      }
      entry.stallTicks = 0
      entry.missingWindowChecks = 0
      entry.retryAt = 0
      this.setState(entry, 'live', null)
    } catch (err) {
      entry.retryAt = Date.now() + RETRY_MS
      this.setState(entry, 'error', source.kind === 'window'
        ? t('Не удалось захватить окно: {name}. Проверьте доступ к записи экрана и выберите окно заново.', { name: source.videoLabel })
        : humanError(err, source.videoLabel))
    } finally {
      entry.opening = false
    }
  }
}

/**
 * Показ одного источника из пула в одном <video>. Элемент только подключается
 * к готовому потоку — устройство он не открывает и не закрывает.
 */
// ── Индикатор уровня звука ───────────────────────────────────────────────────
// Оператору нужно видеть, приходит ли звук с источника, ДО выдачи в эфир: в
// превью элемент немой, и на слух проверить нечего. Меряем сам поток через
// AnalyserNode — к выходу не подключаемся, поэтому измерение не озвучивает.

let sharedCtx: AudioContext | null = null

function audioContext(): AudioContext | null {
  try {
    if (!sharedCtx) sharedCtx = new AudioContext()
    if (sharedCtx.state === 'suspended') void sharedCtx.resume()
    return sharedCtx
  } catch {
    return null
  }
}

const METER_MS = 50
/** Спад пикового значения за тик — стрелка падает плавно, а не дёргается. */
const METER_DECAY = 0.12
const METER_FFT = 2048

/**
 * Аудиодорожка проигрываемого файла для измерения уровня.
 *
 * Спайк 2026-08-02: с НЕМОГО `<video>` уровень снять нельзя ничем — ни
 * `captureStream()`, ни `createMediaElementSource` (оба дают ровные нули,
 * контрольный незаглушённый элемент — реальные пики). Поэтому измерять имеет
 * смысл только там, где элемент реально звучит: в окне-озвучивателе или в
 * превью с включённой предпрослушкой.
 *
 * `captureStream()` выбран вместо `createMediaElementSource`, потому что это
 * тап: он не перехватывает выход элемента. `createMediaElementSource` увёл бы
 * звук в граф Web Audio, сломав маршрутизацию через `setSinkId`.
 */
const capturedStreams = new WeakMap<HTMLMediaElement, { src: string; stream: MediaStream }>()

export function elementAudioStream(el: HTMLMediaElement | null): MediaStream | null {
  if (!el || !el.currentSrc) return null
  const cached = capturedStreams.get(el)
  // Файл сменился — прежние дорожки закончились, нужен новый тап.
  if (cached && cached.src === el.currentSrc) return cached.stream
  const capture = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream
  if (typeof capture !== 'function') return null
  try {
    const stream = capture.call(el)
    capturedStreams.set(el, { src: el.currentSrc, stream })
    return stream
  } catch {
    return null
  }
}

export class LiveMeter {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private buf = new Float32Array(METER_FFT)
  private value = 0
  private timer: number | null = null

  /** Идемпотентно: вызывается на каждом тике UI. */
  attach(stream: MediaStream | null): void {
    if (stream === this.stream) return
    this.detach()
    this.stream = stream
    if (!stream || stream.getAudioTracks().length === 0) return

    const ctx = audioContext()
    if (!ctx) return
    try {
      this.source = ctx.createMediaStreamSource(stream)
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = METER_FFT
      this.source.connect(this.analyser)
    } catch {
      this.detach()
      return
    }
    this.timer = window.setInterval(() => this.sample(), METER_MS)
  }

  /** Есть ли у источника звуковая дорожка вообще (иначе индикатор не рисуем). */
  hasAudio(): boolean {
    return this.analyser !== null
  }

  /** Пиковый уровень 0..1. */
  level(): number {
    return this.value
  }

  private sample(): void {
    if (!this.analyser) return
    this.analyser.getFloatTimeDomainData(this.buf)
    let peak = 0
    for (let i = 0; i < this.buf.length; i++) {
      const a = Math.abs(this.buf[i])
      if (a > peak) peak = a
    }
    this.value = peak > this.value ? peak : this.value * (1 - METER_DECAY)
  }

  private detach(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.source?.disconnect()
      this.analyser?.disconnect()
    } catch {
      /* контекст мог уже закрыться */
    }
    this.source = null
    this.analyser = null
    this.stream = null
    this.value = 0
  }
}

export class LiveView {
  private shownStream: MediaStream | null = null
  private audio = new LiveAudio()
  private directAudio = false

  /** Измеренная частота кадров (не заявленная) — считаем по факту доставки. */
  private frames = 0
  private windowStartedAt = 0
  private measuredFps = 0
  private frameCallback: number | null = null

  constructor(
    private el: HTMLVideoElement,
    private pool: LivePool,
  ) {
    this.scheduleFrameCount()
  }

  /**
   * Реальный fps на экране. Заявленный устройством и фактический расходятся:
   * Continuity-камера по Wi-Fi первые секунды отдаёт единицы кадров, пока
   * не разгонит канал, хотя в settings честно пишет 30.
   */
  fps(): number {
    return this.measuredFps
  }

  configureAudio(muted: boolean, sink: string | null): void {
    this.audio.configure(muted, sink, this.el.volume)
  }

  private scheduleFrameCount(): void {
    const el = this.el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number
    }
    if (typeof el.requestVideoFrameCallback !== 'function' || this.frameCallback !== null) return
    this.frameCallback = el.requestVideoFrameCallback((now) => {
      this.frameCallback = null
      if (this.windowStartedAt === 0) this.windowStartedAt = now
      else this.frames += 1
      const elapsed = now - this.windowStartedAt
      if (elapsed >= 1000) {
        this.measuredFps = Math.round((this.frames * 1000) / elapsed)
        this.frames = 0
        this.windowStartedAt = now
      }
      this.scheduleFrameCount()
    })
  }

  /** `uri = null` — погасить элемент. Возвращает состояние источника. */
  show(uri: string | null): LiveState {
    const state = this.pool.stateOf(uri)
    const stream = this.pool.get(uri)

    if (stream !== this.shownStream) {
      this.shownStream = stream
      this.directAudio = this.audio.attach(parseLiveUri(uri ?? '')?.kind === 'omt' ? stream : null)
      // Generated audio already has a playout clock. Feeding it through video
      // adds Chromium's adaptive clock and can shift pitch after an underrun.
      const displayStream = this.directAudio && stream ? new MediaStream(stream.getVideoTracks()) : stream
      if (displayStream !== this.el.srcObject) this.el.srcObject = displayStream
      if (this.frameCallback !== null) this.el.cancelVideoFrameCallback(this.frameCallback)
      this.frameCallback = null
      this.frames = 0
      this.windowStartedAt = 0
      this.measuredFps = 0
      if (stream) {
        // Показать элемент ДО play(): у скрытого (display:none) <video>
        // Chromium приостанавливает воспроизведение MediaStream — картинка
        // успевает появиться и замирает через пару секунд.
        this.el.classList.remove('hidden')
        this.el.play().catch(() => undefined)
        this.scheduleFrameCount()
      }
    }
    this.el.classList.toggle('hidden', state.status !== 'live')
    return state
  }
}
