# CueDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Built with Electron](https://img.shields.io/badge/Electron-33-9feaf9?logo=electron&logoColor=black)](https://electronjs.org)
[![Donate](https://img.shields.io/badge/%E2%98%95_%D0%9F%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%B0%D1%82%D1%8C-CloudTips-ff8c00)](https://pay.cloudtips.ru/p/b79fa042)

**CueDeck — инструмент оператора презентаций на живых мероприятиях.**

Собираешь плейлист всех спикеров заранее, в любом формате, и ведёшь мероприятие с одного рабочего места: персональные таймеры, заметки на суфлёр в реальном времени, заставка для зала, три независимых окна (оператор / суфлёр / аудитория).

[🇷🇺 Читать на русском](#-русский) · [🇬🇧 Read in English](#-english) · [📋 Что нового](CHANGELOG.md)

---

## 🇷🇺 Русский

### ⬇️ Скачать

Последняя версия: **[GitHub Releases →](https://github.com/ttpa3dhuk/CueDeck/releases/latest)**, история версий — [CHANGELOG.md](CHANGELOG.md).

🎥 [Видеообзор всех возможностей (40 мин) →](https://www.youtube.com/watch?v=Vi5BDG_WoRg)

| Платформа | Файл |
|-----------|------|
| macOS Apple Silicon (M1–M4) | `CueDeck-<version>-Silicon-mac.zip` |
| macOS Intel | `CueDeck-<version>-Intel-mac.zip` |
| Windows 10/11 (x64) | `CueDeck-<version>-win.zip` |

### 🛠 Установка

**macOS:** распакуй ZIP, перетащи `CueDeck.app` в Applications. Первый запуск — правый клик → `Open` → `Open` (двойной клик блокируется, приложение без code signing). Если пишет «приложение повреждено» — сними карантин: `xattr -cr "/Applications/CueDeck.app"`.

**Windows:** распакуй ZIP, запусти `CueDeck.exe`. SmartScreen предупредит → `More info` → `Run anyway`.

### 📄 Форматы

PDF и картинки (PNG/JPG/WebP/GIF/BMP) открываются сразу. **PPTX/PPT/ODP/Keynote** конвертируются в PDF через LibreOffice ([brew install --cask libreoffice](https://www.libreoffice.org/download/download-libreoffice/) / установщик для Windows) — разово, с кешированием. Видео внутри слайда и анимации «по клику» воспроизводятся (v0.4+); редактирование слайдов недоступно, эффекты исчезновения/переходы не играют.

**Видео** — играет движком Chromium, поэтому важен кодек, не контейнер:

| Кодек | Статус |
|---|---|
| H.264/AVC + AAC (MP4, M4V, MOV) | ✅ рекомендуется, играет везде |
| VP8/VP9 (WebM) | ✅ работает |
| HEVC/H.265 | ⚠️ Mac обычно да, Windows — нужны платные HEVC Video Extensions |
| ProRes, DNxHD | ❌ не поддерживается нигде |

Правило: гони в **MP4 (H.264 + AAC)**. ProRes/HEVC — перекодируй в [HandBrake](https://handbrake.fr/) (пресет «Fast 1080p30»).

**Захват (живой вход)** — видит устройства класса UVC (та же техника, что у Zoom): AVMatrix, Elgato Cam Link, ATEM Mini/Web Presenter, обычная веб-камера — работают. Blackmagic DeckLink/UltraStudio — нет (свой драйвер, в списке камер не появляются). Проверка: если устройство видно в Photo Booth — CueDeck его возьмёт.

### ✨ Возможности

- 🎛 **Preview/Program** — эфирная модель как на видеопультах: превью (зелёная рамка) готовишь незаметно, **TAKE** (`Tab`) выдаёт в эфир (красная рамка). Эфир не рвётся, пока листаешь следующий файл
- 🎚 Раскладка в стиле OBS Studio Mode — превью и эфир рядом, таймер и TAKE снизу, высота панели тянется мышью
- 🖱 **Глобальный кликер** — PgUp/PgDn листают эфир, даже когда CueDeck не в фокусе; отдельная галка для кликеров, шлющих стрелки (Logitech Spotlight)
- 🪟 Диалог выбора раскладки (1/2/3 экрана) при каждом запуске — отключаемый
- 🔢 Быстрая навигация по номеру слайда, подсказка «Далее: `<имя>`» в шапке
- 📋 **Плейлист спикеров** — drag-and-drop сборка, своё название на запись, one-click переключение
- ⏱ **Таймер** — обратный отсчёт (с пресетами и коррекцией на лету), секундомер, текущее время; тиканье/гонг, режим повтора, позиция и масштаб на суфлёре (или скрыть совсем)
- 🖥 Три независимых окна — оператор, суфлёр (текущий слайд + таймер + заметки), аудитория (только слайд)
- 🎞 Видео внутри PPTX-слайдов — играет на своём месте, синхронно во всех окнах
- ✨ Анимации PowerPoint «по клику» — разворачиваются в шаги, листаются кликером как в оригинале
- 🎬 **Видео в плейлисте** — play/pause, перемотка, звук синхронизированы между окнами; таймкод и обратный отсчёт до конца в шапке
- 📹 **Захват — чужой ноутбук на экране зала** — HDMI через USB-капчер встаёт в плейлист наравне с презентациями; три режима вписывания под гостевые 4:3/16:10
- 🎧 **Предпрослушка (SOLO)** — слушаешь принесённый ролик или захват в наушниках, пока в зале идёт другое
- 📊 Индикаторы уровня звука под превью и эфиром
- 🔊 Выбор аудиовыхода — куда отдавать звук эфира (звуковая карта, HDMI на vMix, NDI и т.п.), отдельно для предпрослушки
- 📝 **Заметки оператора → суфлёр** — текст появляется на экране суфлёра мгновенно
- 💬 Флэш-сообщение спикеру — готовые пресеты или свой текст, крупно и мигает
- ⬛ **Blackout/Key Visual** (`B`) — зал видит заставку или чёрный фон, звук глушится, слайды листаются незаметно для зала
- ⌨️ Настраиваемые горячие клавиши
- 🖼 **Списки** — пачка фото/роликов одной строкой плейлиста: по кругу / вперемешку / один проход, с наплывом
- 🔁 Цикл ролика — у каждой записи свой (видео-заставка крутится, пока спикер на сцене)
- ⏸ Стоп на первом кадре — ролик уходит замороженным, запускает спикер кликером
- 🎞 Анимированная заставка при блэкауте (видео вместо картинки)
- 🛡 Подтверждение при закрытии посреди эфира
- 📁 **Материалы не теряются при переезде** — проект хранит пути относительно себя; пропажа видна при открытии, «Найти в папке…» чинит разом, «Собрать проект в папку…» — для переноса на флешке
- 💾 Проекты `.pdpres`, авто-обновления раз в сутки

### ⌨️ Горячие клавиши

> Переназначаются в редакторе «Клавиши…». Ниже — значения по умолчанию.

| Клавиша | Действие |
|---------|----------|
| `Tab` | **TAKE** — выдать превью в эфир |
| `[` / `]` | Превью: предыдущий / следующий слайд |
| `←` / `→` | Эфир: предыдущий / следующий слайд |
| `Space` | Эфир: следующий слайд / play-pause видео |
| `PgUp` / `PgDn` | Эфир: предыдущий / следующий (кликер) |
| `B` / `.` | Blackout |
| `T` | Старт / пауза таймера |
| `R` / `Shift+T` | Сбросить таймер |
| `Cmd+O` / `Cmd+N` / `Cmd+Shift+O` / `Cmd+S` | Открыть файл / новый проект / открыть проект / сохранить |
| `Cmd+,` | Настройка экранов |

### 🖥 Раскладки экранов

| Экранов | Окна |
|---|---|
| 1 | Оператор (подготовка) |
| 2 | Оператор + аудитория |
| 3 | Оператор + суфлёр + аудитория |

Определяется автоматически по числу дисплеев, смена — `Cmd+,`.

### 🔧 Сборка из исходников

```bash
git clone https://github.com/ttpa3dhuk/CueDeck.git
cd CueDeck
npm install
npm run dev           # dev-режим с HMR
npm run package:mac   # .zip для Mac (Silicon + Intel)
npm run package:win   # .zip для Windows
```

### ☕ Поддержать проект

CueDeck бесплатен и делается в свободное время. Если он выручил на шоу — можно закинуть на кофе: **[☕ CloudTips →](https://pay.cloudtips.ru/p/b79fa042)**

---

## 🇬🇧 English

### 💡 Why

Every event has the same problem: each speaker brings a different format — PDF, PPTX, images. You need to switch fast, run individual timers, and keep notes visible to you, not the audience. PowerPoint Presenter View only works with `.pptx`; PDF readers have no timer, no notes. CueDeck fills the gap — build a speaker playlist in advance, then operate the whole day in one tool.

### ⬇️ Download

Latest release: **[GitHub Releases →](https://github.com/ttpa3dhuk/CueDeck/releases/latest)**, version history — [CHANGELOG.md](CHANGELOG.md).

🎥 [Feature walkthrough video, 40 min (Russian) →](https://www.youtube.com/watch?v=Vi5BDG_WoRg)

| Platform | File |
|----------|------|
| macOS Apple Silicon (M1–M4) | `CueDeck-<version>-Silicon-mac.zip` |
| macOS Intel | `CueDeck-<version>-Intel-mac.zip` |
| Windows 10/11 (x64) | `CueDeck-<version>-win.zip` |

### 🛠 Installation

**macOS:** unzip, drag `CueDeck.app` to Applications. First launch — right-click → `Open` → `Open` (unsigned app, blocked on double-click). "App is damaged"? Remove quarantine: `xattr -cr "/Applications/CueDeck.app"`.

**Windows:** unzip, run `CueDeck.exe`. SmartScreen will warn → `More info` → `Run anyway`.

### 📄 File formats

PDF and images (PNG/JPG/WebP/GIF/BMP) open immediately. **PPTX/PPT/ODP/Keynote** are converted to PDF via LibreOffice ([brew install --cask libreoffice](https://www.libreoffice.org/download/download-libreoffice/) / Windows installer) — once, then cached. Embedded video and on-click animations play (v0.4+); slide editing isn't available, exit effects/transitions don't play.

**Video** plays through the Chromium engine, so the codec matters, not the container:

| Codec | Status |
|---|---|
| H.264/AVC + AAC (MP4, M4V, MOV) | ✅ recommended, plays everywhere |
| VP8/VP9 (WebM) | ✅ works |
| HEVC/H.265 | ⚠️ Mac usually yes, Windows needs paid HEVC Video Extensions |
| ProRes, DNxHD | ❌ not supported anywhere |

Rule of thumb: export to **MP4 (H.264 + AAC)**. Transcode ProRes/HEVC with [HandBrake](https://handbrake.fr/) ("Fast 1080p30").

**Live input (capture)** — sees UVC-class devices (same tech as Zoom): AVMatrix, Elgato Cam Link, ATEM Mini/Web Presenter, regular webcams — work. Blackmagic DeckLink/UltraStudio — no (own driver, never show up as a camera). Check: if it shows in Photo Booth, CueDeck will see it.

### ✨ Features

- 🎛 **Preview/Program** — a video-switcher model: stage the preview (green frame) off-air, **TAKE** (`Tab`) sends it live (red frame). The program feed never breaks while you cue the next file
- 🎚 OBS Studio-Mode layout — preview and program side by side, timer + TAKE below, drag-resizable
- 🖱 **Global clicker** — PgUp/PgDn flip the program deck even when CueDeck isn't focused; extra toggle for clickers that send arrow keys (Logitech Spotlight)
- 🪟 Layout prompt (1/2/3 screens) on every launch — can be disabled
- 🔢 Jump to a slide by number, "Next: `<name>`" indicator in the header
- 📋 **Speaker playlist** — drag-and-drop reordering, custom label per entry, one-click switching
- ⏱ **Timer** — countdown (presets + on-the-fly adjustment), stopwatch, clock; tick/gong sounds, loop mode, position and scale on the confidence monitor (or hide it)
- 🖥 Three independent windows — operator, speaker (slide + timer + notes), audience (slide only)
- 🎞 Video inside PPTX slides — plays in place, in sync across all windows
- ✨ On-click PowerPoint animations — expand into steps, walked through with the clicker
- 🎬 **Playlist video** — play/pause, seek, audio in sync across windows; time-code and countdown to end in the header
- 📹 **Live input — a guest laptop on the hall screen** — HDMI through a USB capture device joins the playlist like any presentation; three fit modes for 4:3/16:10 guests
- 🎧 **Cue/SOLO monitoring** — audition an incoming clip or capture in headphones while something else is on air
- 📊 Audio level meters under preview and program
- 🔊 Audio output selection — where program sound goes (sound card, HDMI to vMix, NDI, etc.), separate for cue monitoring
- 📝 **Operator notes → confidence monitor** — text appears on the speaker's screen instantly
- 💬 Flash message to the speaker — presets or custom text, large and blinking
- ⬛ **Blackout/Key Visual** (`B`) — audience sees a still or black screen, audio muted, slides change unseen
- ⌨️ Customizable hotkeys
- 🖼 **Lists** — a batch of photos/clips as one playlist row: loop / shuffle / single pass, with crossfade
- 🔁 Per-clip loop (an idents clip loops while the speaker is on stage)
- ⏸ Hold on first frame — clip goes on air frozen, speaker starts it with the clicker
- 🎞 Animated key visual during blackout
- 🛡 Quit confirmation mid-show
- 📁 **Materials survive a move** — paths stored relative to the project; missing files show up on open, "Locate file…" fixes all at once, "Collect project into folder…" for USB-drive moves
- 💾 `.pdpres` projects, daily auto-update check

### ⌨️ Keyboard Shortcuts

> Remappable in the "Keys…" editor. Defaults below.

| Key | Action |
|-----|--------|
| `Tab` | **TAKE** — send preview to air |
| `[` / `]` | Preview: previous / next slide |
| `←` / `→` | Program: previous / next slide |
| `Space` | Program: next slide / video play-pause |
| `PgUp` / `PgDn` | Program: previous / next (clicker) |
| `B` / `.` | Toggle blackout |
| `T` | Start / pause timer |
| `R` / `Shift+T` | Reset timer |
| `Cmd+O` / `Cmd+N` / `Cmd+Shift+O` / `Cmd+S` | Open file / new project / open project / save |
| `Cmd+,` | Screen settings |

### 🖥 Screen Layouts

| Displays | Windows |
|---|---|
| 1 | Operator only |
| 2 | Operator + audience |
| 3 | Operator + speaker + audience |

Detected automatically from connected displays, override with `Cmd+,`.

### ☕ Support the project

CueDeck is free and built in spare time. If it saved your show: **[☕ Donate via CloudTips →](https://pay.cloudtips.ru/p/b79fa042)**

---

## 📄 License

[MIT](LICENSE) © 2026 [Azat Khusaenov](https://github.com/ttpa3dhuk)
