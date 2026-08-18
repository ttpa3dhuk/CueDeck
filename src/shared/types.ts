/**
 * Single source of truth for the state types shared by the main process and
 * the preload/renderer side. Type-only module — safe to import from any
 * process (everything is erased at compile time).
 *
 * main:    src/main/state.ts, layout.ts, ipc.ts re-export from here.
 * preload: src/preload/api.ts re-exports from here (renderers import from it).
 */

export type Layout = 'solo' | 'presenter-audience' | 'operator-speaker-audience'

export type Role = 'operator' | 'speaker' | 'audience'

export type DisplayMap = Partial<Record<Role, number>>

export interface TimerState {
  durationMs: number
  startedAt: number | null
  elapsedMs: number
  running: boolean
  /**
   * Completed loop rounds (timerLoop mode). Main increments it when the
   * countdown wraps and restarts; renderers watch the change to fire the
   * gong/flash even if they never observed remaining <= 0 between ticks.
   */
  cycles: number
}

export type TimerMode = 'countdown' | 'stopwatch' | 'clock'

// 'hidden' убирает таймер с суфлёра совсем — когда суфлёрский сигнал идёт
// через vMix и режиссёр накладывает свой таймер поверх.
export type TimerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'hidden'

// 'live' — не файл, а внешний источник (USB-капчер/камера); путь у него
// псевдо-URI `live://…`, см. src/shared/live.ts.
export type FileKind = 'pdf' | 'image' | 'pptx' | 'video' | 'live' | 'list'

/**
 * Элемент списка (kind='list'): фотография или ролик. Список — это пачка
 * материалов, которую крутят по кругу на сборе гостей или в перерыве, а не
 * отдельные записи плейлиста: иначе десять фотографий забивают весь список
 * спикеров.
 */
export type ListMode = 'loop' | 'shuffle' | 'once'

export const LIST_FADE_MAX_MS = 2000

export interface ListItem {
  path: string
  fileName: string
  kind: 'image' | 'video'
}

/** Тема интерфейса оператора. Суфлёр и зал всегда тёмные — это выходные экраны. */
export type UiTheme = 'dark' | 'light'

/** Окна, чью картинку мониторим у оператора (мультивьюер под эфиром). */
export type MonitorRole = 'speaker' | 'audience'

/**
 * What happens to a video clip when it is taken from preview to program:
 * always autoplay, either from 0 or resuming at the preview scrub position.
 */
/**
 * Что делать с роликом при выдаче в эфир. `hold-first` — встать на первом
 * кадре и ждать: первый кадр часто сам по себе заставка, а запускают ролик
 * кликером, как видео на слайде презентации.
 */
export type VideoTakeMode = 'play-start' | 'play-resume' | 'hold-first'

/**
 * С какого слайда презентация уходит в эфир по TAKE: с первого или с того,
 * на котором оператор остановился в превью. Дефолт «с первого» — оператор
 * мог полистать превью и забыть вернуть на начало (Б-3).
 */
export type SlideTakeMode = 'from-start' | 'from-current'

/**
 * Logical playback clock shared across all windows (like TimerState).
 * Current position is derived, never stored as a moving value:
 *   playing && anchorAt → anchorSec + (now - anchorAt) / 1000
 *   otherwise           → anchorSec
 * This keeps operator preview and audience output in sync without
 * streaming currentTime over IPC on every frame.
 */
export interface VideoState {
  playing: boolean
  anchorSec: number
  anchorAt: number | null
  durationSec: number
  muted: boolean
}

/** Прямоугольник видео-плейсхолдера на слайде, в долях слайда (0..1). */
export interface SlideMediaRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Видео, вшитое в слайд PPTX (2.10). При импорте main извлекает ролик в
 * pptx-cache и описывает его здесь; рендереры накладывают <video> поверх
 * отрендеренной страницы по rect. Плеером управляет общий клок VideoState —
 * тот же, что и для «файл целиком — видео».
 */
export interface SlideMedia {
  /** Номер страницы (1-based, совпадает с currentSlide). */
  slide: number
  rect: SlideMediaRect
  /** Имя файла в pptx-cache/<sha1>.media/ (раздаётся через cuedeck-media://). */
  file: string
}

/**
 * Как вписывать картинку живого входа в экран 16:9 (2.13). Гости приносят
 * ноуты 4:3 и 16:10 — по умолчанию поля по краям, но иногда просят заполнить.
 * - `contain` — вписать целиком, поля по краям (безопасный дефолт)
 * - `cover`   — увеличить до заполнения, края обрезаются, пропорции целы
 * - `fill`    — растянуть до 16:9, пропорции искажаются
 */
export type LiveFit = 'contain' | 'cover' | 'fill'

export const DEFAULT_LIVE_FIT: LiveFit = 'contain'

export interface PlaylistEntry {
  id: string
  kind: FileKind
  filePath: string
  fileName: string
  /** User-given label shown in the playlist instead of fileName. '' → use fileName. */
  displayName: string
  speakerName: string
  durationMs: number
  /** Только для kind='live'. Отсутствует у старых сохранённых плейлистов. */
  liveFit?: LiveFit
  /** Содержимое списка (kind='list'): фото и ролики по порядку. */
  items?: ListItem[]
  /** Сколько секунд держать одну фотографию (kind='list'). По умолчанию 8. */
  photoSec?: number
  /**
   * Режим проигрывания списка: по кругу, вперемешку (тоже по кругу, но порядок
   * тасуется на каждом проходе) или один проход с остановкой на последнем.
   */
  listMode?: ListMode
  /**
   * Плавный переход между фотографиями, мс. 0 — резкая смена. Ограничен сверху
   * 2000 мс и половиной паузы между кадрами: затемнение длиннее самого показа
   * превращает слайдшоу в мигание.
   */
  fadeMs?: number
  /**
   * Зациклить ролик этой записи: видео-заставка крутится, пока спикер на
   * сцене, а обычный ролик доигрывает и встаёт. Настройка живёт у записи, а не
   * глобально, — иначе забытая галка зациклила бы следующий ролик.
   */
  loop?: boolean
}

/**
 * A single loaded deck (file + position). The top-level AppState fields
 * (pdfPath/fileKind/currentSlide/video/notes/currentPlaylistId) ARE the PROGRAM
 * deck — what the audience sees, driven by the clicker. `AppState.preview` is a
 * second, independent deck the operator stages off-air; `take` copies it into the
 * program fields. Keeping program top-level avoids touching audience/speaker code.
 */
export interface DeckState {
  path: string | null
  sha1: string | null
  kind: FileKind | null
  totalSlides: number
  currentSlide: number
  video: VideoState
  notes: Record<number, string>
  playlistId: string | null
  /** Видео, вшитые в слайды (только PPTX; пусто для остальных форматов). */
  slideMedia: SlideMedia[]
}

export interface AppState {
  pdfPath: string | null
  pdfSha1: string | null
  fileKind: FileKind | null
  totalSlides: number
  currentSlide: number
  /** Off-air staging deck (operator only). `take` promotes it to program. */
  preview: DeckState
  blackout: boolean
  video: VideoState
  /** Видео, вшитые в слайды программного PPTX (см. SlideMedia). */
  slideMedia: SlideMedia[]
  timer: TimerState
  timerMode: TimerMode
  timerPosition: TimerPosition
  timerScale: number
  videoTakeMode: VideoTakeMode
  slideTakeMode: SlideTakeMode
  notesFontSize: number
  notes: Record<number, string>
  layout: Layout
  displayMap: DisplayMap
  playlist: PlaylistEntry[]
  /**
   * id записей плейлиста, чьи файлы сейчас не находятся на диске (материал
   * переехал, флешка не та, проект приехал с другой машины). Пересчитывается
   * при открытии проекта, восстановлении сессии, добавлении файлов и по кнопке
   * «Проверить файлы». Оператор должен узнать о пропаже при подготовке, а не в
   * момент выдачи в зал.
   */
  missingIds: string[]
  currentPlaylistId: string | null
  playlistCompact: boolean
  autoAdvance: boolean
  keyVisualPath: string | null
  projectPath: string | null
  audienceWindowed: boolean
  /** Output device id for video sound (setSinkId). null = system default. */
  audioOutputId: string | null
  /**
   * Предпрослушка (SOLO/PFL): отдельный выход под наушники оператора, чтобы
   * послушать ролик или живой вход в превью, пока эфир идёт своим трактом.
   * null = предпрослушка ВЫКЛЮЧЕНА (превью немое). Именно выключена, а не
   * «системный по умолчанию»: на площадке дефолтный выход запросто окажется
   * трактом зала, и превью зазвучало бы в зал.
   */
  previewAudioOutputId: string | null
  /** Flash message on the speaker monitor; stays (blinking) until cleared. null = none. */
  speakerMessage: string | null
  /** User-editable texts of the six speaker-message preset buttons (ПКМ по кнопке); '' = пустой слот. */
  speakerMsgPresets: string[]
  /** Sound cue on the operator: ticks in the last 10s of a countdown. */
  timerTickEnabled: boolean
  /** Sound cue on the operator: gong when the countdown hits zero / wraps a loop round. */
  timerGongEnabled: boolean
  /** Loop mode: countdown restarts automatically on zero (15/30-second rounds etc.). */
  timerLoop: boolean
  /**
   * Зациклен ли ролик, который сейчас в эфире. Это **производная** от записи
   * плейлиста (`PlaylistEntry.loop`) — состояние держит её для рендереров,
   * источник истины и персист живут в записи. Файл, открытый мимо плейлиста
   * (Cmd+O), хранит флаг только на время показа.
   */
  videoLoop: boolean
  /**
   * Какой элемент списка сейчас в эфире (kind='list'), −1 = список не играет.
   * Проигрывателем списка рулит main: он же держит таймер фотографий и ловит
   * конец ролика, а рендереры просто показывают текущий файл как обычно.
   */
  listIndex: number
  /**
   * Позиция в очереди обхода (в режиме «вперемешку» она не совпадает с
   * listIndex). Нужна и оператору: «Список 3 из 12» считается по ней.
   */
  listPos: number
  /**
   * Какой элемент списка показан в превью (−1 — превью не держит список).
   * Оператор листает пачку теми же ◀ ▶, что и слайды, — посмотреть с клиентом
   * до выдачи в зал.
   */
  previewListIndex: number
  /** User-editable minutes of the four timer preset buttons (ПКМ по кнопке). */
  timerPresets: number[]
  /**
   * Global clicker: PgUp/PgDn switch program slides system-wide (globalShortcut),
   * so the speaker keeps clicking while the operator works in a browser/Finder.
   * While on, PgUp/PgDn are unavailable to other apps. Blank (.) and Take stay local.
   */
  clickerGlobal: boolean
  /**
   * Also grab ←/→ arrows globally — for clickers that send arrows instead of
   * PgUp/PgDn (Logitech Spotlight without Logi Options). Steals arrows from
   * every other app while active, so it's a separate opt-in.
   */
  clickerGlobalArrows: boolean
  /**
   * Мониторы выходов под эфиром: живые снимки окон суфлёра и зала (~2 fps),
   * чтобы оператор видел, что реально ушло на внешние экраны — таймер,
   * заметки, неснятое сообщение спикеру. Выключается в «Настройке экранов».
   */
  outputMonitorsEnabled: boolean
  /** Тема окна оператора; персистится. */
  uiTheme: UiTheme
}

/** Slots 4–6 are empty by default — free rows the user fills in via ПКМ. */
export const DEFAULT_SPEAKER_MSG_PRESETS = [
  'Заканчивайте',
  'Ближе к микрофону',
  'Финальный слайд',
  '',
  '',
  '',
]

export const DEFAULT_TIMER_PRESETS = [5, 10, 15, 20]

/**
 * Donation page URL. Empty string hides every donate entry point
 * (Help menu item + link in the hotkeys modal).
 */
export const DONATE_URL = 'https://pay.cloudtips.ru/p/b79fa042'

export interface DisplayInfo {
  id: number
  label: string
  internal: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface OpenPdfResult {
  ok: boolean
  path?: string
  totalSlides?: number
  sha1?: string
  sha1Mismatch?: boolean
  cancelled?: boolean
  error?: string
  kind?: FileKind
}
