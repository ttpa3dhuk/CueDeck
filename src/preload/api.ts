// Canonical state types live in src/shared/types.ts (shared with the main
// process). Renderers keep importing them from this module.
import type {
  AppState,
  DiagInfo,
  DisplayInfo,
  DisplayMap,
  Layout,
  ListItem,
  ListMode,
  LiveFit,
  MonitorRole,
  OpenPdfResult,
  PlaylistEntry,
  ProfileApplyResult,
  ProfileGroup,
  RemoteSettings,
  RemoteStatus,
  OmtSettings,
  OmtStatus,
  ReportResult,
  ReportMaterials,
  SlideTakeMode,
  StreamEncoderConfig,
  StreamEncoderStatus,
  StreamSettings,
  StreamStatus,
  SyphonSettings,
  SyphonStatus,
  TimerMode,
  TimerPosition,
  UiTheme,
  VenueProfile,
  VideoTakeMode,
  VideoDeck,
  VideoRange,
  VideoRangeEdge,
  VideoRangeUpdateResult,
  FrameStepResult,
  FrameStepIdentity,
  FrameTimecode,
} from '../shared/types.js'
import type { LiveSource } from '../shared/live.js'
import type { PlaylistInsertPosition } from '../shared/playlist-folders.js'

export { DONATE_URL, SUPPORT_URL } from '../shared/types.js'
export type { LiveSource } from '../shared/live.js'

export type {
  AppState,
  DeckState,
  DiagInfo,
  DiagMarker,
  DisplayInfo,
  DisplayMap,
  FileKind,
  Layout,
  ListItem,
  ListMode,
  LiveFit,
  MonitorRole,
  OpenPdfResult,
  PlaylistEntry,
  ProfileApplyResult,
  ProfileGroup,
  RemoteSettings,
  RemoteStatus,
  OmtSettings,
  OmtStatus,
  ReportResult,
  Role,
  SlideMedia,
  SlideMediaRect,
  SlideTakeMode,
  StreamDestination,
  StreamDestStatus,
  StreamSettings,
  StreamStatus,
  SyphonSettings,
  SyphonStatus,
  TimerMode,
  TimerPosition,
  TimerState,
  VenueProfile,
  UiTheme,
  VideoState,
  VideoTakeMode,
  VideoDeck,
  VideoRange,
  VideoRangeEdge,
  VideoRangeUpdateResult,
  FrameStepResult,
  FrameStepIdentity,
  FrameTimecode,
} from '../shared/types.js'

export type Unsubscribe = () => void

export interface PresenterApi {
  programOverlay: {
    set(config: import('../shared/program-overlay').ProgramOverlayConfig): Promise<void>
    chooseImage(): Promise<string | null>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
  }
  mobileClicker: {
    resetLink(): Promise<import('../shared/mobile-clicker').MobileClickerStatus>
    status(): Promise<import('../shared/mobile-clicker').MobileClickerStatus>
    qr(index: number): Promise<string | null>
    setEnabled(enabled: boolean): Promise<import('../shared/mobile-clicker').MobileClickerStatus>
  }
  gpuMirror: { ready(result: { error?: string; adapter?: string }): void }
  programMirror: {
    available(): Promise<boolean>
    forced(): Promise<boolean>
    register(source: string | null): void
  }
  state: {
    get(): Promise<AppState>
    onPatch(cb: (patch: Partial<AppState>) => void): Unsubscribe
    onFull(cb: (full: AppState) => void): Unsubscribe
  }
  pdf: {
    openDialog(): Promise<OpenPdfResult>
    openPath(path: string): Promise<OpenPdfResult>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
    reportTotal(total: number): Promise<void>
  }
  nav: {
    goto(slide: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
  }
  clicker: {
    next(): Promise<void>
    prev(): Promise<void>
    /** Global PgUp/PgDn clicker. Resolves to what actually got enabled (registration can fail). */
    setGlobal(value: boolean): Promise<boolean>
    /** Also grab ←/→ globally (Spotlight-style clickers). Resolves to the applied value. */
    setGlobalArrows(value: boolean): Promise<boolean>
  }
  /**
   * Off-air staging deck (operator only). Loading a file or selecting a playlist
   * entry lands here; `take()` promotes it to the program (audience) feed.
   */
  preview: {
    toggleSourceMuted(identity: FrameStepIdentity): Promise<void>
    openDialog(): Promise<OpenPdfResult>
    openPath(path: string): Promise<OpenPdfResult>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
    reportTotal(total: number): Promise<void>
    goto(slide: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    clear(): Promise<void>
    take(transition?: 'fade'): Promise<void>
    setFadeMs(ms: number): Promise<void>
    setVideoTakeMode(mode: VideoTakeMode): Promise<void>
    /** С какого слайда TAKE выдаёт презентацию: с первого или с текущего в превью (Б-3). */
    setSlideTakeMode(mode: SlideTakeMode): Promise<void>
    video: {
      toggle(): Promise<void>
      pause(): Promise<void>
      seek(sec: number): Promise<void>
      seekBy(deltaSec: number): Promise<void>
      setDuration(sec: number): Promise<void>
      ended(): Promise<void>
    }
  }
  note: {
    update(slide: number, text: string): Promise<void>
    setFontSize(px: number): Promise<void>
  }
  timer: {
    resetStyle(): Promise<void>
    start(): Promise<void>
    pause(): Promise<void>
    reset(): Promise<void>
    setDuration(ms: number): Promise<void>
    adjust(deltaMs: number): Promise<void>
    setMode(mode: TimerMode): Promise<void>
    setPosition(pos: TimerPosition): Promise<void>
    setScale(scale: number): Promise<void>
    /** Свободное положение таймера на суфлёре: центр в долях экрана (0..1). */
    setFree(x: number, y: number): Promise<void>
    /** Свой цвет цифр на суфлёре (#rrggbb) или null — стандартный. */
    setFont(font: string): Promise<void>
    setColor(color: string | null): Promise<void>
    /** Жёлтый/красный в конце отсчёта поверх своего цвета. */
    setWarnColors(on: boolean): Promise<void>
    /** Sound cue on the operator: ticks in the last 10s of a countdown. */
    setTickSound(enabled: boolean): Promise<void>
    /** Sound cue on the operator: gong at zero / on every loop wrap. */
    setGongSound(enabled: boolean): Promise<void>
    /** Loop mode: countdown restarts automatically on zero. */
    setLoop(enabled: boolean): Promise<void>
    /** Minutes of the four preset buttons (ПКМ по кнопке). */
    setPresets(presets: number[]): Promise<void>
    setAdjustments(values: number[]): Promise<void>
  }
  audienceTimer: {
    start(): Promise<void>
    pause(): Promise<void>
    reset(): Promise<void>
    setVisible(visible: boolean): Promise<void>
    configure(config: Partial<import('../shared/audience-timer').AudienceTimerConfig>): Promise<void>
  }
  blackout: {
    toggle(): Promise<void>
  }
  audienceOutput: {
    setEnabled(enabled: boolean): Promise<void>
  }
  speakerMessage: {
    /** Положение (центр в долях экрана; null — сверху по центру) и масштаб плашки. */
    setLayout(layout: { pos: { x: number; y: number } | null; scale: number }): Promise<void>
    /** Show a blinking message on the speaker monitor; null/'' clears it. */
    set(text: string | null): Promise<void>
    /** Replace the texts of the three preset buttons (user-editable, persisted). */
    setPresets(presets: string[]): Promise<void>
  }
  video: {
    play(): Promise<void>
    pause(): Promise<void>
    toggle(): Promise<void>
    seek(sec: number): Promise<void>
    seekBy(deltaSec: number): Promise<void>
    setDuration(sec: number): Promise<void>
    ended(): Promise<void>
    setMuted(muted: boolean): Promise<void>
    /** Зациклить эфирный ролик (видео-заставка крутится, пока спикер на сцене). */
    setLoop(enabled: boolean): Promise<void>
    toggleMuted(): Promise<void>
    /** One actual frame via ffprobe timestamps; honestly fails when unavailable. */
    stepFrame(deck: VideoDeck, direction: -1 | 1, identity?: FrameStepIdentity): Promise<FrameStepResult>
    /** MM:SS:FF labels from the same bounded decoded-frame cache; -- = unknown. */
    timecode(deck: VideoDeck): Promise<FrameTimecode | null>
    /** Edit In/Out on the deck's playlist entry; matching program/preview apply immediately. */
    setRange(deck: VideoDeck, edge: VideoRangeEdge): Promise<VideoRangeUpdateResult>
  }
  audio: {
    setOutput(deviceId: string | null): Promise<void>
    /** Предпрослушка в наушники (SOLO/PFL); null = выключить. */
    setPreviewOutput(deviceId: string | null): Promise<void>
  }
  testScreen: {
    setEnabled(enabled: boolean): Promise<void>
    info(role: 'audience' | 'speaker'): Promise<import('../shared/test-screen').TestScreenInfo>
  }
  displays: {
    list(): Promise<DisplayInfo[]>
  }
  layout: {
    set(layout: Layout, displayMap: DisplayMap, audienceWindowed?: boolean, audienceAlwaysOnTop?: boolean): Promise<void>
    getAskOnStartup(): Promise<boolean>
    setAskOnStartup(value: boolean): Promise<void>
  }
  monitor: {
    /** CSS-pixel dimensions of the actual audience surface, for overlay alignment. */
    audienceSize(): Promise<{ width: number; height: number }>
    /** Мониторы выходов под эфиром: вкл/выкл (персистится). */
    setEnabled(value: boolean): Promise<void>
    /** JPEG-кадры окон суфлёра/зала (до 5 fps); приходят только оператору. */
    onFrame(cb: (frame: { role: MonitorRole; dataUrl: string }) => void): Unsubscribe
  }
  ui: {
    /** Тема окна оператора (персистится). */
    setTheme(theme: UiTheme): Promise<void>
    /** Выбранный язык интерфейса (может ждать перезапуска). */
    getLang(): Promise<'ru' | 'en'>
    /** Запомнить язык — применится после перезапуска. */
    setLang(lang: 'ru' | 'en'): Promise<void>
    /** Перезапустить CueDeck (с вопросом о сохранении, как обычный выход). */
    relaunch(): Promise<void>
  }
  /** Раскладка экрана суфлёра (колонки «Дальше/Заметки»). */
  prompter: {
    setToolbarScale(scale: number): Promise<void>
    setLayout(layout: { sidebarPct: number; nextPct: number | null }): Promise<void>
  }
  /** MIDI-входы, которые слушает CueDeck (по имени устройства; персистится). */
  midi: {
    getEnabled(): Promise<string[]>
    setEnabled(names: string[]): Promise<void>
  }
  /** Профили площадки (main/profiles.ts). Звук применяет окно оператора — по именам выходов. */
  profiles: {
    list(): Promise<VenueProfile[]>
    /** Сохранить текущие настройки: новый (name) или поверх профиля id. labels — имена выбранных звуковых выходов. */
    save(
      name: string,
      labels: { main: string | null; preview: string | null },
      id?: string,
      groups?: ProfileGroup[],
    ): Promise<ProfileListResult>
    rename(id: string, name: string): Promise<ProfileListResult>
    remove(id: string): Promise<ProfileListResult>
    /** groups — что вгрузить; не передали — весь профиль. */
    apply(id: string, groups?: ProfileGroup[]): Promise<ProfileApplyResult>
    exportFile(id: string): Promise<{ ok: boolean; path?: string; error?: string }>
    importFile(): Promise<{ ok: boolean; added?: number; errors?: string[]; profiles?: VenueProfile[] }>
  }
  /** Внешнее управление: Stream Deck / Companion / OSC (main/remote/). */
  remote: {
    copyAccessKey(): Promise<{ ok: boolean; error?: string }>
    /** Сохранить настройки и перезапустить слушатели; статус приходит и в state.remote. */
    configure(settings: RemoteSettings): Promise<{ ok: true; status: RemoteStatus } | { ok: false; error: string }>
    /** Справочная страница со списком команд — в браузере по умолчанию. */
    openHelp(): Promise<{ ok: boolean; error?: string }>
    /** Сохранить готовую страницу Companion (.companionconfig) — диалог «Сохранить». */
    saveCompanionPage(): Promise<{ ok: boolean; path?: string; cancelled?: boolean }>
  }
  /** Выходы OMT в сеть (main/omt/): статус приходит и в state.omt. */
  omt: {
    configure(settings: Partial<OmtSettings>): Promise<{ ok: true; status: OmtStatus }>
    /** Окно звука OMT: кусок звука зала, 32 бит float по каналам подряд. */
    sendAudio(chunk: { sampleRate: number; channels: number; frames: number; data: Float32Array }): void
  }
  /** Syphon (macOS) / Spout (Windows): настройки + фактический статус. */
  syphon: {
    status(): Promise<SyphonStatus>
    configure(settings: Partial<SyphonSettings>): Promise<
      { ok: true; status: SyphonStatus } | { ok: false; error: string; status: SyphonStatus }
    >
  }
  syphonPrompter: PresenterApi['syphon']
  files: {
    /** Filesystem path of a dropped/picked File (webUtils.getPathForFile). */
    pathFor(file: File): string
  }
  playlist: {
    prepare(id: string): Promise<void>
    /** Reveal the original media; list items must name a path belonging to this entry. */
    revealSource(id: string, itemPath?: string): Promise<{ ok: boolean; error?: string }>
    add(): Promise<PlaylistEntry[]>
    /** Add external files at an optional playlist position; omitted position appends. */
    addPaths(paths: string[], position?: PlaylistInsertPosition): Promise<PlaylistEntry[]>
    /** Живой вход (2.13): устройство приходит метками, main склеит псевдо-путь. */
    addLive(src: LiveSource): Promise<PlaylistEntry[]>
    /** Переназначить устройства у живого входа без пересоздания записи. */
    updateLive(id: string, src: LiveSource): Promise<void>
    createFolder(name: string): Promise<string>
    renameFolder(id: string, name: string): Promise<void>
    removeFolder(id: string, removeContents?: boolean): Promise<void>
    setFolder(id: string, folderId: string | null): Promise<void>
    setFolders(ids: string[], folderId: string | null): Promise<void>
    setFolderCollapsed(id: string, collapsed: boolean): Promise<void>
    remove(id: string): Promise<void>
    /** Copy a playlist record after its source without duplicating media or changing decks. */
    duplicate(id: string): Promise<PlaylistEntry | null>
    reorder(ids: string[]): Promise<void>
    update(id: string, payload: { displayName?: string; speakerName?: string; durationMs?: number; liveFit?: LiveFit; loop?: boolean; slideFadeMs?: number; slideFadeMode?: 'file' | 'custom' | 'cut' }): Promise<void>
    /** Load entry into the off-air preview deck (safe; does not touch the audience feed). */
    activate(id: string): Promise<OpenPdfResult>
    /** Load entry straight to the program/audience feed (double-click / Take-now). */
    activateLive(id: string): Promise<OpenPdfResult>
    setCompact(value: boolean): Promise<void>
    setAutoAdvance(value: boolean): Promise<void>
    /** Перепроверить материалы на диске; помечает пропавшие в state.missingIds. */
    checkFiles(): Promise<{ missing: number; total: number }>
    /** Указать файл заново для записи (материал переехал). true = путь заменён. */
    relocate(id: string): Promise<boolean>
    /** Найти все пропавшие материалы в указанной папке (по именам файлов). */
    relinkFolder(): Promise<{ fixed: number; remaining: number; cancelled?: boolean }>
    /** Список: пачка фото/роликов одной записью (сбор гостей, перерыв). */
    addList(): Promise<PlaylistEntry[]>
    /** Правка содержимого списка: порядок, удаление, секунды на фото. */
    updateList(id: string, payload: { items?: ListItem[]; photoSec?: number; listMode?: ListMode; fadeMs?: number }): Promise<void>
    /** Заменить один материал списка (фото переехало). */
    relocateItem(id: string, index: number): Promise<boolean>
    /** Дозалить файлы в существующий список. */
    addToList(id: string): Promise<boolean>
  }
  keyvisual: {
    set(): Promise<{ path: string | null }>
    clear(): Promise<void>
    read(): Promise<{ bytes: Uint8Array; mime: string } | null>
  }
  project: {
    revealTransfer(): Promise<void>
    create(): Promise<void>
    save(saveAs?: boolean): Promise<{ ok: boolean; path?: string; error?: string }>
    /** `missing`/`total` — сколько материалов проекта не нашлось на диске. */
    open(): Promise<{ ok: boolean; path?: string; error?: string; missing?: number; total?: number }>
    /** Собрать проект и все материалы в одну папку (под флешку). */
    consolidate(): Promise<{
      ok: boolean
      copied?: number
      skipped?: number
      path?: string
      error?: string
      cancelled?: boolean
    }>
  }
  menu: {
    onQuickSetting(cb: (action: string, value: unknown) => void): Unsubscribe
    setAudioOutputs(outputs: { id: string; label: string }[]): Promise<void>
    onOpenPdf(cb: () => void): Unsubscribe
    onOpenDisplaySetup(cb: () => void): Unsubscribe
    /** Меню → «Настройки…» (внешнее управление, MIDI). */
    onOpenSettings(cb: () => void): Unsubscribe
    onTopologyChanged(cb: () => void): Unsubscribe
    onProjectNew(cb: () => void): Unsubscribe
    onProjectOpen(cb: () => void): Unsubscribe
    onProjectSave(cb: () => void): Unsubscribe
    onProjectSaveAs(cb: () => void): Unsubscribe
    onProjectConsolidate(cb: () => void): Unsubscribe
    onHelp(cb: () => void): Unsubscribe
    /** Help → «Сообщить о проблеме…» (только оператор). */
    onReport(cb: () => void): Unsubscribe
  }
  update: {
    onAvailable(cb: (info: { newerVersion: string; url: string }) => void): Unsubscribe
  }
  session: {
    configureStartup(settings: Partial<import('../shared/startup-settings').StartupSettings>): Promise<import('../shared/startup-settings').StartupSettings>
    startup(): Promise<OpenPdfResult & { hadSession: boolean; recovery: boolean }>
    hasLast(): Promise<boolean>
    restore(): Promise<OpenPdfResult & { hadSession: boolean }>
    restoreBackup(): Promise<OpenPdfResult & { cancelled?: boolean }>
  }
  fonts: {
    info(): Promise<{ supported: boolean; added: number }>
    /** Выбрать папку/файлы шрифтов и поставить для текущего пользователя (мак, Windows). */
    add(): Promise<{ ok: boolean; cancelled?: boolean; added?: number; skipped?: number; failed?: string[]; found?: number; error?: string }>
    /** Убрать ровно те шрифты, которые добавила программа. */
    remove(): Promise<{ ok: boolean; removed?: number; error?: string }>
  }
  pptx: {
    readAnimationFrames(file: string, sha: string): Promise<Uint8Array | null>
    backend(): Promise<'libreoffice' | 'powerpoint-static'>
    setBackend(backend: 'libreoffice' | 'powerpoint-static'): Promise<void>
    /** Сбросить кэш PDF этого PPTX и сконвертировать заново (после установки шрифтов). */
    rebuild(path: string): Promise<{ ok: boolean; remaining?: string[]; error?: string }>
    cacheStats(): Promise<{ bytes: number; files: number; protectedBytes: number }>
    openCacheFolder(): Promise<{ ok: boolean; error?: string }>
    clearCache(): Promise<{ ok: boolean; cancelled?: boolean; clearedBytes?: number; remainingBytes?: number; error?: string }>
  }
  soffice: {
    check(): Promise<boolean>
    /** Путь к используемому soffice или null. */
    current(): Promise<string | null>
    /** Перепроверить после установки: сбрасывает закэшированный путь. */
    recheck(): Promise<boolean>
    /** Пути, по которым искали — для подсказки «не нашли». */
    paths(): Promise<string[]>
    /** Указать LibreOffice вручную (установка вне стандартных папок). */
    pick(): Promise<{ ok: boolean; path?: string }>
  }
  /** Нужна рендереру, чтобы не показывать macOS-команду установки на Windows. */
  platform: string
  external: {
    open(url: string): Promise<void>
  }
  live: {
    listWindows(): Promise<{ sources: { id: string; name: string; thumbnail: string }[]; permission: string }>
    windowFps(requested?: number): Promise<number>
    resolveWindow(src: import('../shared/live').LiveSource): Promise<string>

    /**
     * Разовый системный запрос доступа к камере/микрофону (macOS). Без него
     * enumerateDevices отдаёт пустые метки, а getUserMedia падает.
     */
    requestAccess(): Promise<{ camera: boolean; mic: boolean }>
  }
  omtInput: {
    discover(): Promise<import('../shared/omt-input').OmtInputSource[]>
    retain(addresses: string[]): Promise<void>
    onFrame(cb: (packet: import('../shared/omt-input').OmtInputPacket) => void): Unsubscribe
    ack(sequence: number): void
    onError: (cb: (error: { addresses: string[]; message: string }) => void) => () => void
  }
  meter: {
    /** Окно-озвучиватель шлёт уровень эфира (0..1) оператору на индикатор. */
    report(level: number): void
    /** Только у оператора: уровень звука, реально уходящего в зал. */
    onProgramLevel(cb: (level: number) => void): Unsubscribe
  }
  /** Встроенная трансляция RTMP (main/stream/). Статус — в state.stream. */
  stream: {
    /** Частичная правка настроек; применяется сразу, качество — со следующего старта. */
    setSettings(patch: Partial<StreamSettings>): Promise<StreamSettings>
    start(): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<void>
    /** Журнал текущего/последнего эфира → рабочий стол (main/stream/streamer.ts пишет файл на каждый эфир). */
    saveLog(): Promise<{ ok: true; path: string } | { ok: false; error: string }>
    /** Уровень звука, уходящего в трансляцию (L, R: 0..1), ~10 раз в секунду. */
    onLevel(cb: (level: [number, number]) => void): Unsubscribe
  }
  /** Только для скрытого окна-кодировщика трансляции. */
  streamEnc: {
    init(): Promise<StreamSettings>
    onSettings(cb: (s: StreamSettings) => void): Unsubscribe
    /** Площадка (пере)подключилась — нужен ключевой кадр вне очереди. */
    onKeyframe(cb: () => void): Unsubscribe
    config(cfg: StreamEncoderConfig): void
    video(ts: number, key: boolean, data: Uint8Array): void
    audio(ts: number, data: Uint8Array): void
    status(st: StreamEncoderStatus): void
    level(l: [number, number]): void
  }
  /** Журнал и отчёт о проблеме (main/diag.ts). */
  materials: {
    configure(settings: import('../shared/material-settings.js').MaterialSettings): Promise<void>
    setDurations(ids: string[], durationMs: number): Promise<void>
  }
  diag: {
    /** Строка в общий журнал от имени этого окна. Для мест, где ошибка иначе глотается. */
    log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void
    /** ⚑ «здесь что-то не то». Номер маркера; null — дубль в пределах 400 мс. */
    mark(): Promise<number | null>
    info(): Promise<DiagInfo>
    /** Собрать zip на рабочий стол. Комментарий оператора уходит в report.txt. */
    removeMaterial(token: string, index: number): Promise<ReportMaterials>
    chooseMaterials(): Promise<{ selection: ReportMaterials | null; error?: string }>
    buildReport(comment: string, materialToken?: string, markerN?: number): Promise<ReportResult>
    openRecovery(): Promise<{ ok: boolean; error?: string; cancelled?: boolean; missing?: number }>
    showInFolder(path: string): Promise<void>
    openLogFolder(): Promise<void>
    /** Только у оператора: маркер поставлен (хоткеем или из меню). */
    onMarked(cb: (n: number) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    api: PresenterApi
  }
}

export type ProfileListResult = { ok: true; profiles: VenueProfile[] } | { ok: false; error: string }
