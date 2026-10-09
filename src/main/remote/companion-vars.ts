import type { AppState } from '../../shared/types.js'
import { formatMs, timerView } from '../../renderer/shared/timer.js'
import { neighbour, programHasVideo, type RemoteStateView } from './commands.js'

/**
 * Переменные, которые CueDeck сам отправляет в Bitfocus Companion
 * (`POST /api/custom-variable/<имя>/value?value=…`, companion-push.ts), —
 * чтобы на кнопках Stream Deck жили таймер, «осталось N слайдов», остаток
 * ролика, имя следующего спикера. Без Electron, покрыто тестами.
 *
 * Этот же список кладётся в готовую страницу Companion (companion/build.ts):
 * Companion пишет только в уже существующие custom-переменные, поэтому они
 * должны приехать в файле импорта. Переименование переменной = новая версия
 * файла страницы у всех клиентов — менять имена только осознанно.
 *
 * Все значения — строки (Companion так и хранит). Флаги — '1' / '0'.
 */

export const COMPANION_VARS = {
  cuedeck_online: 'CueDeck запущен и шлёт данные: 1 / 0',
  cuedeck_seen:
    'Когда CueDeck последний раз слал данные (unix-секунды). Отстаёт от $(internal:time_unix) больше чем на 10 с — CueDeck упал или сеть пропала',
  cuedeck_timer: 'Таймер как на суфлёре: 04:59, −00:12 (или часы в режиме «часы»)',
  cuedeck_timer_color: 'Цвет таймера: green / yellow / red / neutral',
  cuedeck_timer_over: 'Время вышло (обратный отсчёт ушёл в минус): 1 / 0',
  cuedeck_timer_running: 'Таймер идёт: 1 / 0',
  cuedeck_slide: 'Слайд в эфире: 3/12 (пусто, если листать нечего)',
  cuedeck_slides_left: 'Сколько слайдов осталось после текущего: 9',
  cuedeck_program: 'Что в эфире (имя записи плейлиста или файла)',
  cuedeck_preview: 'Что в превью — уйдёт в зал по ЭФИР',
  cuedeck_next: 'Какую запись поставит в превью «следующий спикер»',
  cuedeck_video: 'Остаток ролика в эфире: 00:13 (пусто, если ролика нет)',
  cuedeck_video_playing: 'Ролик в эфире играет: 1 / 0',
  cuedeck_muted: 'Звук эфира выключен: 1 / 0',
  cuedeck_blackout: 'Заставка / blackout включены: 1 / 0',
  cuedeck_message: 'Сообщение спикеру на суфлёре (пусто — нет)',
  cuedeck_stream_running: 'Трансляция включена (кнопка STREAM нажата): 1 / 0',
  cuedeck_stream_warn: 'С трансляцией что-то не так — площадка переподключается, нет картинки, сеть не успевает: 1 / 0',
  cuedeck_stream_live: 'Сколько площадок сейчас в эфире: 2',
  cuedeck_stream_total: 'Сколько площадок включено всего: 3',
  cuedeck_timer_preset_1: 'Пресет таймера 1, минуты: 5 (пусто, если пресета нет)',
  cuedeck_timer_preset_2: 'Пресет таймера 2, минуты: 10 (пусто, если пресета нет)',
  cuedeck_timer_preset_3: 'Пресет таймера 3, минуты: 15 (пусто, если пресета нет)',
  cuedeck_timer_preset_4: 'Пресет таймера 4, минуты: 20 (пусто, если пресета нет)',
  cuedeck_program_index: 'Номер записи плейлиста в эфире, как на карточке: 3 (пусто, если в эфире не из плейлиста)',
  cuedeck_preview_index: 'Номер записи плейлиста в превью, как на карточке: 4 (пусто, если нет)',
  cuedeck_message_preset_1: 'Текст пресета сообщения 1 (пусто, если пресета нет)',
  cuedeck_message_preset_2: 'Текст пресета сообщения 2 (пусто, если пресета нет)',
  cuedeck_message_preset_3: 'Текст пресета сообщения 3 (пусто, если пресета нет)',
  cuedeck_message_preset_4: 'Текст пресета сообщения 4 (пусто, если пресета нет)',
  cuedeck_message_preset_5: 'Текст пресета сообщения 5 (пусто, если пресета нет)',
  cuedeck_message_preset_6: 'Текст пресета сообщения 6 (пусто, если пресета нет)',
  cuedeck_omt_on: 'Выход OMT «Зал» включён: 1 / 0',
  cuedeck_omt_program: 'vMix держит «Зал» в эфире (красная лампа OMT): 1 / 0',
  cuedeck_omt_preview: 'vMix держит «Зал» в превью (зелёная лампа OMT): 1 / 0',
  cuedeck_omt_receivers: 'Сколько получателей забирают «Зал» по OMT: 2',
} as const

export type CompanionVarName = keyof typeof COMPANION_VARS

/** Те же описания для английской страницы Companion (companion/build.ts). */
export const COMPANION_VARS_EN: Record<CompanionVarName, string> = {
  cuedeck_online: 'CueDeck is running and sending data: 1 / 0',
  cuedeck_seen:
    'When CueDeck last sent data (unix seconds). More than 10 s behind $(internal:time_unix) — CueDeck crashed or the network dropped',
  cuedeck_timer: 'Timer as on the prompter: 04:59, −00:12 (or the time of day in clock mode)',
  cuedeck_timer_color: 'Timer colour: green / yellow / red / neutral',
  cuedeck_timer_over: 'Time is up (the countdown went negative): 1 / 0',
  cuedeck_timer_running: 'Timer running: 1 / 0',
  cuedeck_slide: 'Slide on air: 3/12 (empty when there is nothing to flip)',
  cuedeck_slides_left: 'Slides left after the current one: 9',
  cuedeck_program: 'What is on air (playlist entry or file name)',
  cuedeck_preview: 'What is in preview — goes to the audience on TAKE',
  cuedeck_next: 'Which entry “next speaker” will put into preview',
  cuedeck_video: 'Time left of the clip on air: 00:13 (empty when there is no clip)',
  cuedeck_video_playing: 'Clip on air is playing: 1 / 0',
  cuedeck_muted: 'Program sound is off: 1 / 0',
  cuedeck_blackout: 'Blackout / key visual on: 1 / 0',
  cuedeck_message: 'Speaker message on the prompter (empty — none)',
  cuedeck_stream_running: 'Streaming is on (the STREAM button is pressed): 1 / 0',
  cuedeck_stream_warn: 'Something is wrong with the stream — a destination is reconnecting, no picture, or the network can’t keep up: 1 / 0',
  cuedeck_stream_live: 'How many destinations are live right now: 2',
  cuedeck_stream_total: 'How many destinations are enabled in total: 3',
  cuedeck_timer_preset_1: 'Timer preset 1, minutes: 5 (empty if there is no such preset)',
  cuedeck_timer_preset_2: 'Timer preset 2, minutes: 10 (empty if there is no such preset)',
  cuedeck_timer_preset_3: 'Timer preset 3, minutes: 15 (empty if there is no such preset)',
  cuedeck_timer_preset_4: 'Timer preset 4, minutes: 20 (empty if there is no such preset)',
  cuedeck_program_index: 'Playlist entry number on air, as on the card: 3 (empty if what is on air is not from the playlist)',
  cuedeck_preview_index: 'Playlist entry number in preview, as on the card: 4 (empty if none)',
  cuedeck_message_preset_1: 'Text of speaker message preset 1 (empty if there is no such preset)',
  cuedeck_message_preset_2: 'Text of speaker message preset 2 (empty if there is no such preset)',
  cuedeck_message_preset_3: 'Text of speaker message preset 3 (empty if there is no such preset)',
  cuedeck_message_preset_4: 'Text of speaker message preset 4 (empty if there is no such preset)',
  cuedeck_message_preset_5: 'Text of speaker message preset 5 (empty if there is no such preset)',
  cuedeck_message_preset_6: 'Text of speaker message preset 6 (empty if there is no such preset)',
  cuedeck_omt_on: 'OMT output “Program” is on: 1 / 0',
  cuedeck_omt_program: 'vMix has the Program output on air (red OMT lamp): 1 / 0',
  cuedeck_omt_preview: 'vMix has the Program output in preview (green OMT lamp): 1 / 0',
  cuedeck_omt_receivers: 'How many receivers are pulling the Program output over OMT: 2',
}
export type CompanionVars = Record<CompanionVarName, string>

export type CompanionStateView = RemoteStateView &
  Pick<AppState, 'timerMode' | 'totalSlides' | 'speakerMessage' | 'omt'>

const flag = (v: boolean): string => (v ? '1' : '0')

/** Имя без расширения — на кнопке 72×72 каждая буква на счету. */
function shortName(name: string | null | undefined): string {
  if (!name) return ''
  return name.replace(/\.[a-z0-9]{2,5}$/i, '')
}

function baseName(p: string | null): string {
  if (!p) return ''
  return p.split(/[\\/]/).pop() ?? p
}

function entryName(s: CompanionStateView, id: string | null, path: string | null): string {
  const e = id ? s.playlist.find((x) => x.id === id) : undefined
  return shortName(e ? e.displayName || e.fileName : baseName(path))
}

/** Снимок переменных. `videoPosSec` — позиция эфирного ролика (store.videoPositionSec()). */
export function companionVars(s: CompanionStateView, now: number, videoPosSec: number): CompanionVars {
  const view = timerView(s.timer, s.timerMode, now)
  const slides = s.totalSlides > 0 && s.fileKind !== 'video' && s.fileKind !== 'live'
  const hasVideo = programHasVideo(s)
  const dur = s.video.durationSec
  const next = neighbour(s, 1)
  // Лампа OMT — только выход «Зал»; tally горит, пока выход включён.
  const omt = s.omt.outputs.program
  const omtOn = omt.state === 'on'
  // Минуты пресета строкой; нет такого пресета — пусто (на кнопке будет «—»).
  // Номер записи с 1, как на карточке (и в playlist/select/N); нет — пусто.
  const indexOf = (id: string | null): string => {
    const i = id ? s.playlist.findIndex((e) => e.id === id) : -1
    return i >= 0 ? String(i + 1) : ''
  }
  const msgPreset = (i: number): string => (s.speakerMsgPresets[i] ?? '').trim()
  const preset = (i: number): string => {
    const m = s.timerPresets[i]
    return typeof m === 'number' ? String(m) : ''
  }
  return {
    cuedeck_online: '1',
    cuedeck_seen: String(Math.floor(now / 1000)),
    cuedeck_timer: view.text,
    cuedeck_timer_color: view.color,
    cuedeck_timer_over: flag(view.overtime),
    cuedeck_timer_running: flag(s.timer.running),
    cuedeck_slide: slides ? `${s.currentSlide}/${s.totalSlides}` : '',
    cuedeck_slides_left: slides ? String(Math.max(0, s.totalSlides - s.currentSlide)) : '',
    cuedeck_program: s.pdfPath ? entryName(s, s.currentPlaylistId, s.pdfPath) : '',
    cuedeck_preview: s.preview.path ? entryName(s, s.preview.playlistId, s.preview.path) : '',
    cuedeck_next: typeof next === 'string' ? '' : entryName(s, next.id, null),
    cuedeck_video: hasVideo && dur > 0 ? formatMs(Math.max(0, dur - videoPosSec) * 1000) : '',
    cuedeck_video_playing: flag(hasVideo && s.video.playing),
    cuedeck_muted: flag(s.video.muted),
    cuedeck_blackout: flag(s.blackout),
    cuedeck_message: s.speakerMessage ?? '',
    cuedeck_stream_running: flag(s.stream.running),
    cuedeck_stream_warn: flag(s.stream.running && s.stream.warn),
    cuedeck_stream_live: String(s.stream.destinations.filter((d) => d.state === 'live').length),
    cuedeck_stream_total: String(s.stream.destinations.length),
    cuedeck_timer_preset_1: preset(0),
    cuedeck_timer_preset_2: preset(1),
    cuedeck_timer_preset_3: preset(2),
    cuedeck_timer_preset_4: preset(3),
    cuedeck_program_index: indexOf(s.currentPlaylistId),
    cuedeck_preview_index: indexOf(s.preview.playlistId),
    cuedeck_message_preset_1: msgPreset(0),
    cuedeck_message_preset_2: msgPreset(1),
    cuedeck_message_preset_3: msgPreset(2),
    cuedeck_message_preset_4: msgPreset(3),
    cuedeck_message_preset_5: msgPreset(4),
    cuedeck_message_preset_6: msgPreset(5),
    cuedeck_omt_on: flag(omtOn),
    cuedeck_omt_program: flag(omtOn && omt.program),
    cuedeck_omt_preview: flag(omtOn && omt.preview),
    cuedeck_omt_receivers: String(omt.receivers),
  }
}

/** Что отправить, когда CueDeck закрывается: кнопки не должны врать старым временем. */
export function companionOfflineVars(): Partial<CompanionVars> {
  return {
    cuedeck_online: '0',
    cuedeck_timer: '',
    cuedeck_timer_over: '0',
    cuedeck_timer_running: '0',
    cuedeck_video: '',
    cuedeck_video_playing: '0',
    cuedeck_stream_running: '0',
    cuedeck_stream_warn: '0',
    cuedeck_omt_on: '0',
    cuedeck_omt_program: '0',
    cuedeck_omt_preview: '0',
    cuedeck_omt_receivers: '0',
  }
}

/** Что поменялось с прошлой отправки (отправляем только разницу). */
export function diffVars(next: Partial<CompanionVars>, last: Map<string, string>): [string, string][] {
  return Object.entries(next).filter(([k, v]) => v !== undefined && last.get(k) !== v) as [string, string][]
}
