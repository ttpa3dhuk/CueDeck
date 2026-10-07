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
// 'full' — обратный случай: весь суфлёрский экран отдан таймеру (чёрный фон,
// цифры по центру, больше ничего). Этот выход уходит по HDMI/NDI в микшер
// (Resolume/vMix), там его кадрируют и накладывают на свою картинку — не нужно
// поднимать ради таймера отдельную машину.
// 'full-noflash' — то же самое, но без белой вспышки на нуле: на чистом
// сигнале в микшер вспышка заливает весь кадр, и не всякому режиссёру это надо.
// Одна кнопка ⛶ перещёлкивает эти два состояния (синяя → зелёная → синяя).
export type TimerPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'hidden'
  | 'full'
  | 'full-noflash'
  // 'free' — там, куда оператор перетащил таймер мышкой («Настройки → Суфлёр»);
  // координаты — AppState.timerFree.
  | 'free'

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
  /**
   * Центр таймера в режиме 'free' — доли экрана суфлёра (0..1), а не пиксели:
   * переживает смену разрешения и переезд на другой дисплей.
   */
  timerFree: { x: number; y: number }
  /** Свой цвет цифр таймера на суфлёре (#rrggbb); null — стандартный зелёный. */
  timerColor: string | null
  /** Жёлтый/красный в конце отсчёта поверх своего цвета (по умолчанию да). */
  timerWarnColors: boolean
  /**
   * Колонки суфлёра: ширина «Дальше/Заметки» в % окна (18–60) и доля «Дальше»
   * по высоте колонки (15–85; null — поровну). Раньше жили в localStorage окна
   * суфлёра — их нельзя было менять от оператора.
   */
  speakerLayout: { sidebarPct: number; nextPct: number | null }
  /** Сообщение спикеру: центр в долях экрана (null — сверху по центру) и масштаб. */
  speakerMsgLayout: { pos: { x: number; y: number } | null; scale: number }
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
  /**
   * Пути материалов, которых нет на диске, — включая элементы списков.
   * По ним редактор списка помечает конкретную пропавшую фотографию: id
   * записи для пачки из сорока файлов ничего не говорит оператору.
   */
  missingPaths: string[]
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
  /** Внешнее управление (Stream Deck / Companion / OSC): настройки + живой статус. */
  remote: RemoteStatus
  /** Встроенная трансляция: настройки + живой статус. */
  stream: StreamStatus
  /** Выходы OMT (Open Media Transport) в сеть: настройки + живой статус. */
  omt: OmtStatus
}

/**
 * Выходы OMT (main/omt/) — источники в локальной сети для vMix 29+, OBS
 * (плагин OMT) и других программ. Пока один: таймер на прозрачном фоне —
 * кладётся поверх картинки без ключа.
 */
export interface OmtSettings {
  /** Отдавать в сеть таймер с прозрачным фоном. */
  timer: boolean
  /** Имя источника; в списке у получателя — «КОМПЬЮТЕР (имя)». */
  timerName: string
  /** Показывать на таймере сообщение спикеру. */
  timerMessage: boolean
}

export type OmtOutputState = 'off' | 'on' | 'error'

export interface OmtStatus extends OmtSettings {
  /** Библиотека libomt загрузилась (на этой системе OMT вообще есть). */
  available: boolean
  /** Почему недоступно / почему выход не поднялся. */
  error: string | null
  timerState: OmtOutputState
  /** Полное имя в сети: «КОМПЬЮТЕР (CueDeck Timer)». */
  timerAddress: string | null
  /** Сколько программ смотрят источник. */
  timerReceivers: number
  /** Tally от vMix: источник в эфире / в превью у получателя. */
  timerProgram: boolean
  timerPreview: boolean
}

export const DEFAULT_OMT_SETTINGS: OmtSettings = {
  timer: false,
  timerName: 'CueDeck Timer',
  timerMessage: true,
}

/**
 * Внешнее управление (main/remote/). Слушатели живут в main, поэтому
 * команды доходят независимо от того, какое окно в фокусе и в фокусе ли
 * CueDeck вообще. По умолчанию выключено; `lan: false` — слушаем только
 * 127.0.0.1 (Stream Deck воткнут в этот же компьютер), `true` — все сетевые
 * интерфейсы (Companion на другой машине).
 */
export interface RemoteSettings {
  enabled: boolean
  httpPort: number
  oscPort: number
  lan: boolean
  /** Отправлять состояние (таймер, слайды, ролик) в Bitfocus Companion — кнопки его показывают. */
  companionPush: boolean
  /** Где Companion: `хост:порт` его веб-интерфейса (по умолчанию тот же компьютер). */
  companionHost: string
}

export type RemoteListenerState = 'off' | 'on' | 'error'

export interface RemoteStatus extends RemoteSettings {
  http: RemoteListenerState
  osc: RemoteListenerState
  httpError: string | null
  oscError: string | null
  /** Адреса, по которым нас видно: 127.0.0.1, а при lan — IPv4 сетевых карт. */
  hosts: string[]
  companion: RemoteListenerState
  companionError: string | null
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  enabled: false,
  httpPort: 9420,
  oscPort: 9421,
  lan: false,
  companionPush: true,
  companionHost: '127.0.0.1:8000',
}

/**
 * Встроенная трансляция RTMP/RTMPS (main/stream/). Кодирует окно
 * зала (аппаратный H.264 + AAC средствами Chromium, без ffmpeg) и раздаёт
 * одни и те же пакеты на несколько площадок сразу.
 */
export interface StreamDestination {
  id: string
  /** Подпись для оператора: «VK», «YouTube»… */
  name: string
  /** Адрес сервера: rtmp://… или rtmps://… (без ключа). */
  url: string
  /** Ключ потока. Секрет: в отчёт о проблеме не попадает. */
  key: string
  enabled: boolean
}

export interface StreamSettings {
  destinations: StreamDestination[]
  /** Высота кадра, ширина — по 16:9: 480/720/1080/1440/2160. */
  height: number
  /** 25/30/50/60. */
  fps: number
  videoKbps: number
  audioKbps: number
  /** Интервал ключевых кадров, с: 2 — стандарт, 1 — просит Rutube. */
  keyframeSec: number
  /** Звук эфира (ролики, живой вход — то, что звучит в зале). */
  programOn: boolean
  programGainDb: number
  /** Аудиовход с пульта — по метке устройства (id меняется при перевтыкании). */
  inputLabel: string | null
  inputOn: boolean
  inputGainDb: number
}

export const STREAM_HEIGHTS = [480, 720, 1080, 1440, 2160] as const
export const STREAM_FPS = [25, 30, 50, 60] as const
export const STREAM_VIDEO_KBPS = [1500, 2500, 3000, 4500, 6000, 8000, 10000, 12000, 16000, 20000, 30000, 40000] as const
export const STREAM_AUDIO_KBPS = [96, 128, 160, 192, 256, 320] as const
export const STREAM_KEYFRAME_SEC = [1, 2, 4] as const
export const STREAM_MAX_DESTINATIONS = 5

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  destinations: [],
  height: 1080,
  fps: 30,
  videoKbps: 6000,
  audioKbps: 160,
  keyframeSec: 2,
  programOn: true,
  programGainDb: 0,
  inputLabel: null,
  inputOn: true,
  inputGainDb: 0,
}

/** Параметры кодеков от окна-кодировщика: из них main строит заголовки FLV. */
export interface StreamEncoderConfig {
  width: number
  height: number
  fps: number
  /** AVCDecoderConfigurationRecord (decoderConfig.description). */
  avcC: Uint8Array
  sampleRate: number
  channels: number
  /** AudioSpecificConfig AAC. */
  asc: Uint8Array
  /** Date.now() в момент, от которого кодировщик считает метки времени. */
  t0: number
}

export interface StreamEncoderStatus {
  state: 'starting' | 'ok' | 'error'
  error?: string
  fps: number
  /** Кадров за секунду пропущено: кодер не успевал. */
  skipped: number
  /** Есть ли картинка с окна зала (false — шлём последний кадр/чёрный). */
  video: boolean
}

export type StreamDestState = 'off' | 'connecting' | 'live' | 'reconnecting' | 'error'

export interface StreamDestStatus {
  id: string
  state: StreamDestState
  error: string | null
  /** Фактический поток на площадку, кбит/с. */
  kbps: number
  /** Сколько кадров выброшено из-за медленной сети (с начала трансляции). */
  dropped: number
  /** Кадров видео отправлено в это соединение. */
  framesSent: number
  /** Очередь отправки в сокете, мс потока: растёт — канал не успевает. */
  backlogMs: number
  /** Сколько байт сервер подтвердил (RTMP Acknowledgement), МБ; null — сервер не шлёт. */
  ackedMB: number | null
  reconnects: number
  /** С какого момента в эфире (текущее соединение). */
  liveSince: number | null
}

/** Чья сторона: компьютер (кодирование, захват), сеть (канал), площадка (сервер). */
export type StreamSide = 'local' | 'network' | 'remote'

export interface StreamLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  side?: StreamSide
  text: string
}

export interface StreamReason {
  side: StreamSide
  text: string
}

export interface StreamStatus {
  settings: StreamSettings
  /** Оператор нажал «Старт» и ещё не нажал «Стоп». */
  running: boolean
  startedAt: number | null
  encoder: 'off' | 'starting' | 'ok' | 'error'
  encoderError: string | null
  /** Фактическая частота кодирования. */
  fps: number
  destinations: StreamDestStatus[]
  /** Кнопке Stream мигать жёлтым: ошибка, переподключение, потери кадров за последние секунды. */
  warn: boolean
  /** Почему мигает — с пометкой, чья сторона. */
  reasons: StreamReason[]
  /** Кадров/с пропущено кодировщиком (компьютер не успевает). */
  encoderSkipped: number
  /** Захвачено ли окно зала. */
  capture: boolean
  /** Журнал событий трансляции, новые сверху (до 200). */
  log: StreamLogEntry[]
}

/** Slots 4–6 are empty by default — free rows the user fills in via ПКМ. */
export const DEFAULT_SPEAKER_MSG_PRESETS = [
  'Заканчивайте', // i18n-ok: ключ словаря, t() при показе
  'Ближе к микрофону', // i18n-ok: ключ словаря, t() при показе
  'Финальный слайд', // i18n-ok: ключ словаря, t() при показе
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

// ── Диагностика (diag.ts): журнал, маркеры, отчёт о проблеме ────────────────

/** Момент, отмеченный оператором по хоткею/меню: «здесь было что-то не то». */
export interface DiagMarker {
  n: number
  /** Локальное время «HH:MM:SS» — так же, как в журнале. */
  at: string
}

export interface DiagInfo {
  /** Прошлая сессия завершилась не через штатный выход (краш, kill, питание). */
  abnormalPrevious: boolean
  markers: DiagMarker[]
  logPath: string
}

export type ReportResult = { ok: true; path: string } | { ok: false; error: string }

// ── Профили площадки ─────────────────────────────────────────────────────────

/**
 * Звуковой выход в профиле. id устройства у Chromium свой на каждом компьютере
 * (и меняется после переустановки драйвера), поэтому главное — имя: по нему
 * выход ищется при применении. id — подсказка для той же машины.
 * null — «системный по умолчанию» у эфира и «выключена» у предпрослушки.
 */
export interface ProfileAudioOutput {
  id: string
  label: string
}

/**
 * Настройки площадки: всё, что оператор выставляет под конкретный зал и
 * конкретные экраны. НЕ входят: плейлист и заставка (это проект), тема, язык,
 * кегль заметок и горячие клавиши (это вкусы оператора, а не площадка), путь к
 * LibreOffice (это компьютер), длительность таймера (она у каждого спикера своя —
 * профиль, применённый посреди выступления, не должен её трогать).
 */
export interface VenueProfileSettings {
  layout: Layout
  audienceWindowed: boolean
  outputMonitorsEnabled: boolean
  audioMain: ProfileAudioOutput | null
  audioPreview: ProfileAudioOutput | null
  timerMode: TimerMode
  timerPosition: TimerPosition
  timerScale: number
  timerFree: { x: number; y: number }
  timerColor: string | null
  timerWarnColors: boolean
  timerTickEnabled: boolean
  timerGongEnabled: boolean
  timerLoop: boolean
  timerPresets: number[]
  speakerLayout: { sidebarPct: number; nextPct: number | null }
  speakerMsgLayout: { pos: { x: number; y: number } | null; scale: number }
  speakerMsgPresets: string[]
  videoTakeMode: VideoTakeMode
  slideTakeMode: SlideTakeMode
  autoAdvance: boolean
  clickerGlobal: boolean
  clickerGlobalArrows: boolean
  remote: RemoteSettings
  midiInputs: string[]
}

/**
 * Группы настроек профиля — оператор выбирает, какие сохранять: «обновить в
 * своём профиле только пресеты, не трогая звук и экраны» (Азат 2026-09-28).
 * Применяются только группы, которые в профиле есть.
 */
export type ProfileGroup = 'screens' | 'audio' | 'prompter' | 'timer' | 'presets' | 'take' | 'clicker' | 'remote' | 'midi'

export interface VenueProfile {
  id: string
  name: string
  /** Какие группы профиль хранит; остальные поля settings при применении не трогаются. */
  groups: ProfileGroup[]
  /** Когда сохранён (ISO). */
  savedAt: string
  settings: VenueProfileSettings
}

/** Что осталось сделать окну оператора после применения профиля (звук — там). */
export type ProfileApplyResult =
  | {
      ok: true
      name: string
      /** Что применено на самом деле: отмеченное ∩ то, что есть в профиле. */
      groups: ProfileGroup[]
      /** Применять ли звук; нет — окно оператора звук не трогает. */
      audio: boolean
      audioMain: ProfileAudioOutput | null
      audioPreview: ProfileAudioOutput | null
      /** Раскладка отличалась — окна зала/суфлёра пересобраны. */
      layoutChanged: boolean
    }
  | { ok: false; error: string }
