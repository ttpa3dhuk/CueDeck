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

- 🎛 **Preview / Program — эфирная модель, как на видеопультах** — два независимых деска: **PROGRAM** (красная рамка) видит зал, **PREVIEW** (зелёная рамка) ты готовишь незаметно. Клик по спикеру грузит файл в превью, а не в зал; кнопка **TAKE** (`Tab`) выдаёт его в эфир. Эфир больше не рвётся, пока ищешь и листаешь следующий файл. На Take дески меняются местами, для видео — выбор «играть с начала / с точки превью»
- 🎚 **Раскладка в стиле OBS Studio Mode** — превью и эфир рядом, под ними заметки, крупный таймер и большая кнопка TAKE; высоту нижней панели можно тянуть мышью
- 🖱 **Глобальный кликер** — галка «🌐 Глобально»: PgUp/PgDn листают эфир, даже когда CueDeck не в фокусе — спикер продолжает кликать, пока ты качаешь следующую презентацию в браузере. Для кликеров, шлющих стрелки (Logitech Spotlight), — дополнительная галка «⬅➡ Стрелки»
- 🪟 **Выбор режима при запуске** — диалог «В каком режиме работаем?» (1/2/3 экрана) при каждом старте, чтобы раскладка не восстанавливалась вслепую; отключается чекбоксом, возвращается в «Настройке экранов»
- 🔢 **Быстрая навигация** — впиши номер слайда + Enter — сразу там (отдельно в эфире и в превью); «Далее: `<имя>`» в шапке подсказывает оператору и суфлёру, кто следующий по плейлисту
- 📋 **Плейлист спикеров** — собираешь всю программу мероприятия заранее: drag-and-drop сортировка или просто перетащи файлы из Finder прямо в окно, своё наименование для каждой записи (✎), one-click переключение
- ⏱ **Таймер — три режима:**
  - **Обратный отсчёт** — задаёшь длительность на спикера (минуты и секунды), готовые пресеты, возможность добавлять и убавлять время в реальном времени
  - **Секундомер** — если необходимо засечь время
  - **Текущее время** — часы в реальном времени
- 🔢 **Пресеты и коррекция на ходу** — быстрый выбор длительности из пресетов; прямо во время выступления можно добавить или убрать время без остановки
- 🔔 **Звуковые сигналы таймера** — тиканье последние 10 секунд и/или гонг на нуле (галки независимые, по умолчанию выключены), режим **🔁 Повтор** — отсчёт перезапускается сам по кругу (15/30-секундные раунды и т.п.); на суфлёре в конце всегда вспышка экрана
- 📍 **Позиция и масштаб таймера** — выбираешь угол экрана суфлёра (четыре варианта), регулируешь размер — или выключаешь таймер на суфлёре совсем (кнопка «✕»), если суфлёрский сигнал идёт через vMix и режиссёр накладывает свой таймер
- 🖥 **Три независимых окна** — оператор (твой ноут), суфлёр клиента (Экран на сцену), аудитория (Экран зрителей)
- 📄 **Форматы** — PDF, PPTX, PPT, ODP, Keynote, PNG/JPG/WebP/GIF/BMP, видео MP4/MOV/M4V/WebM
- 🎬 **Видео** — ролики между выступлениями прямо в плейлисте. Play/pause, перемотка и звук синхронизированы между окном оператора и залом; звук идёт только на основной выход. В шапке — таймкод и крупный обратный отсчёт до конца ролика (оранжевый за 30с, красный за 10с). Управление: `Space` — play/pause, `←/→` — ±5с, `M` — звук
- 🔊 **Выбор аудиовыхода** — кнопка «Аудиовыход…» открывает меню, где задаёшь, на какое устройство отдавать звук видео: звуковая карта, миниджек ноута, HDMI на vMix-машину, NDI и т.п. Выбор запоминается
- 📝 **Заметки оператора → суфлёр** — пишешь текст в окне оператора, он мгновенно появляется на экране суфлёра. Прямой канал связи со спикером без слов
- 💬 **Сообщение спикеру** — флэш-сообщение на суфлёр: готовые пресеты («Заканчивайте», «Ближе к микрофону», «Финальный слайд») или свой текст, крупно и мигает, пока не снимешь. Тексты пресетов меняются под себя правым кликом
- ⬛ **Blackout / Key Visual** — нажал `B`: аудитория видит заставку (если загружена) или чёрный фон, звук видео тоже глушится. Переключаешь слайды — аудитория ничего не видит
- ⌨️ **Настраиваемые горячие клавиши** — кнопка «Клавиши…» открывает редактор: переназначь любое действие под себя (например, TAKE на `Tab`)
- 💾 **Проекты** — сохраняй настроенный плейлист как `.pdpres`, открывай перед следующим мероприятием
- 🔔 **Авто-обновления** — раз в сутки проверяет новую версию на GitHub

---

### ⌨️ Горячие клавиши

> Клавиши действий можно переназначить в редакторе «Клавиши…» (кнопка внизу). Ниже — значения по умолчанию.

| Клавиша | Действие |
|---------|----------|
| `Tab` | **TAKE** — выдать превью в эфир |
| `[` / `]` | Превью: предыдущий / следующий слайд |
| `←` / `→` | Эфир: предыдущий / следующий слайд |
| `Space` | Эфир: следующий слайд / play-pause видео |
| `PgUp` / `PgDn` | Эфир: предыдущий / следующий (кнопки кликера) |
| `B` / `.` | Blackout (`.` — blank-кнопка кликера) |
| `T` | Старт / пауза таймера |
| `R` / `Shift+T` | Сбросить таймер |
| `Cmd+O` | Открыть файл (в превью) |
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

- 🎛 **Preview / Program — a video-switcher model** — two independent decks: **PROGRAM** (red frame) is what the audience sees, **PREVIEW** (green frame) is staged off-air. Clicking a speaker loads the file into preview, not on air; the **TAKE** button (`Tab`) sends it live. The audience feed no longer breaks while you cue the next file. Take swaps the decks; for video you choose "play from start / from the preview point"
- 🎚 **OBS Studio-Mode layout** — preview and program side by side, notes + large timer + big TAKE below; the bottom bar height is drag-resizable
- 🖱 **Global clicker** — the "🌐 Global" toggle makes PgUp/PgDn flip the program deck even when CueDeck is not focused — the speaker keeps clicking while you download the next deck in a browser. For clickers that send arrow keys (Logitech Spotlight) there is an extra "⬅➡ Arrows" toggle
- 🪟 **Layout prompt on launch** — a "Which mode are we in?" dialog (1/2/3 screens) on every start, so a multi-screen layout is never restored blindly; opt out via the checkbox, re-enable in Display Setup
- 🔢 **Quick navigation** — type a slide number + Enter to jump straight there (separately for program and preview); a "Next: `<name>`" indicator in the header tells the operator and speaker who's up next in the playlist
- 📋 **Speaker playlist** — build the full event program in advance: drag-and-drop reordering, or just drop files from Finder straight into the window; custom label per entry (✎), one-click switching
- ⏱ **Timer — three modes:**
  - **Countdown** — set a duration per speaker (minutes and seconds), color shifts green → yellow → red
  - **Stopwatch** — counts up from zero
  - **Clock** — live current time display
- 🔢 **Presets & on-the-fly adjustment** — pick duration from presets; add or subtract time mid-presentation without stopping the timer
- 🔔 **Timer sound cues** — ticking in the last 10 seconds and/or a gong at zero (independent toggles, off by default), plus a **🔁 Loop** mode that restarts the countdown automatically (15/30-second rounds etc.); the speaker screen always flashes at the end
- 📍 **Timer position & scale** — choose which corner of the confidence monitor to display the timer (four options), adjust size — or hide the timer on the confidence monitor entirely ("✕") when the feed goes through vMix and the show caller overlays their own timer
- 🖥 **Three independent windows** — operator (your laptop), confidence monitor (external display), audience (projector)
- 📄 **File formats** — PDF, PPTX, PPT, ODP, Keynote, PNG/JPG/WebP/GIF/BMP, video MP4/MOV/M4V/WebM
- 🎬 **Video** — play clips between talks straight from the playlist. Play/pause, seek and audio stay in sync between the operator and the audience; sound goes to the main output only. The header shows the time-code and a large countdown to the end of the clip (orange at 30s, red at 10s). Controls: `Space` play/pause, `←/→` ±5s, `M` mute
- 🔊 **Audio output selection** — the "Audio output…" button opens a menu to pick which device the video sound goes to: sound card, laptop minijack, HDMI to a vMix machine, NDI, etc. The choice is remembered
- 📝 **Operator notes → confidence monitor** — type in the operator window, text appears instantly on the speaker's screen. Silent communication channel during the presentation
- 💬 **Speaker message** — flash a message on the confidence monitor: ready presets ("Wrap up", "Closer to the mic", "Final slide") or your own text, shown large and blinking until you clear it. Right-click a preset to edit its text
- ⬛ **Blackout / Key Visual** — press `B`: audience sees your Key Visual image (if loaded) or a black screen, video sound is muted too. Switch slides freely — the audience sees nothing
- ⌨️ **Customizable hotkeys** — the "Keys…" button opens an editor: rebind any action to your liking (e.g. TAKE on `Tab`)
- 💾 **Projects** — save your configured playlist as `.pdpres`, reopen before the next event
- 🔔 **Auto-update check** — checks GitHub once a day for a new version

---

### ⌨️ Keyboard Shortcuts

> Action keys are remappable in the "Keys…" editor (button at the bottom). Defaults below.

| Key | Action |
|-----|--------|
| `Tab` | **TAKE** — send preview to air |
| `[` / `]` | Preview: previous / next slide |
| `←` / `→` | Program: previous / next slide |
| `Space` | Program: next slide / video play-pause |
| `PgUp` / `PgDn` | Program: previous / next (clicker buttons) |
| `B` / `.` | Toggle blackout (`.` — clicker blank button) |
| `T` | Start / pause timer |
| `R` / `Shift+T` | Reset timer |
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
