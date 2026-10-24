import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { t } from '../shared/i18n.js'
import { sanitizeSlideFadeMs } from '../shared/slide-transition.js'
import { audienceTimerConfig } from '../shared/audience-timer.js'
import type { ReportMarkerContext } from '../shared/report-recovery.js'
import type { AppState, DiagMarker, FileKind, PlaylistEntry, TimerState, VideoState } from '../shared/types.js'
import type { LoadedProject } from './project.js'

export interface RecoveryAttachment { name: string; data: Buffer; sourcePath: string }
export interface RecoveryPlan {
  project: LoadedProject
  preview: { path: string; slide: number; positionSec: number; kind: FileKind } | null
  missing: number
  context: ReportMarkerContext
}
interface RecoveryMaterial {
  role: 'program' | 'preview' | 'keyvisual'
  name: string
  path: string | null
  status: 'attached' | 'not-selected' | 'unsupported'
  kind: FileKind | null
}
interface RecoveryManifest {
  schemaVersion: 1
  marker: { n: number; at: string }
  complete: boolean
  materials: RecoveryMaterial[]
  context: ReportMarkerContext
}
const finite = (v: unknown, fallback = 0): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback
const videoSnapshot = (v: VideoState): VideoState => ({
  playing: v.playing === true, anchorSec: Math.max(0, finite(v.anchorSec)),
  anchorAt: typeof v.anchorAt === 'number' && Number.isFinite(v.anchorAt) ? v.anchorAt : null,
  durationSec: Math.max(0, finite(v.durationSec)), muted: v.muted === true,
})
const videoPosition = (v: VideoState, now: number): number => {
  const p = Math.max(0, finite(v.anchorSec) + (v.playing && v.anchorAt !== null ? Math.max(0, now - v.anchorAt) / 1000 : 0))
  return v.durationSec > 0 ? Math.min(p, v.durationSec) : p
}
const timerSnapshot = (timer: TimerState, now: number): TimerState => ({
  durationMs: Math.max(0, finite(timer.durationMs)), elapsedMs: Math.max(0, finite(timer.elapsedMs)) +
    (timer.running && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0),
  running: timer.running === true, startedAt: timer.running ? now : null, cycles: Math.max(0, finite(timer.cycles)),
})

export function captureMarkerContext(state: AppState, now = Date.now()): ReportMarkerContext {
  return {
    atUnixMs: now, programPath: state.pdfPath, programKind: state.fileKind,
    programPlaylistId: state.currentPlaylistId, slide: state.currentSlide,
    previewPath: state.preview.path, previewKind: state.preview.kind,
    previewPlaylistId: state.preview.playlistId, previewSlide: state.preview.currentSlide,
    video: videoSnapshot(state.video), videoPositionSec: videoPosition(state.video, now),
    previewVideo: videoSnapshot(state.preview.video), previewVideoPositionSec: videoPosition(state.preview.video, now),
    keyVisualPath: state.keyVisualPath, blackout: state.blackout,
    timer: timerSnapshot(state.timer, now), timerMode: state.timerMode,
    audienceTimer: { ...audienceTimerConfig(state.audienceTimer), ...timerSnapshot(state.audienceTimer, now), visible: state.audienceTimer.visible },
    slideFadeMs: sanitizeSlideFadeMs(state.playlist.find(entry => entry.id === state.currentPlaylistId)?.slideFadeMs),
    takeFadeMs: state.takeFadeMs,
    takeTransition: state.takeTransition ? { id: state.takeTransition.id, durationMs: state.takeTransition.durationMs } : null,
    listIndex: state.listIndex, previewListIndex: state.previewListIndex,
    sourceSlide: null, animationStep: null,
  }
}

/** Zero explicitly selects report-time state; omitted selects the latest marker. */
export function selectRecoveryMarker(markers: DiagMarker[], markerN: number | undefined, state: AppState, now: number): DiagMarker {
  if (markerN !== undefined && (!Number.isInteger(markerN) || markerN < 0)) throw new Error('Invalid recovery marker.')
  const marker = markerN === 0 ? undefined : markerN === undefined ? markers.at(-1) : markers.find(m => m.n === markerN)
  if (markerN !== undefined && markerN !== 0 && !marker) throw new Error('The selected marker was not found.')
  return marker ?? { n: 0, at: new Date(now).toLocaleTimeString('ru-RU'), context: captureMarkerContext(state, now) }
}

const supported = new Set(['pdf', 'pptx', 'ppt', 'odp', 'key', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'm4v', 'mov', 'webm'])
function kindOf(path: string): FileKind | null {
  const ext = extname(path).slice(1).toLowerCase()
  if (!supported.has(ext)) return null
  return ext === 'pdf' ? 'pdf' : ['pptx', 'ppt', 'odp', 'key'].includes(ext) ? 'pptx'
    : ['mp4', 'm4v', 'mov', 'webm'].includes(ext) ? 'video' : 'image'
}
function safeStoredPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length < 4096 &&
    !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes('\\') &&
    !path.includes(':') && !/[\x00-\x1f]/.test(path) &&
    path.split('/').every(p => p !== '' && p !== '.' && p !== '..') && path.startsWith('materials/')
}
function entryFor(path: string, index: number): PlaylistEntry {
  return { id: `recovery-${index + 1}`, kind: kindOf(path)!, filePath: path, fileName: basename(path), displayName: '', speakerName: '', durationMs: 0, loop: false }
}

/** Only approved original files are referenced; caches, notes and devices are never inferred. */
export function buildRecoveryPackage(marker: DiagMarker, attachments: RecoveryAttachment[]): { name: string; data: Buffer }[] {
  if (!marker.context) throw new Error('The selected marker has no playback context.')
  const context = marker.context as ReportMarkerContext
  const bySource = new Map(attachments.map(f => [f.sourcePath, f.name]))
  const materials: RecoveryMaterial[] = []
  for (const [role, path] of [['program', context.programPath], ['preview', context.previewPath], ['keyvisual', context.keyVisualPath]] as const) {
    if (!path) continue
    const name = basename(path.replace(/\\/g, '/'))
    const kind = kindOf(path)
    const chosen = bySource.get(path)
    const attached = chosen && safeStoredPath(chosen) && kind
    materials.push({ role, name, path: attached ? chosen : null, status: !kind ? 'unsupported' : attached ? 'attached' : 'not-selected', kind })
  }
  // A portable snapshot only names paths inside the report, including when materials are missing.
  const forRole = (role: RecoveryMaterial['role']): string | null => materials.find(m => m.role === role)?.path ?? null
  const portableContext: ReportMarkerContext = {
    atUnixMs: context.atUnixMs, programPath: forRole('program'), previewPath: forRole('preview'), keyVisualPath: forRole('keyvisual'),
    programKind: context.programKind, programPlaylistId: context.programPlaylistId,
    previewKind: context.previewKind, previewPlaylistId: context.previewPlaylistId,
    slide: context.slide, previewSlide: context.previewSlide,
    video: videoSnapshot(context.video), videoPositionSec: context.videoPositionSec ?? videoPosition(context.video, context.atUnixMs),
    previewVideo: context.previewVideo ? videoSnapshot(context.previewVideo) : undefined,
    previewVideoPositionSec: context.previewVideoPositionSec,
    blackout: context.blackout, timer: context.timer ? timerSnapshot(context.timer, context.atUnixMs) : undefined,
    timerMode: context.timerMode, audienceTimer: context.audienceTimer ? {
      ...audienceTimerConfig(context.audienceTimer), ...timerSnapshot(context.audienceTimer, context.atUnixMs), visible: context.audienceTimer.visible,
    } : undefined,
    slideFadeMs: sanitizeSlideFadeMs(context.slideFadeMs),
    takeFadeMs: context.takeFadeMs, takeTransition: context.takeTransition ? {
      id: context.takeTransition.id, durationMs: context.takeTransition.durationMs,
    } : null,
    listIndex: context.listIndex, previewListIndex: context.previewListIndex, sourceSlide: context.sourceSlide ?? null, animationStep: context.animationStep ?? null,
  }
  const manifest: RecoveryManifest = {
    schemaVersion: 1, marker: { n: marker.n, at: marker.at },
    complete: materials.length > 0 && materials.every(m => m.status === 'attached'), materials, context: portableContext,
  }
  const paths = [...new Set(materials.flatMap(m => m.path ? [m.path] : []))]
  const project = { schemaVersion: 2, createdAt: new Date(context.atUnixMs).toISOString(), updatedAt: new Date(context.atUnixMs).toISOString(),
    playlist: paths.map((path, index) => ({ ...entryFor(path, index), ...(path === forRole('program') ? { slideFadeMs: sanitizeSlideFadeMs(context.slideFadeMs) } : {}) })), keyVisualPath: null,
    ...(context.audienceTimer ? { audienceTimer: audienceTimerConfig(context.audienceTimer) } : {}),
  }
  const missing = materials.filter(m => m.status !== 'attached').map(m => `- ${m.role}: ${m.name} (${m.status})`)
  const readme = [
    t('Воспроизведение момента CueDeck'), '', t('Маркер #{n}, {at}.', { n: marker.n, at: marker.at }),
    t('Распакуйте ZIP целиком в отдельную папку. В CueDeck откройте «Справка → Сообщить о проблеме…»,'),
    t('нажмите «Восстановить из отчёта…» и выберите recovery.pdpres.'),
    t('Материал загрузится в превью на позиции маркера, с паузой и без звука. Эфир и устройства не меняются.'),
    t('Чтобы проверить переход, включите воспроизведение или нажмите TAKE вручную.'), '',
    manifest.complete ? t('Все известные CueDeck файловые источники этого маркера приложены.') : t('Набор неполный. Для недостающих файлов попросите исходники у автора:'),
    ...missing, '',
    t('Большие файлы свыше общего лимита 128 МиБ отправляются отдельно. Соседние файлы и заметки автоматически не приложены.'),
    t('PPTX конвертируется заново: кэш и системные шрифты не приложены. Связанные внешние ролики нужно выбирать отдельно.'),
    t('Номер страницы CueDeck сохранён. Карта исходных слайдов PPTX и шагов анимации пока недоступна.'),
    t('Таймеры и параметры перехода записаны в recovery.json для сравнения; они не запускаются автоматически.'),
    t('Потоки, ключи трансляций, глобальные клавиши и подключённое оборудование не восстанавливаются.'),
    t('Версии LibreOffice, кодеки, шрифты и оборудование могут менять результат. Такой пакет помогает повторить действия, но не гарантирует тот же сбой.'), '',
  ].join('\n')
  const json = (name: string, data: unknown): { name: string; data: Buffer } => ({ name, data: Buffer.from(JSON.stringify(data, null, 2)) })
  return [json('recovery.pdpres', project), json('recovery.json', manifest), { name: 'README-recovery.txt', data: Buffer.from(readme) }]
}

async function boundedJson(path: string, root: string): Promise<unknown> {
  const actual = await realpath(path)
  const rel = relative(root, actual)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Recovery metadata escapes the report folder.')
  const handle = await open(actual, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Recovery metadata is too large or is not a file.')
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset)
      if (!read.bytesRead) throw new Error('Recovery metadata changed while reading.')
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Recovery metadata changed while reading.')
    return JSON.parse(data.toString('utf8'))
  } finally { await handle.close() }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** Validate extracted packages before loading. No absolute paths, traversal, devices or symlink escapes. */
export async function readRecoveryProject(projectPath: string): Promise<RecoveryPlan> {
  if (basename(projectPath) !== 'recovery.pdpres') throw new Error('Choose recovery.pdpres from an extracted CueDeck report.')
  const root = await realpath(dirname(projectPath))
  const raw = object(await boundedJson(projectPath, root))
  const manifest = object(await boundedJson(resolve(root, 'recovery.json'), root))
  if (raw.schemaVersion !== 2 || manifest.schemaVersion !== 1 || !Array.isArray(raw.playlist) || raw.playlist.length > 100 ||
      !Array.isArray(manifest.materials) || manifest.materials.length > 3) throw new Error('Unsupported recovery snapshot.')
  const materials = manifest.materials.map(object)
  const known = new Set<string>()
  const roles = new Set<string>()
  for (const m of materials) {
    if (!['program', 'preview', 'keyvisual'].includes(String(m.role)) || !['attached', 'not-selected', 'unsupported'].includes(String(m.status)) ||
      typeof m.name !== 'string' || (m.path !== null && (!safeStoredPath(m.path) || !kindOf(m.path)))) throw new Error('Invalid recovery material.')
    if (roles.has(String(m.role))) throw new Error('Duplicate recovery material role.')
    roles.add(String(m.role))
    if (m.status === 'attached' && typeof m.path !== 'string') throw new Error('Attached recovery material has no path.')
    if (m.status === 'attached' && typeof m.path === 'string') known.add(m.path)
    else if (m.path !== null) throw new Error('Invalid recovery material status.')
  }
  const playlist: PlaylistEntry[] = []
  const available = new Map<string, string>()
  let missing = materials.filter(m => m.status !== 'attached').length
  const referenced = new Set<string>()
  for (const value of raw.playlist) {
    const entry = object(value)
    if (!safeStoredPath(entry.filePath) || !known.has(entry.filePath) || !kindOf(entry.filePath) || entry.kind === 'live' || entry.kind === 'list') throw new Error('Unsafe recovery project path.')
    if (referenced.has(entry.filePath)) throw new Error('Duplicate recovery material.')
    referenced.add(entry.filePath)
    const path = resolve(root, entry.filePath)
    try {
      const actual = await realpath(path)
      const rel = relative(root, actual)
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Recovery material escapes the report folder.')
      if (!(await stat(actual)).isFile()) throw new Error('Recovery material is not a file.')
      available.set(entry.filePath, path)
      playlist.push({ ...entryFor(path, playlist.length), slideFadeMs: sanitizeSlideFadeMs(entry.slideFadeMs) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { missing++; continue }
      throw error
    }
  }
  if (referenced.size !== known.size) throw new Error('Recovery project and manifest disagree.')
  const inputContext = object(manifest.context)
  // Rebuild the whitelist rather than importing arbitrary production state from the package.
  const video = videoSnapshot(object(inputContext.video) as unknown as VideoState)
  const previewVideo = videoSnapshot(object(inputContext.previewVideo) as unknown as VideoState)
  const pathFor = (role: string): string | null => {
    const path = materials.find(m => m.role === role)?.path
    return typeof path === 'string' ? available.get(path) ?? null : null
  }
  const context: ReportMarkerContext = {
    atUnixMs: Math.max(0, finite(inputContext.atUnixMs)), programPath: pathFor('program'), previewPath: pathFor('preview'),
    slide: Math.max(1, Math.floor(finite(inputContext.slide, 1))), previewSlide: Math.max(1, Math.floor(finite(inputContext.previewSlide, 1))),
    video, videoPositionSec: Math.max(0, finite(inputContext.videoPositionSec, videoPosition(video, finite(inputContext.atUnixMs)))), previewVideo,
    previewVideoPositionSec: Math.max(0, finite(inputContext.previewVideoPositionSec, videoPosition(previewVideo, finite(inputContext.atUnixMs)))), keyVisualPath: pathFor('keyvisual'),
    slideFadeMs: sanitizeSlideFadeMs(inputContext.slideFadeMs),
    sourceSlide: null, animationStep: null,
    ...(inputContext.audienceTimer ? { audienceTimer: { ...audienceTimerConfig(inputContext.audienceTimer), running: false, startedAt: null, elapsedMs: 0, cycles: 0, visible: false } } : {}),
  }
  const path = context.programPath ?? context.previewPath
  const isProgram = path === context.programPath
  return {
    project: { playlist, playlistFolders: [], keyVisualPath: null },
    preview: path ? { path, slide: isProgram ? context.slide : context.previewSlide, positionSec: isProgram ? context.videoPositionSec! : context.previewVideoPositionSec!, kind: kindOf(path)! } : null,
    missing, context,
  }
}
