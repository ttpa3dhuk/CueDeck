import type { PlaylistEntry } from '../../shared/types'
import type { OmtInputSource } from '../../shared/omt-input'
import { validOmtAddress } from '../../shared/omt-input'
import { parseLiveUri } from '../../shared/live'
import { t } from '../../shared/i18n'

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
let editingId: string | null = null
let chosen: OmtInputSource | null = null
let generation = 0
let refreshTimer: number | null = null
let refreshing = false

function close(): void {
  ++generation
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
  refreshTimer = null
  el('omt-input-modal').classList.add('hidden')
}
async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  const request = generation
  const status = el('omt-input-status')
  status.textContent = t('Поиск источников OMT…')
  try {
    const sources = await window.api.omtInput.discover()
    if (request !== generation) return
    const list = el('omt-input-list')
    list.replaceChildren()
    status.textContent = sources.length ? '' : t('Источников OMT пока нет. Включи выход на передающем компьютере или укажи адрес вручную.')
    for (const source of sources) {
      const row = document.createElement('label')
      row.className = 'audio-device-row'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'omt-input-source'
      radio.checked = source.address === chosen?.address
      radio.addEventListener('change', () => {
        chosen = source
        el<HTMLInputElement>('omt-input-address').value = ''
      })
      const name = document.createElement('span')
      name.textContent = source.name
      row.append(radio, name)
      list.append(row)
    }
  } catch (error) {
    if (request === generation) status.textContent = t('Не удалось найти OMT: {error}', { error: String(error) })
  } finally { refreshing = false }
}
export function openOmtInputModal(entry?: PlaylistEntry): void {
  close()
  const source = entry ? parseLiveUri(entry.filePath) : null
  editingId = entry?.id ?? null
  chosen = source?.kind === 'omt' ? { name: source.videoLabel, address: source.omtAddress! } : null
  el('omt-input-title').textContent = entry ? t('Настройка приёма OMT') : t('Приём OMT')
  el('omt-input-add').textContent = entry ? t('Сохранить') : t('Добавить в плейлист')
  el<HTMLInputElement>('omt-input-address').value = chosen?.address ?? ''
  el<HTMLInputElement>('omt-input-audio').checked = source?.kind === 'omt' ? !!source.audioLabel : true
  el('omt-input-modal').classList.remove('hidden')
  void refresh()
  refreshTimer = window.setInterval(() => { void refresh() }, 2000)
}
async function save(): Promise<void> {
  const address = el<HTMLInputElement>('omt-input-address').value.trim() || chosen?.address || ''
  if (!validOmtAddress(address)) {
    el('omt-input-status').textContent = t('Выбери источник или введи адрес вида omt://компьютер:порт')
    return
  }
  const videoLabel = chosen?.address === address ? chosen.name : address
  const source = { kind: 'omt' as const, omtAddress: address, videoLabel,
    audioLabel: el<HTMLInputElement>('omt-input-audio').checked ? videoLabel : null }
  const request = generation
  const button = el<HTMLButtonElement>('omt-input-add')
  button.disabled = true
  try {
    if (editingId) await window.api.playlist.updateLive(editingId, source)
    else await window.api.playlist.addLive(source)
    if (request === generation) close()
  } catch (error) {
    if (request === generation) el('omt-input-status').textContent = t('Не удалось добавить OMT: {error}', { error: String(error) })
  } finally { button.disabled = false }
}
export function initOmtInputUi(): void {
  el('omt-input-address').addEventListener('input', () => {
    chosen = null
    el('omt-input-list').querySelectorAll<HTMLInputElement>('input').forEach(radio => { radio.checked = false })
  })
  el('omt-input-refresh').addEventListener('click', () => { void refresh() })
  el('omt-input-cancel').addEventListener('click', close)
  el('omt-input-add').addEventListener('click', () => { void save() })
  el('omt-input-modal').addEventListener('click', event => { if (event.target === el('omt-input-modal')) close() })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el('omt-input-modal').classList.contains('hidden')) {
      event.preventDefault(); event.stopImmediatePropagation(); close()
    }
  }, true)
  window.addEventListener('beforeunload', close)
}
import.meta.hot?.dispose(close)
