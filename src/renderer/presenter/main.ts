import { initBus, getState, subscribe } from '../shared/bus'
import { loadDocument, renderPageTo, prerender, totalPages } from '../shared/pdf-loader'
import { startTick, timerView, type TimerView } from '../shared/timer'
import type {
  AppState,
  DisplayInfo,
  DisplayMap,
  Layout,
  PlaylistEntry,
  Role,
  TimerMode,
  TimerPosition,
} from '../../preload/api'

const role: Role = (new URL(location.href).searchParams.get('role') as Role) ?? 'operator'
document.body.dataset.role = role

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// Имя файла из пути — и POSIX, и Windows-разделители
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? ''

const slidePlaceholder = $('slide-placeholder')
const pdfName = $('pdf-name')
const slideCounter = $('slide-counter')
const slideRemaining = $('slide-remaining')
const timerDisplay = $('timer-display')
const timerToggle = $<HTMLButtonElement>('timer-toggle')
const timerReset = $<HTMLButtonElement>('timer-reset')
const blackoutToggle = $<HTMLButtonElement>('blackout-toggle')
const durationInput = role === 'operator' ? $<HTMLInputElement>('duration-input') : null
const modeSelect = role === 'operator' ? $<HTMLSelectElement>('mode-select') : null
const playlistList = role === 'operator' ? $<HTMLOListElement>('playlist-list') : null
const playlistEmpty = role === 'operator' ? $('playlist-empty') : null
const playlistAddBtn = role === 'operator' ? $<HTMLButtonElement>('playlist-add') : null
const playlistCompactToggle = role === 'operator' ? $<HTMLInputElement>('playlist-compact-toggle') : null
const playlistAutoAdvanceToggle = role === 'operator' ? $<HTMLInputElement>('playlist-auto-advance-toggle') : null
const kvPreview = role === 'operator' ? $('kv-preview') : null
const kvSetBtn = role === 'operator' ? $<HTMLButtonElement>('kv-set') : null
const kvClearBtn = role === 'operator' ? $<HTMLButtonElement>('kv-clear') : null

let sofficePresentCache: boolean | null = null

async function checkSoffice(): Promise<boolean> {
  if (sofficePresentCache !== null) return sofficePresentCache
  sofficePresentCache = await window.api.soffice.check()
  return sofficePresentCache
}

let kvBlobUrl: string | null = null
let kvLoadedForPath: string | null | undefined = undefined

async function refreshKeyVisualPreview(state: AppState): Promise<void> {
  if (!kvPreview || !kvClearBtn) return
  const path = state.keyVisualPath
  kvClearBtn.disabled = !path

  if (path === kvLoadedForPath) return
  kvLoadedForPath = path

  if (kvBlobUrl) {
    URL.revokeObjectURL(kvBlobUrl)
    kvBlobUrl = null
  }

  if (!path) {
    kvPreview.classList.add('kv-empty')
    kvPreview.textContent = 'Нет заставки — Blackout покажет чёрный экран'
    kvPreview.style.backgroundImage = ''
    return
  }

  const data = await window.api.keyvisual.read()
  if (!data) {
    kvPreview.classList.add('kv-empty')
    kvPreview.textContent = 'Не удалось загрузить файл'
    kvPreview.style.backgroundImage = ''
    return
  }
  const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
  kvBlobUrl = URL.createObjectURL(blob)
  kvPreview.classList.remove('kv-empty')
  kvPreview.textContent = ''
  kvPreview.style.backgroundImage = `url(${kvBlobUrl})`
}
const currentCanvas = $<HTMLCanvasElement>('current-canvas')
const currentImage = $<HTMLImageElement>('current-image')
const nextCanvas = $<HTMLCanvasElement>('next-canvas')
const nextEmpty = $('next-empty')
const notesInput = $<HTMLTextAreaElement>('notes-input')
const notesReadonly = $('notes-readonly')
const banner = $('banner')
const setupModal = $('setup-modal')

let docLoaded = false
let lastRenderedSlide = -1
let currentImageBlobUrl: string | null = null

function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (ctx) {
    canvas.width = 1
    canvas.height = 1
    ctx.clearRect(0, 0, 1, 1)
  }
}

function disposeCurrentImage(): void {
  if (currentImageBlobUrl) {
    URL.revokeObjectURL(currentImageBlobUrl)
    currentImageBlobUrl = null
  }
}

async function loadCurrentFile(): Promise<void> {
  const state = getState()
  disposeCurrentImage()
  docLoaded = false
  lastRenderedSlide = -1

  const data = await window.api.pdf.read()
  if (!data) return

  slidePlaceholder.classList.add('hidden')

  if (state.fileKind === 'image') {
    const blob = new Blob([data.bytes as BlobPart], { type: data.mime })
    currentImageBlobUrl = URL.createObjectURL(blob)
    currentImage.src = currentImageBlobUrl
    currentImage.classList.remove('hidden')
    currentCanvas.classList.add('hidden')
    clearCanvas(nextCanvas)
    nextCanvas.classList.add('hidden')
    nextEmpty.classList.remove('hidden')
    await window.api.pdf.reportTotal(1)
    return
  }

  // PDF path (also covers pptx converted to pdf)
  currentImage.classList.add('hidden')
  currentImage.removeAttribute('src')
  currentCanvas.classList.remove('hidden')
  nextCanvas.classList.remove('hidden')
  nextEmpty.classList.add('hidden')
  await loadDocument(data.bytes)
  docLoaded = true
  await window.api.pdf.reportTotal(totalPages())
  await renderCurrent()
}

async function renderCurrent(): Promise<void> {
  const state = getState()
  if (state.fileKind === 'image' || state.fileKind === null) return
  if (!docLoaded) return
  const slide = state.currentSlide
  if (slide === lastRenderedSlide) return
  lastRenderedSlide = slide

  const slideEl = currentCanvas.parentElement!
  const currentWidth = slideEl.clientWidth
  await renderPageTo(slide, currentCanvas, currentWidth)

  const nextWidth = nextCanvas.parentElement!.clientWidth
  if (slide + 1 <= state.totalSlides) {
    await renderPageTo(slide + 1, nextCanvas, nextWidth)
    prerender(slide + 2, currentWidth).catch(() => undefined)
  } else {
    clearCanvas(nextCanvas)
  }
}

function applyTimerView(view: TimerView): void {
  let cls = `timer ${view.color}`
  if (view.overtime) cls += ' overtime'
  timerDisplay.className = cls
  timerDisplay.textContent = view.text
}

const playlistNodes = new Map<string, HTMLLIElement>()

function createPlaylistItem(entry: PlaylistEntry): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'playlist-item'
  li.draggable = true
  li.dataset.id = entry.id

  const row1 = document.createElement('div')
  row1.className = 'row'

  const handle = document.createElement('span')
  handle.className = 'drag-handle'
  handle.textContent = '⋮⋮'

  const kindBadge = document.createElement('span')
  kindBadge.className = `kind-badge kind-${entry.kind}`
  kindBadge.textContent = entry.kind === 'pptx' ? 'PPTX' : entry.kind === 'image' ? 'IMG' : 'PDF'

  const name = document.createElement('span')
  name.className = 'pdf-name'
  name.textContent = entry.fileName
  name.title = entry.filePath

  const removeBtn = document.createElement('button')
  removeBtn.className = 'remove'
  removeBtn.textContent = '✕'
  removeBtn.title = 'Удалить из плейлиста'
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    window.api.playlist.remove(entry.id)
  })

  row1.append(handle, kindBadge, name, removeBtn)

  const speakerInput = document.createElement('input')
  speakerInput.type = 'text'
  speakerInput.className = 'speaker-name'
  speakerInput.placeholder = 'Имя спикера'
  speakerInput.value = entry.speakerName
  speakerInput.addEventListener('click', (e) => e.stopPropagation())
  speakerInput.addEventListener('mousedown', (e) => e.stopPropagation())
  let speakerDebounce: number | null = null
  speakerInput.addEventListener('input', () => {
    if (speakerDebounce) window.clearTimeout(speakerDebounce)
    speakerDebounce = window.setTimeout(() => {
      window.api.playlist.update(entry.id, { speakerName: speakerInput.value })
    }, 400)
  })

  const durRow = document.createElement('div')
  durRow.className = 'duration-row'
  const durLabel = document.createElement('span')
  durLabel.textContent = 'Таймер:'
  const durInput = document.createElement('input')
  durInput.type = 'number'
  durInput.min = '0'
  durInput.step = '1'
  durInput.className = 'duration'
  durInput.value = String(Math.round(entry.durationMs / 60000))
  durInput.addEventListener('click', (e) => e.stopPropagation())
  durInput.addEventListener('mousedown', (e) => e.stopPropagation())
  let durDebounce: number | null = null
  durInput.addEventListener('input', () => {
    if (durDebounce) window.clearTimeout(durDebounce)
    durDebounce = window.setTimeout(() => {
      const min = Math.max(0, Math.floor(Number(durInput.value) || 0))
      window.api.playlist.update(entry.id, { durationMs: min * 60_000 })
    }, 400)
  })
  const durSuffix = document.createElement('span')
  durSuffix.textContent = 'мин'
  durRow.append(durLabel, durInput, durSuffix)

  li.append(row1, speakerInput, durRow)

  li.addEventListener('click', async () => {
    if (entry.kind === 'pptx') {
      const hasLo = await checkSoffice()
      if (!hasLo) {
        showLoModal()
        return
      }
      showBanner('Конвертация PPTX через LibreOffice…', 60_000)
    }
    const res = await window.api.playlist.activate(entry.id)
    if (entry.kind === 'pptx') {
      banner.classList.add('hidden')
    }
    if (!res.ok && res.error) showBanner(`Ошибка: ${res.error}`, 8000)
  })

  li.addEventListener('dragstart', (e) => {
    li.classList.add('dragging')
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', entry.id)
    }
  })
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging')
    document
      .querySelectorAll('.playlist-item.drop-target')
      .forEach((n) => n.classList.remove('drop-target'))
  })
  li.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    li.classList.add('drop-target')
  })
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-target')
  })
  li.addEventListener('drop', (e) => {
    e.preventDefault()
    li.classList.remove('drop-target')
    const draggedId = e.dataTransfer?.getData('text/plain')
    if (draggedId && draggedId !== entry.id) reorderAroundTarget(draggedId, entry.id)
  })

  return li
}

function updatePlaylistItem(node: HTMLLIElement, entry: PlaylistEntry): void {
  const name = node.querySelector<HTMLSpanElement>('.pdf-name')
  if (name) {
    name.textContent = entry.fileName
    name.title = entry.filePath
  }
  const speakerInput = node.querySelector<HTMLInputElement>('.speaker-name')
  if (speakerInput && document.activeElement !== speakerInput) {
    speakerInput.value = entry.speakerName
  }
  const durInput = node.querySelector<HTMLInputElement>('input.duration')
  if (durInput && document.activeElement !== durInput) {
    durInput.value = String(Math.round(entry.durationMs / 60000))
  }
}

function reorderAroundTarget(draggedId: string, targetId: string): void {
  const state = getState()
  const ids = state.playlist.map((e) => e.id).filter((id) => id !== draggedId)
  const targetIdx = ids.indexOf(targetId)
  if (targetIdx < 0) return
  ids.splice(targetIdx, 0, draggedId)
  window.api.playlist.reorder(ids)
}

function updateLibreOfficeNotice(state: AppState): void {
  const notice = document.getElementById('libreoffice-notice')
  if (!notice) return
  const hasPptx = state.playlist.some((e) => e.kind === 'pptx')
  if (hasPptx && sofficePresentCache === false) {
    notice.classList.remove('hidden')
  } else {
    notice.classList.add('hidden')
  }
}

function renderPlaylist(state: AppState): void {
  if (!playlistList || !playlistEmpty) return

  const entries = state.playlist
  playlistEmpty.classList.toggle('hidden', entries.length > 0)

  const wantedIds = new Set(entries.map((e) => e.id))
  for (const [id, node] of playlistNodes) {
    if (!wantedIds.has(id)) {
      node.remove()
      playlistNodes.delete(id)
    }
  }

  entries.forEach((entry, idx) => {
    let node = playlistNodes.get(entry.id)
    if (!node) {
      node = createPlaylistItem(entry)
      playlistNodes.set(entry.id, node)
    } else {
      updatePlaylistItem(node, entry)
    }
    const at = playlistList.children[idx]
    if (at !== node) playlistList.insertBefore(node, at ?? null)
  })

  for (const [id, node] of playlistNodes) {
    node.classList.toggle('active', id === state.currentPlaylistId)
  }

  updateLibreOfficeNotice(state)
}

function applyState(state: AppState): void {
  if (state.pdfPath) {
    slidePlaceholder.classList.add('hidden')
    pdfName.textContent = baseName(state.pdfPath)
    slideCounter.textContent = `Слайд ${state.currentSlide} из ${state.totalSlides || '—'}`
    const remaining = Math.max(0, (state.totalSlides || 0) - state.currentSlide)
    slideRemaining.textContent = state.totalSlides > 0 ? `(осталось ${remaining})` : ''
  } else {
    slidePlaceholder.classList.remove('hidden')
    pdfName.textContent = ''
    slideCounter.textContent = 'Слайд — из —'
    slideRemaining.textContent = ''
    currentCanvas.classList.add('hidden')
    currentImage.classList.add('hidden')
    currentImage.removeAttribute('src')
    nextCanvas.classList.add('hidden')
    nextEmpty.classList.add('hidden')
  }

  timerToggle.textContent = state.timer.running ? '⏸' : '▶'
  blackoutToggle.style.background = state.blackout ? 'var(--danger)' : ''

  if (durationInput && document.activeElement !== durationInput) {
    const minutes = Math.round(state.timer.durationMs / 60000)
    durationInput.value = String(minutes)
  }
  if (modeSelect && modeSelect.value !== state.timerMode) {
    modeSelect.value = state.timerMode
  }
  document.body.dataset.timerPosition = state.timerPosition
  document.documentElement.style.setProperty(
    '--notes-font-size',
    `${state.notesFontSize}px`,
  )
  document.documentElement.style.setProperty(
    '--timer-scale',
    String(state.timerScale),
  )
  const notesFontValueEl = document.getElementById('notes-font-value')
  if (notesFontValueEl) notesFontValueEl.textContent = String(state.notesFontSize)
  const scaleValueEl = document.getElementById('timer-scale-value')
  if (scaleValueEl) scaleValueEl.textContent = `${Math.round(state.timerScale * 100)}%`
  if (role === 'operator') {
    document
      .querySelectorAll<HTMLButtonElement>('button.position-btn')
      .forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.pos === state.timerPosition)
      })
  }

  const noteText = state.notes[state.currentSlide] ?? ''
  if (role === 'operator') {
    if (document.activeElement !== notesInput) notesInput.value = noteText
  } else {
    notesReadonly.textContent = noteText
  }

  if (playlistCompactToggle && playlistCompactToggle.checked !== state.playlistCompact) {
    playlistCompactToggle.checked = state.playlistCompact
    playlistList?.classList.toggle('compact', state.playlistCompact)
  }
  if (playlistAutoAdvanceToggle && playlistAutoAdvanceToggle.checked !== state.autoAdvance) {
    playlistAutoAdvanceToggle.checked = state.autoAdvance
  }

  renderPlaylist(state)
  refreshKeyVisualPreview(state).catch(() => undefined)
}

async function projectNew(): Promise<void> {
  const state = getState()
  if (state.playlist.length > 0 || state.keyVisualPath) {
    const ok = window.confirm('Очистить текущий плейлист и начать новый проект?')
    if (!ok) return
  }
  await window.api.project.create()
  showBanner('Новый проект', 2000)
  // Re-enable "Последний" so the user can go back to the previous session
  if (role === 'operator') {
    window.api.session.hasLast().then((has) => {
      $<HTMLButtonElement>('btn-last').disabled = !has
    }).catch(() => undefined)
  }
}

async function projectOpen(): Promise<void> {
  const res = await window.api.project.open()
  if (res.ok && res.path) {
    showBanner(`Открыт: ${baseName(res.path)}`, 3000)
  } else if (!res.ok && res.error) {
    showBanner(`Ошибка: ${res.error}`, 6000)
  }
}

async function projectSave(saveAs: boolean = false): Promise<void> {
  const res = await window.api.project.save(saveAs)
  if (res.ok && res.path) {
    showBanner(`Сохранено: ${baseName(res.path)}`, 3000)
  } else if (!res.ok && res.error) {
    showBanner(`Ошибка сохранения: ${res.error}`, 6000)
  }
}

let prevFilePath: string | null = null
let prevSlide = 0

async function handleStateChange(state: AppState, patch: Partial<AppState> | null): Promise<void> {
  applyState(state)

  if (state.pdfPath && state.pdfPath !== prevFilePath) {
    prevFilePath = state.pdfPath
    lastRenderedSlide = -1
    await loadCurrentFile()
  } else if (state.currentSlide !== prevSlide || patch === null) {
    prevSlide = state.currentSlide
    await renderCurrent()
  }
}

async function openPdf(): Promise<void> {
  const res = await window.api.pdf.openDialog()
  if (!res.ok && !res.cancelled) showBanner(`Не удалось открыть: ${res.error}`)
  if (res.ok && res.sha1Mismatch) showBanner('Заметки в sidecar-файле относятся к другому PDF. Перезаписать их.')
}

function showHelpModal(): void {
  document.getElementById('help-modal')?.classList.remove('hidden')
}

function hideHelpModal(): void {
  document.getElementById('help-modal')?.classList.add('hidden')
}

function showLoModal(): void {
  const modal = document.getElementById('lo-modal')
  modal?.classList.remove('hidden')
}

function hideLoModal(): void {
  const modal = document.getElementById('lo-modal')
  modal?.classList.add('hidden')
}

function showBanner(text: string, ms: number = 4000): void {
  banner.textContent = text
  banner.classList.remove('hidden')
  window.setTimeout(() => banner.classList.add('hidden'), ms)
}

function setupKeyboard(): void {
  if (role !== 'operator') return
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
    // e.code — физическая позиция клавиши, не зависит от языка раскладки
    // PageDown/PageUp/Period — их шлют презентационные кликеры (Logitech R400 и т.п.)
    switch (e.code) {
      case 'ArrowRight':
      case 'Space':
      case 'PageDown':
        e.preventDefault()
        window.api.nav.next()
        break
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        window.api.nav.prev()
        break
      case 'KeyB':
      case 'Period':
        e.preventDefault()
        window.api.blackout.toggle()
        break
      case 'KeyT':
        e.preventDefault()
        if (e.shiftKey) window.api.timer.reset()
        else toggleTimer()
        break
      case 'Digit1':
      case 'Digit3':
      case 'Digit5': {
        const min = e.code === 'Digit1' ? 1 : e.code === 'Digit3' ? 3 : 5
        if (e.shiftKey) {
          e.preventDefault()
          window.api.timer.adjust(min * 60_000)
        } else if (e.ctrlKey) {
          e.preventDefault()
          window.api.timer.adjust(-min * 60_000)
        }
        break
      }
      case 'Slash':
        if (e.shiftKey) { // Shift+/ = ?
          e.preventDefault()
          showHelpModal()
        }
        break
    }
  })
}

function toggleTimer(): void {
  const t = getState().timer
  if (t.running) window.api.timer.pause()
  else window.api.timer.start()
}

function setupOperatorControls(): void {
  if (role !== 'operator') return
  $('nav-prev').addEventListener('click', () => window.api.nav.prev())
  $('nav-next').addEventListener('click', () => window.api.nav.next())
  timerToggle.addEventListener('click', toggleTimer)
  timerReset.addEventListener('click', () => window.api.timer.reset())
  blackoutToggle.addEventListener('click', () => window.api.blackout.toggle())
  $('display-setup').addEventListener('click', openSetup)

  // Duration input — debounced
  let durDebounce: number | null = null
  durationInput!.addEventListener('input', () => {
    if (durDebounce) window.clearTimeout(durDebounce)
    durDebounce = window.setTimeout(() => {
      const minutes = Math.max(0, Math.floor(Number(durationInput!.value) || 0))
      window.api.timer.setDuration(minutes * 60_000)
    }, 400)
  })

  // Presets
  document.querySelectorAll<HTMLButtonElement>('button.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const min = Number(btn.dataset.min ?? 0)
      window.api.timer.setDuration(min * 60_000)
    })
  })

  // Adjustments
  document.querySelectorAll<HTMLButtonElement>('button.adjust').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.delta ?? 0)
      window.api.timer.adjust(delta * 60_000)
    })
  })

  // Mode selector (countdown / stopwatch / clock)
  modeSelect!.addEventListener('change', () => {
    window.api.timer.setMode(modeSelect!.value as TimerMode)
  })

  // Timer scale (speaker overlay size)
  $<HTMLButtonElement>('timer-scale-down').addEventListener('click', () => {
    window.api.timer.setScale(getState().timerScale - 0.1)
  })
  $<HTMLButtonElement>('timer-scale-up').addEventListener('click', () => {
    window.api.timer.setScale(getState().timerScale + 0.1)
  })

  // Position buttons (4 corners for speaker view)
  document.querySelectorAll<HTMLButtonElement>('button.position-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos as TimerPosition | undefined
      if (pos) window.api.timer.setPosition(pos)
    })
  })

  // Notes font size
  const notesFontDown = $<HTMLButtonElement>('notes-font-down')
  const notesFontUp = $<HTMLButtonElement>('notes-font-up')
  notesFontDown.addEventListener('click', () => {
    window.api.note.setFontSize(getState().notesFontSize - 2)
  })
  notesFontUp.addEventListener('click', () => {
    window.api.note.setFontSize(getState().notesFontSize + 2)
  })

  // Playlist add button
  playlistAddBtn!.addEventListener('click', () => {
    window.api.playlist.add()
  })

  // Compact toggle
  playlistCompactToggle!.addEventListener('change', () => {
    const v = playlistCompactToggle!.checked
    playlistList?.classList.toggle('compact', v)
    window.api.playlist.setCompact(v)
  })

  // Auto-advance toggle
  playlistAutoAdvanceToggle!.addEventListener('change', () => {
    window.api.playlist.setAutoAdvance(playlistAutoAdvanceToggle!.checked)
  })

  // LibreOffice notice + install modal
  document.getElementById('lo-install-btn')?.addEventListener('click', showLoModal)
  document.getElementById('lo-modal-close')?.addEventListener('click', hideLoModal)
  document.getElementById('lo-download-btn')?.addEventListener('click', () => {
    window.api.external.open('https://www.libreoffice.org/download/download-libreoffice/')
  })
  document.getElementById('lo-copy-btn')?.addEventListener('click', (e) => {
    navigator.clipboard.writeText('brew install --cask libreoffice').catch(() => undefined)
    const btn = e.currentTarget as HTMLButtonElement
    const prev = btn.textContent
    btn.textContent = '✓'
    window.setTimeout(() => { btn.textContent = prev }, 1500)
  })

  // Key visual
  kvSetBtn!.addEventListener('click', () => {
    window.api.keyvisual.set()
  })
  kvClearBtn!.addEventListener('click', () => {
    window.api.keyvisual.clear()
  })

  // Help button + menu
  $<HTMLButtonElement>('help-btn').addEventListener('click', showHelpModal)
  document.getElementById('help-modal-close')?.addEventListener('click', hideHelpModal)
  window.api.menu.onHelp(() => showHelpModal())

  // Project menu (from macOS menubar)
  window.api.menu.onProjectNew(() => projectNew())
  window.api.menu.onProjectOpen(() => projectOpen())
  window.api.menu.onProjectSave(() => projectSave(false))
  window.api.menu.onProjectSaveAs(() => projectSave(true))

  // Update notification
  const updateBar = $('update-bar')
  const updateText = $('update-text')
  const updateDownload = $<HTMLButtonElement>('update-download')
  const updateDismiss = $<HTMLButtonElement>('update-dismiss')
  let updateUrl: string | null = null

  window.api.update.onAvailable((info) => {
    updateUrl = info.url
    updateText.textContent = `Новая версия ${info.newerVersion} доступна`
    updateBar.classList.remove('hidden')
  })
  updateDownload.addEventListener('click', () => {
    if (updateUrl) window.api.external.open(updateUrl)
  })
  updateDismiss.addEventListener('click', () => {
    updateBar.classList.add('hidden')
  })

  // Notes
  let noteDebounce: number | null = null
  notesInput.addEventListener('input', () => {
    if (noteDebounce) window.clearTimeout(noteDebounce)
    const slide = getState().currentSlide
    const text = notesInput.value
    noteDebounce = window.setTimeout(() => window.api.note.update(slide, text), 300)
  })

  // Session buttons (top-left)
  $<HTMLButtonElement>('btn-new').addEventListener('click', () => projectNew())
  $<HTMLButtonElement>('btn-open').addEventListener('click', () => projectOpen())
  $<HTMLButtonElement>('btn-save').addEventListener('click', () => projectSave(false))
  $<HTMLButtonElement>('btn-last').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('btn-last')
    btn.disabled = true
    const res = await window.api.session.restore()
    if (!res.ok && res.error) showBanner(`Ошибка: ${res.error}`, 6000)
    else if (res.sha1Mismatch) showBanner('Заметки относятся к другому PDF — возможно файл изменился.', 5000)
  })

  window.api.menu.onOpenPdf(openPdf)
  window.api.menu.onOpenDisplaySetup(openSetup)
  window.api.menu.onTopologyChanged(() => {
    showBanner('Раскладка экранов изменилась. Cmd+, для переназначения.')
  })
}

async function openSetup(): Promise<void> {
  const displays = await window.api.displays.list()
  buildSetupModal(displays)
  setupModal.classList.remove('hidden')
}

function buildSetupModal(displays: DisplayInfo[]): void {
  const state = getState()
  const layoutInputs = setupModal.querySelectorAll<HTMLInputElement>('input[name="layout"]')
  const windowedToggle = $<HTMLInputElement>('audience-windowed-toggle')
  windowedToggle.checked = state.audienceWindowed

  layoutInputs.forEach((input) => {
    input.checked = input.value === state.layout
    input.onchange = () => {
      renderRoleMapping(input.value as Layout, displays, state.displayMap)
      updateWindowedSection(input.value as Layout)
    }
  })
  renderRoleMapping(state.layout, displays, state.displayMap)
  updateWindowedSection(state.layout)

  $<HTMLButtonElement>('setup-cancel').onclick = () => setupModal.classList.add('hidden')
  $<HTMLButtonElement>('setup-apply').onclick = async () => {
    const selectedLayout = Array.from(layoutInputs).find((i) => i.checked)?.value as Layout
    const mapping: DisplayMap = {}
    setupModal.querySelectorAll<HTMLSelectElement>('select[data-role]').forEach((sel) => {
      const r = sel.dataset.role as Role
      mapping[r] = Number(sel.value)
    })
    setupModal.classList.add('hidden')
    await window.api.layout.set(selectedLayout, mapping, windowedToggle.checked)
  }
}

function updateWindowedSection(layout: Layout): void {
  const section = document.getElementById('audience-windowed-section')
  if (!section) return
  section.classList.toggle('hidden', layout === 'solo')
}

function renderRoleMapping(layout: Layout, displays: DisplayInfo[], current: DisplayMap): void {
  const roles: Role[] =
    layout === 'solo'
      ? ['operator']
      : layout === 'presenter-audience'
        ? ['operator', 'audience']
        : ['operator', 'speaker', 'audience']

  const labels: Record<Role, string> = {
    operator: 'Operator (я)',
    speaker: 'Speaker (суфлёр)',
    audience: 'Audience (проектор)',
  }

  const container = $('role-mapping')
  container.innerHTML = ''
  for (const r of roles) {
    const row = document.createElement('div')
    row.className = 'row'
    const lbl = document.createElement('label')
    lbl.textContent = labels[r]
    const sel = document.createElement('select')
    sel.dataset.role = r
    for (const d of displays) {
      const opt = document.createElement('option')
      opt.value = String(d.id)
      opt.textContent = `${d.label} — ${d.bounds.width}×${d.bounds.height}`
      if (current[r] === d.id) opt.selected = true
      sel.appendChild(opt)
    }
    row.appendChild(lbl)
    row.appendChild(sel)
    container.appendChild(row)
  }
}

async function bootstrap(): Promise<void> {
  await initBus()
  setupOperatorControls()
  setupKeyboard()

  // Pre-check LibreOffice so the notice shows immediately if needed
  if (role === 'operator') {
    checkSoffice().then((has) => {
      if (!has) updateLibreOfficeNotice(getState())
    }).catch(() => undefined)

    // Enable "Последний" if there is a saved session
    window.api.session.hasLast().then((has) => {
      const btn = $<HTMLButtonElement>('btn-last')
      btn.disabled = !has
    }).catch(() => undefined)
  }

  subscribe((state, patch) => {
    handleStateChange(state, patch).catch((err) => showBanner(`Ошибка: ${err.message}`))
  })

  const initial = getState()
  applyState(initial)
  if (initial.pdfPath) {
    prevFilePath = initial.pdfPath
    await loadCurrentFile()
  }

  startTick(250, () => {
    const s = getState()
    applyTimerView(timerView(s.timer, s.timerMode))
  })

  window.addEventListener('resize', () => {
    const kind = getState().fileKind
    if (kind === 'image' || kind === null) return
    lastRenderedSlide = -1
    renderCurrent().catch(() => undefined)
  })
}

bootstrap().catch((err) => {
  showBanner(`Не удалось запустить: ${err.message}`)
})
