import type { StreamSettings } from '../../preload/api'

/**
 * Скрытое окно-кодировщик трансляции (main/stream/streamer.ts).
 *
 * Картинка: getDisplayMedia → main подставляет окно зала (захват вкладки внутри
 * Chromium). Захват шлёт кадры только когда картинка меняется, а площадкам
 * нужен ровный поток — поэтому свой таймер на заданную частоту рисует
 * последний кадр в холст нужного размера (с полями, если зал не 16:9) и
 * кодирует его. Пропал захват (зал пересоздан сменой раскладки) — повторяем
 * последний кадр и перезахватываем.
 *
 * Звук: эфир зала (звук вкладки) + аудиовход с пульта → Web Audio микс →
 * AAC. Здесь Web Audio безопасен: это потоки, а не <video>-элементы
 * (LESSONS: createMediaElementSource уводит звук элемента).
 */

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<T>
}

const api = window.api.streamEnc
const diag = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void =>
  window.api.diag.log(level, `stream-enc: ${msg}`, data)

let settings: StreamSettings = await api.init()
const width = Math.round((settings.height * 16) / 9 / 2) * 2
const height = settings.height
const fps = settings.fps
const SAMPLE_RATE = 48000

const t0 = performance.now()
const t0Wall = Date.now()
const nowMs = (): number => performance.now() - t0

// ── состояние для main ──────────────────────────────────────────────────────

let encodedFrames = 0
let skippedFrames = 0
let fatal: string | null = null
let videoLive = false

setInterval(() => {
  api.status({
    state: fatal ? 'error' : configSent ? 'ok' : 'starting',
    error: fatal ?? undefined,
    fps: encodedFrames,
    skipped: skippedFrames,
    video: videoLive,
  })
  encodedFrames = 0
  skippedFrames = 0
}, 1000)

// ── кодеки ──────────────────────────────────────────────────────────────────

/** Уровень H.264 по размеру и частоте кадров (High / Main / Baseline по очереди). */
function avcLevel(): string {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps
  if (mbps <= 108000) return '1F' // 3.1
  if (mbps <= 216000) return '20' // 3.2
  if (mbps <= 245760) return '28' // 4.0
  if (mbps <= 522240) return '2A' // 4.2
  if (mbps <= 589824) return '32' // 5.0
  if (mbps <= 983040) return '33' // 5.1
  return '34' // 5.2
}

async function videoConfig(): Promise<VideoEncoderConfig> {
  const base = {
    width,
    height,
    bitrate: settings.videoKbps * 1000,
    framerate: fps,
    latencyMode: 'realtime' as const,
    bitrateMode: 'constant' as const,
    avc: { format: 'avc' as const },
  }
  const lvl = avcLevel()
  for (const hw of ['prefer-hardware', 'no-preference'] as const) {
    for (const profile of ['6400', '4D00', '4200']) {
      const cfg: VideoEncoderConfig = { ...base, codec: `avc1.${profile}${lvl}`, hardwareAcceleration: hw }
      const r = await VideoEncoder.isConfigSupported(cfg).catch(() => null)
      if (r?.supported) return cfg
    }
  }
  throw new Error(`H.264 ${width}x${height}@${fps}`)
}

let avcC: Uint8Array | null = null
let asc: Uint8Array | null = null
let configSent = false
/** Пакеты до отправки конфигурации: первый ключевой кадр терять нельзя. */
const early: Array<() => void> = []

function maybeSendConfig(): void {
  if (configSent || !avcC || !asc) return
  configSent = true
  api.config({ width, height, fps, avcC, sampleRate: SAMPLE_RATE, channels: 2, asc, t0: t0Wall })
  diag('info', `конфигурация ${width}x${height}@${fps}, ${settings.videoKbps} кбит/с`)
  for (const f of early.splice(0)) f()
}

function emit(f: () => void): void {
  if (configSent) f()
  else if (early.length < 600) early.push(f)
}

const vEnc = new VideoEncoder({
  output: (chunk, meta) => {
    const desc = meta?.decoderConfig?.description
    if (desc && !avcC) {
      avcC = new Uint8Array(desc instanceof ArrayBuffer ? desc.slice(0) : (desc as ArrayBufferView).buffer.slice(0))
      maybeSendConfig()
    }
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    const ts = chunk.timestamp / 1000
    const key = chunk.type === 'key'
    encodedFrames++
    emit(() => api.video(ts, key, data))
  },
  error: (e) => {
    fatal = String(e)
    diag('error', 'видеокодер', String(e))
  },
})

try {
  vEnc.configure(await videoConfig())
} catch (e) {
  fatal = `H.264: ${String(e)}`
  diag('error', 'видеокодер не настроился', String(e))
}

// AAC: метки считаем сами по числу сэмплов, привязанных к общему часу (см. ниже).
let aacFrames = 0
let aacBaseMs: number | null = null
const aEnc = new AudioEncoder({
  output: (chunk, meta) => {
    const desc = meta?.decoderConfig?.description
    if (desc && !asc) {
      asc = new Uint8Array(desc instanceof ArrayBuffer ? desc.slice(0) : (desc as ArrayBufferView).buffer.slice(0))
      maybeSendConfig()
    }
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    const wall = nowMs()
    let ts = (aacBaseMs ?? wall) + (aacFrames * 1024 * 1000) / SAMPLE_RATE
    // Часы звуковой карты и компьютера расходятся на десятки ppm — за часы
    // эфира это сотни мс рассинхрона. Разошлись больше чем на 150 мс — подтягиваем.
    if (aacBaseMs === null || Math.abs(ts - wall) > 150) {
      aacBaseMs = wall - (aacFrames * 1024 * 1000) / SAMPLE_RATE
      ts = wall
    }
    aacFrames++
    emit(() => api.audio(ts, data))
  },
  error: (e) => {
    fatal = String(e)
    diag('error', 'аудиокодер', String(e))
  },
})
aEnc.configure({ codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: settings.audioKbps * 1000 })

// ── звук: микс эфира и пульта ───────────────────────────────────────────────

const ac = new AudioContext({ sampleRate: SAMPLE_RATE })
const mixOut = ac.createMediaStreamDestination()
mixOut.channelCount = 2
const mixBus = ac.createGain()
mixBus.channelCount = 2
mixBus.channelCountMode = 'explicit'
mixBus.connect(mixOut)
const programGain = ac.createGain()
const inputGain = ac.createGain()
programGain.connect(mixBus)
inputGain.connect(mixBus)

const splitter = ac.createChannelSplitter(2)
mixBus.connect(splitter)
const analysers = [ac.createAnalyser(), ac.createAnalyser()]
analysers.forEach((a, i) => {
  a.fftSize = 1024
  splitter.connect(a, i)
})
const levelBuf = new Float32Array(1024)
setInterval(() => {
  const lv = analysers.map((a) => {
    a.getFloatTimeDomainData(levelBuf)
    let peak = 0
    for (const v of levelBuf) peak = Math.max(peak, Math.abs(v))
    return Math.min(1, peak)
  }) as [number, number]
  api.level(lv)
}, 100)

const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))

function applyGains(): void {
  programGain.gain.setTargetAtTime(settings.programOn ? dbToGain(settings.programGainDb) : 0, ac.currentTime, 0.02)
  inputGain.gain.setTargetAtTime(settings.inputOn ? dbToGain(settings.inputGainDb) : 0, ac.currentTime, 0.02)
}
applyGains()
void ac.resume()

// Микс → AAC.
void (async () => {
  const track = mixOut.stream.getAudioTracks()[0]
  const reader = new MediaStreamTrackProcessor<AudioData>({ track }).readable.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (aEnc.state === 'configured') aEnc.encode(value)
    value.close()
  }
})()

const AUDIO_PROCESSING_OFF = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

// Вход с пульта — по метке устройства.
let inputNode: MediaStreamAudioSourceNode | null = null
let inputStream: MediaStream | null = null
let inputLabelOpen: string | null = null

async function syncInput(): Promise<void> {
  const want = settings.inputLabel
  if (want === inputLabelOpen && (want === null || inputNode)) return
  inputNode?.disconnect()
  inputStream?.getTracks().forEach((t) => t.stop())
  inputNode = null
  inputStream = null
  inputLabelOpen = want
  if (!want) return
  const devs = await navigator.mediaDevices.enumerateDevices()
  const dev = devs.find((d) => d.kind === 'audioinput' && d.label === want)
  if (!dev) {
    diag('warn', `вход не найден: ${want}`)
    return
  }
  try {
    inputStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: dev.deviceId }, channelCount: 2, ...AUDIO_PROCESSING_OFF },
    })
    inputNode = ac.createMediaStreamSource(inputStream)
    inputNode.connect(inputGain)
    diag('info', `вход с пульта: ${want}`)
  } catch (e) {
    diag('warn', `вход не открылся: ${want}`, String(e))
  }
}
void syncInput()
navigator.mediaDevices.addEventListener('devicechange', () => {
  // Пульт перевоткнули — открыть заново.
  inputLabelOpen = inputNode ? inputLabelOpen : null
  void syncInput()
})

// ── картинка: захват окна зала ──────────────────────────────────────────────

const canvas = new OffscreenCanvas(width, height)
const ctx = canvas.getContext('2d', { alpha: false })!
ctx.fillStyle = '#000'
ctx.fillRect(0, 0, width, height)
let latest: VideoFrame | null = null
let fresh = false
let programNode: MediaStreamAudioSourceNode | null = null
let captureTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCapture(ms: number): void {
  if (captureTimer) return
  captureTimer = setTimeout(() => {
    captureTimer = null
    void capture()
  }, ms)
}

async function capture(): Promise<void> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
      audio: { ...AUDIO_PROCESSING_OFF, channelCount: 2 } as MediaTrackConstraints,
    })
  } catch (e) {
    videoLive = false
    diag('warn', 'окно зала не захватилось, повтор', String(e))
    scheduleCapture(1000)
    return
  }
  const vt = stream.getVideoTracks()[0]
  const at = stream.getAudioTracks()[0]
  videoLive = true
  diag('info', 'окно зала захвачено', { audio: !!at })

  programNode?.disconnect()
  programNode = null
  if (at) {
    programNode = ac.createMediaStreamSource(new MediaStream([at]))
    programNode.connect(programGain)
  }

  const onEnded = (): void => {
    if (!videoLive) return
    videoLive = false
    stream.getTracks().forEach((t) => t.stop())
    diag('info', 'захват окна зала закончился — перезахват')
    scheduleCapture(500)
  }
  vt.addEventListener('ended', onEnded)

  const reader = new MediaStreamTrackProcessor<VideoFrame>({ track: vt }).readable.getReader()
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }))
    if (done || !value) break
    latest?.close()
    latest = value
    fresh = true
  }
  onEnded()
}
void capture()

// ── ровный поток кадров ─────────────────────────────────────────────────────

const frameMs = 1000 / fps
const gop = Math.max(1, Math.round(fps * settings.keyframeSec))
let frameNo = 0
let forceKey = false

api.onKeyframe(() => {
  forceKey = true
})

function drawLatest(): void {
  if (!latest || !fresh) return
  fresh = false
  const sw = latest.displayWidth
  const sh = latest.displayHeight
  const k = Math.min(width / sw, height / sh)
  const dw = Math.round(sw * k)
  const dh = Math.round(sh * k)
  if (dw !== width || dh !== height) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(latest, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh)
}

/** Номер последнего закодированного слота сетки кадров. */
let lastSlot = -1

function frameTick(): void {
  // Таймер браузера срабатывает и чуть раньше срока — считаем слоты сетки,
  // иначе в одну клетку попадало два кадра (33 к/с вместо 30).
  const slot = Math.round(nowMs() / frameMs)
  if (slot > lastSlot && vEnc.state === 'configured') {
    lastSlot = slot
    // Кодер не успевает (слабый ноут) — пропускаем кадр, а не копим очередь.
    if (vEnc.encodeQueueSize <= 2) {
      drawLatest()
      const frame = new VideoFrame(canvas, { timestamp: Math.round(slot * frameMs * 1000) })
      const key = forceKey || frameNo % gop === 0
      if (key) forceKey = false
      vEnc.encode(frame, { keyFrame: key })
      frame.close()
      frameNo++
    } else {
      skippedFrames++
    }
  }
  setTimeout(frameTick, Math.max(1, (lastSlot + 1) * frameMs - nowMs()))
}
frameTick()

// ── живые настройки: громкости и вход ───────────────────────────────────────

api.onSettings((s) => {
  settings = s
  applyGains()
  void syncInput()
})
