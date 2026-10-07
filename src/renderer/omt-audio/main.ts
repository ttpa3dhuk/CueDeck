/**
 * Звук выхода OMT «Зал» (main/omt/outputs.ts). Скрытое окно: getDisplayMedia →
 * main подставляет окно зала (захват вкладки внутри Chromium, тот же путь, что
 * у трансляции), берём только звук и отдаём в main сырыми семплами
 * (32 бит float, по каналам подряд) — OMT принимает ровно такой формат.
 *
 * Захват идёт на частоте звуковой карты (у мака часто 44,1 кГц) мелкими
 * кусками по 128 семплов. Пропускаем через Web Audio на 48 кГц (стандарт
 * видео — vMix, микшеры) и отдаём кусками по 20 мс, а не 350 раз в секунду.
 * Web Audio здесь безопасен: это поток, а не <video>.
 *
 * Окно зала пересоздаётся при смене раскладки — захват кончается, снимаем заново.
 */

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<T>
}

const api = window.api

function diag(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  api.diag.log(level, `omt-audio: ${msg}`, data)
}

const SAMPLE_RATE = 48000
const CHANNELS = 2
const CHUNK = 960 // 20 мс

const ac = new AudioContext({ sampleRate: SAMPLE_RATE })
const out = ac.createMediaStreamDestination()
out.channelCount = CHANNELS
let source: MediaStreamAudioSourceNode | null = null
void ac.resume()

// Копилка до CHUNK семплов на канал.
const acc = Array.from({ length: CHANNELS }, () => new Float32Array(CHUNK))
let filled = 0

function flush(): void {
  const data = new Float32Array(CHUNK * CHANNELS)
  for (let c = 0; c < CHANNELS; c++) data.set(acc[c], c * CHUNK)
  api.omt.sendAudio({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frames: CHUNK, data })
  filled = 0
}

// Выход Web Audio → куски по 20 мс в main.
void (async () => {
  const reader = new MediaStreamTrackProcessor<AudioData>({ track: out.stream.getAudioTracks()[0] }).readable.getReader()
  const tmp = new Float32Array(4096)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    try {
      const frames = value.numberOfFrames
      let pos = 0
      while (pos < frames) {
        const n = Math.min(CHUNK - filled, frames - pos)
        for (let c = 0; c < CHANNELS; c++) {
          const plane = Math.min(c, value.numberOfChannels - 1)
          value.copyTo(tmp.subarray(0, n), { planeIndex: plane, frameOffset: pos, frameCount: n, format: 'f32-planar' })
          acc[c].set(tmp.subarray(0, n), filled)
        }
        filled += n
        pos += n
        if (filled === CHUNK) flush()
      }
    } catch (e) {
      diag('warn', 'кусок звука не скопировался', String(e)) // i18n-ok: журнал
    }
    value.close()
  }
})()

let retry: ReturnType<typeof setTimeout> | null = null

function scheduleCapture(ms: number): void {
  if (retry) return
  retry = setTimeout(() => {
    retry = null
    void capture()
  }, ms)
}

async function capture(): Promise<void> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Без видео getDisplayMedia не работает; берём крошечное и сразу гасим.
      video: { width: { ideal: 16 }, height: { ideal: 16 }, frameRate: { ideal: 1 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } as MediaTrackConstraints,
    })
  } catch (e) {
    scheduleCapture(1000)
    return
  }
  stream.getVideoTracks().forEach((t) => t.stop())
  const at = stream.getAudioTracks()[0]
  if (!at) {
    diag('warn', 'у окна зала нет звука, повтор') // i18n-ok: журнал
    stream.getTracks().forEach((t) => t.stop())
    scheduleCapture(2000)
    return
  }
  diag('info', 'звук зала захвачен') // i18n-ok: журнал
  at.addEventListener('ended', () => {
    diag('info', 'захват звука зала закончился — перезахват') // i18n-ok: журнал
    scheduleCapture(500)
  })

  source?.disconnect()
  source = ac.createMediaStreamSource(new MediaStream([at]))
  source.connect(out)
}


void capture()
