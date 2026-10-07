/**
 * Профили площадки: «приехал на знакомую площадку —
 * выбрал профиль — всё встало». Разбор и формат файла — profile-core.ts.
 *
 * Применение идёт через те же обработчики ipc, что кнопки «Настроек»
 * (`callIpcHandler`): у каждой настройки свои побочные действия (кликер
 * захватывает клавиши системно, внешнее управление перезапускает слушатели,
 * раскладка пересобирает окна) — дублировать их здесь нельзя.
 *
 * Звук main применить не может: выходы видит только рендерер
 * (enumerateDevices), и id устройства у каждого компьютера свой. Поэтому
 * main возвращает окну оператора имена выходов, а оно ищет их у себя.
 */
import { app, dialog, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import log from 'electron-log/main'
import { store } from './state.js'
import { autoAssignDisplays } from './layout.js'
import { getMidiInputs, getRemoteSettings, getSavedMapping, getVenueProfiles, setVenueProfiles } from './display-mapping.js'
import { getOperatorWindow } from './windows.js'
import { callIpcHandler } from './remote/server.js'
import {
  MAX_PROFILES,
  PROFILE_EXT,
  PROFILE_GROUPS,
  cleanName,
  mergeSettings,
  sanitizeGroups,
  parseProfileFile,
  profileFileName,
  sanitizeProfileList,
  serializeProfileFile,
  uniqueProfileName,
} from './profile-core.js'
import type { ProfileApplyResult, ProfileAudioOutput, ProfileGroup, VenueProfile, VenueProfileSettings } from '../shared/types.js'
import { t } from '../shared/i18n.js'

function list(): VenueProfile[] {
  return sanitizeProfileList(getVenueProfiles())
}

/** Текущие настройки площадки. Имена звуковых выходов даёт окно оператора. */
function captureSettings(labels: { main: string | null; preview: string | null }): VenueProfileSettings {
  const s = store.get()
  const out = (id: string | null, label: string | null): ProfileAudioOutput | null =>
    id && label ? { id, label } : null
  return {
    layout: s.layout,
    audienceWindowed: s.audienceWindowed,
    outputMonitorsEnabled: s.outputMonitorsEnabled,
    audioMain: out(s.audioOutputId, labels.main),
    audioPreview: out(s.previewAudioOutputId, labels.preview),
    timerMode: s.timerMode,
    timerPosition: s.timerPosition,
    timerScale: s.timerScale,
    timerFree: { ...s.timerFree },
    timerColor: s.timerColor,
    timerWarnColors: s.timerWarnColors,
    timerTickEnabled: s.timerTickEnabled,
    timerGongEnabled: s.timerGongEnabled,
    timerLoop: s.timerLoop,
    timerPresets: [...s.timerPresets],
    speakerLayout: { ...s.speakerLayout },
    speakerMsgLayout: { pos: s.speakerMsgLayout.pos ? { ...s.speakerMsgLayout.pos } : null, scale: s.speakerMsgLayout.scale },
    speakerMsgPresets: [...s.speakerMsgPresets],
    videoTakeMode: s.videoTakeMode,
    slideTakeMode: s.slideTakeMode,
    autoAdvance: s.autoAdvance,
    clickerGlobal: s.clickerGlobal,
    clickerGlobalArrows: s.clickerGlobalArrows,
    remote: getRemoteSettings(),
    midiInputs: getMidiInputs(),
  }
}

type Labels = { main?: unknown; preview?: unknown }
const label = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Применить настройки. Порядок важен: раскладка — последней (она пересобирает
 * окна, остальное к этому моменту уже в состоянии и новые окна его подхватят).
 */
async function applySettings(p: VenueProfileSettings, groups: readonly ProfileGroup[]): Promise<boolean> {
  const call = callIpcHandler
  const has = (g: ProfileGroup): boolean => groups.includes(g)
  if (has('timer')) {
    await call('timer:set-mode', p.timerMode)
    await call('timer:set-tick-sound', p.timerTickEnabled)
    await call('timer:set-gong-sound', p.timerGongEnabled)
    await call('timer:set-loop', p.timerLoop)
  }
  if (has('presets')) {
    if (p.timerPresets.length) await call('timer:set-presets', p.timerPresets)
    if (p.speakerMsgPresets.length) await call('speaker-message:set-presets', p.speakerMsgPresets)
  }
  if (has('prompter')) {
    // set-free переводит таймер в 'free' — поэтому позиция следом, отдельно.
    await call('timer:set-free', p.timerFree.x, p.timerFree.y)
    await call('timer:set-position', p.timerPosition)
    await call('timer:set-scale', p.timerScale)
    await call('timer:set-color', p.timerColor)
    await call('timer:set-warn-colors', p.timerWarnColors)
    await call('prompter:set-layout', p.speakerLayout)
    await call('speaker-message:set-layout', p.speakerMsgLayout)
  }
  if (has('take')) {
    await call('preview:set-video-take-mode', p.videoTakeMode)
    await call('preview:set-slide-take-mode', p.slideTakeMode)
    await call('playlist:set-auto-advance', p.autoAdvance)
  }
  if (has('clicker')) {
    // Стрелки — намерение, запоминается и при выключенном глобальном режиме;
    // сам режим следом захватывает клавиши с учётом стрелок.
    await call('clicker:set-global-arrows', p.clickerGlobalArrows)
    await call('clicker:set-global', p.clickerGlobal)
  }
  if (has('remote')) {
    const r = (await call('remote:configure', p.remote)) as { ok?: boolean; error?: string } | undefined
    if (r && r.ok === false) log.warn(`profile: внешнее управление не применено: ${r.error ?? ''}`)
  }
  if (has('midi')) await call('midi:set-enabled', p.midiInputs)
  if (!has('screens')) return false
  await call('monitor:set-enabled', p.outputMonitorsEnabled)

  const s = store.get()
  if (s.layout === p.layout && s.audienceWindowed === p.audienceWindowed) return false
  // Карта экранов — не из профиля: id дисплеев у каждого компьютера свои.
  // Ручная расстановка для этих экранов сохраняется, если режим совпадает.
  const saved = getSavedMapping()
  const primaryId = screen.getPrimaryDisplay().id
  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, internal: d.id === primaryId }))
  const displayMap = saved && saved.layout === p.layout ? saved.displayMap : autoAssignDisplays(p.layout, displays)
  await call('layout:set', { layout: p.layout, displayMap, audienceWindowed: p.audienceWindowed })
  return true
}

export function registerProfileIpc(): void {
  ipcMain.handle('profiles:list', () => list())

  /**
   * Сохранить текущие настройки: новый профиль или поверх существующего (id).
   * groups — что записывать. Новый профиль хранит только их; у существующего
   * переписываются только они, остальное в профиле остаётся как было.
   */
  ipcMain.handle('profiles:save', (_e, name: unknown, labels: Labels, id?: unknown, rawGroups?: unknown) => {
    const groups = rawGroups === undefined ? [...PROFILE_GROUPS] : sanitizeGroups(rawGroups)
    if (!groups.length) return { ok: false, error: t('Отметь, что сохранять') }
    const profiles = list()
    const settings = captureSettings({ main: label(labels?.main), preview: label(labels?.preview) })
    const savedAt = new Date().toISOString()
    const existing = typeof id === 'string' ? profiles.find((p) => p.id === id) : undefined
    if (existing) {
      existing.settings = mergeSettings(existing.settings, settings, groups)
      existing.groups = PROFILE_GROUPS.filter((g) => existing.groups.includes(g) || groups.includes(g))
      existing.savedAt = savedAt
    } else {
      const clean = cleanName(name)
      if (!clean) return { ok: false, error: t('Назови профиль') }
      if (profiles.length >= MAX_PROFILES) return { ok: false, error: t('Слишком много профилей') }
      profiles.push({
        id: randomUUID(),
        name: uniqueProfileName(clean, profiles.map((p) => p.name)),
        groups,
        savedAt,
        settings,
      })
    }
    setVenueProfiles(profiles)
    return { ok: true, profiles }
  })

  ipcMain.handle('profiles:rename', (_e, id: unknown, name: unknown) => {
    const profiles = list()
    const p = profiles.find((x) => x.id === id)
    const clean = cleanName(name)
    if (!p || !clean) return { ok: false, error: t('Назови профиль') }
    p.name = uniqueProfileName(clean, profiles.filter((x) => x !== p).map((x) => x.name))
    setVenueProfiles(profiles)
    return { ok: true, profiles }
  })

  ipcMain.handle('profiles:delete', (_e, id: unknown) => {
    const profiles = list().filter((p) => p.id !== id)
    setVenueProfiles(profiles)
    return { ok: true, profiles }
  })

  /**
   * Применить профиль. groups — что вгрузить (галки у оператора): ставится
   * пересечение с тем, что в профиле есть. Не передали — весь профиль.
   */
  ipcMain.handle('profiles:apply', async (_e, id: unknown, rawGroups?: unknown): Promise<ProfileApplyResult> => {
    const p = list().find((x) => x.id === id)
    if (!p) return { ok: false, error: t('Профиль не найден') }
    const wanted = rawGroups === undefined ? p.groups : sanitizeGroups(rawGroups)
    const groups = p.groups.filter((g) => wanted.includes(g))
    if (!groups.length) return { ok: false, error: t('В профиле нет ничего из отмеченного') }
    try {
      const layoutChanged = await applySettings(p.settings, groups)
      log.info(`profile: применён «${p.name}» [${groups.join(', ')}]${layoutChanged ? ', раскладка сменилась' : ''}`)
      return {
        ok: true,
        name: p.name,
        groups,
        audio: groups.includes('audio'),
        audioMain: p.settings.audioMain,
        audioPreview: p.settings.audioPreview,
        layoutChanged,
      }
    } catch (err) {
      log.error('profile: не применился', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('profiles:export', async (_e, id: unknown) => {
    const p = list().find((x) => x.id === id)
    if (!p) return { ok: false, error: t('Профиль не найден') }
    const res = await dialog.showSaveDialog(getOperatorWindow()!, {
      title: t('Сохранить профиль в файл'),
      defaultPath: profileFileName(p.name),
      filters: [{ name: 'CueDeck venue profile', extensions: [PROFILE_EXT] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    try {
      await writeFile(res.filePath, serializeProfileFile(p, app.getVersion()), 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('profiles:import', async () => {
    const res = await dialog.showOpenDialog(getOperatorWindow()!, {
      title: t('Загрузить профиль из файла'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'CueDeck venue profile', extensions: [PROFILE_EXT] }],
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    const profiles = list()
    const errors: string[] = []
    let added = 0
    for (const path of res.filePaths) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (err) {
        errors.push(`${basename(path)}: ${(err as Error).message}`)
        continue
      }
      const parsed = parseProfileFile(text, basename(path, extname(path)))
      if (!parsed.ok) {
        const why =
          parsed.error === 'newer'
            ? t('файл из более новой версии CueDeck — обнови программу')
            : t('это не профиль CueDeck')
        errors.push(`${basename(path)}: ${why}`)
        continue
      }
      if (profiles.length >= MAX_PROFILES) {
        errors.push(t('Слишком много профилей'))
        break
      }
      profiles.push({
        id: randomUUID(),
        name: uniqueProfileName(parsed.name, profiles.map((p) => p.name)),
        groups: parsed.groups,
        savedAt: parsed.savedAt,
        settings: parsed.settings,
      })
      added++
    }
    if (added) setVenueProfiles(profiles)
    return { ok: added > 0, added, errors, profiles }
  })
}
