# CueDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Built with Electron](https://img.shields.io/badge/Electron-33-9feaf9?logo=electron&logoColor=black)](https://electronjs.org)

**CueDeck — инструмент оператора презентаций на живых мероприятиях.**  

Собираешь лист всех спикеров заранее в не зависимости от формата, ведёшь мероприятие с одного рабочего места: персональные таймеры , заметки на суфлёр в реальном времени, персональная заглушка для аудитории, три независимых окна (оператор / суфлёр / аудитория).

[🇷🇺 Читать на русском](#-русский) · [🇬🇧 Read in English](#-english)

---

### ⬇️ Скачать

Последняя версия: **[GitHub Releases →](https://github.com/ttpa3dhuk/CueDeck/releases/latest)**

| Платформа | Файл |
|-----------|------|
| macOS Apple Silicon (M1–M4) | `CueDeck-<version>-Silicon-mac.zip` |
| macOS Intel | `CueDeck-<version>-Intel-mac.zip` |
| Windows 10/11 (x64) | `CueDeck-<version>-win.zip` |

---

### 🛠 Установка

#### macOS

1. Распакуй ZIP, перетащи `CueDeck.app` в Applications.
2. **Первый запуск:** правый клик → `Open` → `Open` в диалоге.  
   *(При двойном клике macOS блокирует приложения без code signing — это норма для beta.)*
3. Дальше открывается двойным кликом как обычно.

**Если macOS пишет «приложение повреждено»** — это Gatekeeper-карантин. Сними его в терминале:
```bash
xattr -cr "/Applications/CueDeck.app"
```

#### Windows

1. Распакуй ZIP в любую папку (например, `C:\Program Files\CueDeck\`).
2. Запусти `CueDeck.exe`.
3. SmartScreen предупредит → `More info` → `Run anyway`.

#### PPTX-поддержка

PPTX, PPT, ODP и Keynote **конвертируются в PDF** при открытии через LibreOffice. Это одноразовая операция — результат кешируется, повторно конвертировать не нужно.

> ⚠️ **Важно понимать:**
> - Файл конвертируется в PDF — **редактирование слайдов недоступно**
> - **Анимации и переходы не воспроизводятся** — каждый анимированный шаг фиксируется как отдельный статичный слайд (если LibreOffice его развернул) или теряется
> - Внешний вид слайдов может незначительно отличаться от оригинала — особенно нестандартные шрифты и сложные эффекты
>
> CueDeck — инструмент для **показа готовых материалов**, не для редактирования презентаций.

Для конвертации нужен **LibreOffice** (бесплатно):

- **Mac:** `brew install --cask libreoffice` или [libreoffice.org](https://www.libreoffice.org/download/download-libreoffice/)
- **Windows:** установщик с [libreoffice.org](https://www.libreoffice.org/download/download-libreoffice/)

PDF и картинки работают сразу, без зависимостей.

#### Видео — поддерживаемые кодеки

Важно: формат файла (**контейнер**) и **кодек** внутри — разные вещи. CueDeck проигрывает видео движком Chromium, поэтому важен именно кодек.

| | Контейнер | Видео-кодек | Аудио-кодек | Где работает |
|---|---|---|---|---|
| ✅ **Рекомендуется** | MP4 / M4V | **H.264 (AVC)** | **AAC**, MP3 | macOS и Windows |
| ✅ Работает | WebM | **VP8 / VP9** | Opus, Vorbis | macOS и Windows |
| ✅ Работает | MOV | H.264 | AAC | macOS и Windows |
| ⚠️ Не гарантируется | MP4 / MOV | **HEVC (H.265)** | AAC | macOS — обычно да (аппаратный декодер); Windows — нужно платное «HEVC Video Extensions» из Microsoft Store |
| ❌ Не поддерживается | MOV | **ProRes**, DNxHD и др. монтажные | — | нигде (Chromium их не декодирует) |

**Короткое правило:** гони видео в **MP4 (H.264 + AAC)** — играет у всех и всегда. Если прилетел ProRes-мастер с монтажа или HEVC — перекодируй бесплатным [HandBrake](https://handbrake.fr/) (пресет «Fast 1080p30»). Если файл не открывается — CueDeck покажет подсказку.

---

### ✨ Возможности

- 📋 **Плейлист спикеров** — собираешь всю программу мероприятия заранее, drag-and-drop сортировка,
- ⏱ **Таймер — три режима:**
  - **Обратный отсчёт** — задаёшь длительность на спикера, готовые пресеты, возможность добавлять и убавлять время в реальном времени
  - **Секундомер** — если необходимо засечь время
  - **Текущее время** — часы в реальном времени
- 🔢 **Пресеты и коррекция на ходу** — быстрый выбор длительности из пресетов; прямо во время выступления можно добавить или убрать время без остановки
- 📍 **Позиция и масштаб таймера** — выбираешь угол экрана суфлёра (четыре варианта), регулируешь размер
- 🖥 **Три независимых окна** — оператор (твой ноут), суфлёр клиента (Экран на сцену), аудитория (Экран зрителей)
- 📄 **Форматы** — PDF, PPTX, PPT, ODP, Keynote, PNG/JPG/WebP/GIF/BMP, видео MP4/MOV/M4V/WebM
- 🎬 **Видео** — ролики между выступлениями прямо в плейлисте. Play/pause, перемотка и звук синхронизированы между окном оператора и залом; звук идёт только на основной выход. В шапке — таймкод и крупный обратный отсчёт до конца ролика (оранжевый за 30с, красный за 10с). Управление: `Space` — play/pause, `←/→` — ±5с, `M` — звук
- 🔊 **Выбор аудиовыхода** — кнопка «Аудиовыход…» открывает меню, где задаёшь, на какое устройство отдавать звук видео: звуковая карта, миниджек ноута, HDMI на vMix-машину, NDI и т.п. Выбор запоминается
- 📝 **Заметки оператора → суфлёр** — пишешь текст в окне оператора, он мгновенно появляется на экране суфлёра. Прямой канал связи со спикером без слов
- ⬛ **Blackout / Key Visual** — нажал `B`: аудитория видит заставку (если загружена) или чёрный фон. Переключаешь слайды — аудитория ничего не видит
- 💾 **Проекты** — сохраняй настроенный плейлист как `.pdpres`, открывай перед следующим мероприятием
- 🔔 **Авто-обновления** — раз в сутки проверяет новую версию на GitHub

---

### ⌨️ Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `←` / `→` | Предыдущий / следующий слайд |
| `Space` | Следующий слайд |
| `PgUp` / `PgDn` | Предыдущий / следующий слайд (кнопки кликера) |
| `B` / `.` | Blackout (`.` — blank-кнопка кликера) |
| `T` | Старт / пауза таймера |
| `Shift+T` | Сбросить таймер |
| `Cmd+O` | Открыть PDF / PPTX |
| `Cmd+N` | Новый проект |
| `Cmd+Shift+O` | Открыть проект |
| `Cmd+S` | Сохранить проект |
| `Cmd+,` | Настройка экранов |

---

### 🖥 Раскладки экранов

| Конфигурация | Окна |
|--------------|------|
| 1 экран | Оператор (подготовка / прогон) |
| 2 экрана (ноут + Экран зрителей) | Оператор + аудитория |
| 3 экрана (+ Экран на сцену) | Оператор + суфлёр + аудитория |

Раскладка определяется автоматически по числу подключённых дисплеев. Поменять — `Cmd+,`.

**Что видит каждое окно:**
- **Оператор** — полный интерфейс: плейлист, слайды, таймер, управление, заметки
- **Суфлёр** — текущий слайд + крупный таймер в выбранном углу + заметки от оператора (мгновенно)
- **Аудитория** — только слайд, без служебной информации. При блэкауте: Key Visual или чёрный фон

---

### 🔧 Сборка из исходников

```bash
git clone https://github.com/ttpa3dhuk/CueDeck.git
cd CueDeck
npm install
npm run dev           # dev-режим с HMR
npm run package:mac   # сборка .zip для Mac (Silicon + Intel)
npm run package:win   # сборка .zip для Windows
```

---

## 🇬🇧 English

### 💡 Why

Every event has the same problem: each speaker brings a different format — PDF, PPTX, images. You need to switch fast, run individual timers, and keep notes visible to you — not the audience. PowerPoint Presenter View only works with `.pptx`. PDF readers have no timer, no notes.

CueDeck fills the gap. Build a speaker playlist in advance, run it — and operate the whole day in one tool.

---

### ⬇️ Download

Latest release: **[GitHub Releases →](https://github.com/ttpa3dhuk/CueDeck/releases/latest)**

| Platform | File |
|----------|------|
| macOS Apple Silicon (M1–M4) | `CueDeck-<version>-Silicon-mac.zip` |
| macOS Intel | `CueDeck-<version>-Intel-mac.zip` |
| Windows 10/11 (x64) | `CueDeck-<version>-win.zip` |

---

### 🛠 Installation

#### macOS

1. Unzip the archive, drag `CueDeck.app` to Applications.
2. **First launch:** right-click → `Open` → `Open` in the dialog.  
   *(macOS blocks unsigned apps on double-click — expected for beta.)*
3. After that, double-click works as normal.

**If macOS says "app is damaged"** — that's Gatekeeper quarantine. Remove it in Terminal:
```bash
xattr -cr "/Applications/CueDeck.app"
```

#### Windows

1. Unzip to any folder (e.g. `C:\Program Files\CueDeck\`).
2. Run `CueDeck.exe`.
3. SmartScreen will warn you → `More info` → `Run anyway`.

#### PPTX support

PPTX, PPT, ODP and Keynote files are **converted to PDF** on open via LibreOffice. This is a one-time operation — the result is cached, no re-conversion on subsequent opens.

> ⚠️ **Important limitations:**
> - The file is converted to PDF — **slide editing is not available**
> - **Animations and transitions are not played** — each animated step is either rendered as a separate static slide (if LibreOffice expanded it) or lost entirely
> - Slide appearance may differ slightly from the original — especially custom fonts and complex effects
>
> CueDeck is a tool for **presenting finished materials**, not editing presentations.

Converting PowerPoint files requires **LibreOffice** (free):

- **Mac:** `brew install --cask libreoffice` or [libreoffice.org](https://www.libreoffice.org/download/download-libreoffice/)
- **Windows:** installer from [libreoffice.org](https://www.libreoffice.org/download/download-libreoffice/)

PDF and image files work immediately without any dependencies.

#### Video — supported codecs

Note: the file format (**container**) and the **codec** inside it are different things. CueDeck plays video through the Chromium engine, so the codec is what matters.

| | Container | Video codec | Audio codec | Where it works |
|---|---|---|---|---|
| ✅ **Recommended** | MP4 / M4V | **H.264 (AVC)** | **AAC**, MP3 | macOS & Windows |
| ✅ Works | WebM | **VP8 / VP9** | Opus, Vorbis | macOS & Windows |
| ✅ Works | MOV | H.264 | AAC | macOS & Windows |
| ⚠️ Not guaranteed | MP4 / MOV | **HEVC (H.265)** | AAC | macOS — usually yes (hardware decoder); Windows — needs the paid "HEVC Video Extensions" from the Microsoft Store |
| ❌ Not supported | MOV | **ProRes**, DNxHD, other edit codecs | — | nowhere (Chromium can't decode them) |

**Rule of thumb:** export to **MP4 (H.264 + AAC)** — it plays everywhere, every time. If you get a ProRes master or HEVC, transcode it with the free [HandBrake](https://handbrake.fr/) ("Fast 1080p30" preset). If a file won't open, CueDeck shows a hint.

---

### ✨ Features

- 📋 **Speaker playlist** — build the full event program in advance, drag-and-drop reordering, one-click switching
- ⏱ **Timer — three modes:**
  - **Countdown** — set a duration per speaker, color shifts green → yellow → red
  - **Stopwatch** — counts up from zero
  - **Clock** — live current time display
- 🔢 **Presets & on-the-fly adjustment** — pick duration from presets; add or subtract time mid-presentation without stopping the timer
- 📍 **Timer position & scale** — choose which corner of the confidence monitor to display the timer (four options), adjust size
- 🖥 **Three independent windows** — operator (your laptop), confidence monitor (external display), audience (projector)
- 📄 **File formats** — PDF, PPTX, PPT, ODP, Keynote, PNG/JPG/WebP/GIF/BMP, video MP4/MOV/M4V/WebM
- 🎬 **Video** — play clips between talks straight from the playlist. Play/pause, seek and audio stay in sync between the operator and the audience; sound goes to the main output only. The header shows the time-code and a large countdown to the end of the clip (orange at 30s, red at 10s). Controls: `Space` play/pause, `←/→` ±5s, `M` mute
- 🔊 **Audio output selection** — the "Audio output…" button opens a menu to pick which device the video sound goes to: sound card, laptop minijack, HDMI to a vMix machine, NDI, etc. The choice is remembered
- 📝 **Operator notes → confidence monitor** — type in the operator window, text appears instantly on the speaker's screen. Silent communication channel during the presentation
- ⬛ **Blackout / Key Visual** — press `B`: audience sees your Key Visual image (if loaded) or a black screen. Switch slides freely — the audience sees nothing
- 💾 **Projects** — save your configured playlist as `.pdpres`, reopen before the next event
- 🔔 **Auto-update check** — checks GitHub once a day for a new version

---

### ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next slide |
| `Space` | Next slide |
| `PgUp` / `PgDn` | Previous / next slide (presenter clicker buttons) |
| `B` / `.` | Toggle blackout (`.` — clicker blank button) |
| `T` | Start / pause timer |
| `Shift+T` | Reset timer |
| `Shift+1` / `Shift+3` / `Shift+5` | Add 1 / 3 / 5 min to timer |
| `Ctrl+1` / `Ctrl+3` / `Ctrl+5` | Subtract 1 / 3 / 5 min from timer |
| `Shift+/` | Show keyboard shortcuts |
| `Cmd+O` | Open PDF / PPTX / image |
| `Cmd+N` | New project |
| `Cmd+Shift+O` | Open project |
| `Cmd+S` | Save project |
| `Cmd+Shift+S` | Save project as… |
| `Cmd+,` | Screen settings |

---

### 🖥 Screen Layouts

| Configuration | Windows |
|---------------|---------|
| 1 display | Operator only (prep / rehearsal) |
| 2 displays (laptop + projector) | Operator + audience |
| 3 displays (+ confidence monitor) | Operator + speaker + audience |

Layout is detected automatically based on connected displays. Override via `Cmd+,`.

**What each window shows:**
- **Operator** — full interface: playlist, slides, timer controls, notes editor
- **Confidence monitor (speaker)** — current slide + large timer in the chosen corner + operator notes (instant)
- **Audience** — slide only, no operator UI. During blackout: Key Visual image or black screen

---

## 📄 License

[MIT](LICENSE) © 2026 [Azat Khusaenov](https://github.com/ttpa3dhuk)
