# CueDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Built with Electron](https://img.shields.io/badge/Electron-33-9feaf9?logo=electron&logoColor=black)](https://electronjs.org)
[![Donate](https://img.shields.io/badge/%E2%98%95_%D0%9F%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%B0%D1%82%D1%8C-CloudTips-ff8c00)](https://pay.cloudtips.ru/p/b79fa042)

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

**Что при этом живёт (v0.4+):**

- 🎞 **Видео, вшитое в слайд, воспроизводится** — ролик накладывается поверх слайда точно на своём месте, синхронно во всех окнах. Запуск как привыкли спикеры: первый клик «далее» стартует видео, следующий — листает дальше. Кодеки — те же правила, что и для обычных видео (таблица ниже)
- ✨ **Анимации «по клику» работают** — слайд с построчным появлением текста разворачивается в шаги: каждый клик показывает следующую порцию, «назад» прячет обратно — как в оригинальном PowerPoint. Эффекты появления (вылет, выцветание) упрощаются до мгновенного появления

> ⚠️ **Ограничения:**
> - Файл конвертируется в PDF — **редактирование слайдов недоступно**
> - Эффекты исчезновения/выделения, движение по траектории, триггеры и звуки анимаций не воспроизводятся; переходы между слайдами — тоже
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

#### Захват — какой капчер подойдёт

CueDeck берёт картинку тем же способом, что Zoom и браузеры, поэтому видит устройства класса **UVC** — те, что система показывает как обычную веб-камеру.

| | Устройство | Почему |
|---|---|---|
| ✅ Работает | AVMatrix, Elgato Cam Link, недорогие HDMI→USB донглы | UVC, драйвер не нужен |
| ✅ Работает | Blackmagic **ATEM Mini**, **Web Presenter** | отдаются системе как веб-камера |
| ✅ Работает | Веб-камера ноутбука, iPhone по Continuity | удобно проверить схему без капчера |
| ❌ Не видно | Blackmagic **DeckLink**, **UltraStudio** | работают через свой драйвер Desktop Video, в списке камер не появляются |

**Проверка за пять секунд:** открой Photo Booth. Видно устройство — CueDeck его возьмёт.

Про **Continuity-камеру iPhone**: по Wi-Fi первые секунды идёт «слайд-шоу», пока канал не разгонится — это особенность беспроводного транспорта, а не CueDeck. По кабелю и на обычном капчере такого нет; фактическую частоту кадров видно в углу превью.

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
- 🎞 **Видео внутри PPTX-слайдов** — вшитый в слайд ролик играет прямо на слайде, на своём месте, синхронно у оператора, суфлёра и зала. Первый клик «далее» запускает видео (спикер стартует ролик сам, как привык), следующий — листает дальше; транспорт и звук — как у обычного видео
- ✨ **Анимации PowerPoint «по клику»** — построчные появления текста разворачиваются в шаги-страницы: кликер листает их как в оригинальном PowerPoint, «назад» прячет строки обратно
- 🎬 **Видео** — ролики между выступлениями прямо в плейлисте. Play/pause, перемотка и звук синхронизированы между окном оператора и залом; звук идёт только на основной выход. В шапке — таймкод и крупный обратный отсчёт до конца ролика (оранжевый за 30с, красный за 10с). Управление: `Space` — play/pause, `←/→` — ±5с, `M` — звук
- 📹 **Захват — чужой ноутбук на экране зала** — ведущий или диджей пришёл со своим ноутом и крутит контент только у себя? Подключаешь его HDMI через USB-капчер, и он встаёт в плейлист наравне с презентациями: клик — в превью, TAKE — в зал. Устройство занимается приложением с момента добавления и до удаления из списка, поэтому переключения мгновенные, а горячее переподключение кабеля подхватывается само. В углу — что источник реально отдаёт: разрешение и измеренная частота кадров. Три режима вписывания под гостевые 4:3 и 16:10 — вписать с полями, заполнить с обрезкой, растянуть; переключается на лету, не снимая источник с эфира
- 🎧 **Предпрослушка (SOLO) — послушать в наушники до эфира** — звук эфира уходит своим трактом (звуковая карта, HDMI на vMix), а наушники оператора при этом свободны. Задаёшь им отдельный выход — и слушаешь принесённый ролик или захват прямо в превью, пока в зале идёт другое. По умолчанию выключено: превью немое, пока сам не выберешь устройство
- 📊 **Индикаторы уровня звука** — полоска под превью и под эфиром показывает, что звук реально идёт: у ролика есть аудиодорожка, у гостевого ноута не пропал сигнал. Краснеет на перегрузе
- 🔊 **Выбор аудиовыхода** — кнопка «Звук…» открывает меню, где задаёшь, на какое устройство отдавать звук эфира: звуковая карта, миниджек ноута, HDMI на vMix-машину, NDI и т.п. Там же — выход предпрослушки. Выбор запоминается
- 📝 **Заметки оператора → суфлёр** — пишешь текст в окне оператора, он мгновенно появляется на экране суфлёра. Прямой канал связи со спикером без слов
- 💬 **Сообщение спикеру** — флэш-сообщение на суфлёр: готовые пресеты («Заканчивайте», «Ближе к микрофону», «Финальный слайд») или свой текст, крупно и мигает, пока не снимешь. Тексты пресетов меняются под себя правым кликом
- ⬛ **Blackout / Key Visual** — нажал `B`: аудитория видит заставку (если загружена) или чёрный фон, звук видео тоже глушится. Переключаешь слайды — аудитория ничего не видит
- ⌨️ **Настраиваемые горячие клавиши** — кнопка «Клавиши…» открывает редактор: переназначь любое действие под себя (например, TAKE на `Tab`)
- 🖼 **Списки — пачка фото и роликов одной строкой** — клиент принёс сорок фотографий на сбор гостей, а в перерыв надо крутить три ролика? Это одна запись в плейлисте, а не сорок. Режимы: **по кругу**, **вперемешку** (порядок тасуется на каждом круге), **один проход**. Задаёшь, сколько секунд держится фотография, и **FADE** — плавный наплыв между кадрами, кадры перетекают друг в друга. Ролик внутри пачки играет целиком и запускается сам. Порядок правится перетаскиванием, пачку можно пролистать в превью и посмотреть с клиентом до выдачи в зал
- 🔁 **Цикл ролика** — у каждой записи свой: видео-заставка крутится по кругу, пока спикер на сцене, а обычный ролик доигрывает и встаёт. Значок виден и переключается в плейлисте, в превью и в эфире; настройка сохраняется в проекте
- ⏸ **Стоп на первом кадре** — третий режим выдачи видео в эфир: ролик уходит замороженным, первый кадр работает заставкой, а запускает его спикер кликером — как видео на слайде презентации
- 🎞 **Анимированная заставка** — в Blackout можно показывать не только картинку, но и видеофайл: крутится по кругу, без звука
- 🛡 **Подтверждение при закрытии** — случайный крестик или Cmd+Q посреди эфира больше не гасит зал молча: спрашивает «Сохранить и закрыть / Закрыть без сохранения / Отмена». Вопрос только на экране оператора, смену раскладки экранов не трогает
- 📁 **Материалы не теряются при переезде** — проект запоминает файлы **относительно себя**: папку с проектом можно унести на флешке на другой компьютер, и всё откроется. Если файлы всё же переехали, пропажа видна **при открытии проекта**, а не в момент выдачи в зал: запись краснеет, рядом «Указать файл…». Кнопка **«Найти в папке…»** чинит все пропавшие разом по именам, а **File → «Собрать проект в папку…»** копирует проект и все материалы в одну самодостаточную папку под флешку
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

### ☕ Поддержать проект

CueDeck бесплатен и делается в свободное время. Если он выручил тебя на шоу — можно закинуть на кофе:

**[☕ Поддержать через CloudTips →](https://pay.cloudtips.ru/p/b79fa042)**

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

**What survives the conversion (v0.4+):**

- 🎞 **Videos embedded in slides play** — the clip is overlaid on the slide exactly where it belongs, in sync across all windows. Speaker-friendly start: the first "next" click starts the video, the following click moves on. Codec rules are the same as for regular video files (table below)
- ✨ **On-click animations work** — a slide with line-by-line text builds expands into steps: each click reveals the next portion, "back" hides it again — just like in PowerPoint. Entrance effects (fly-in, fade) are simplified to instant appearance

> ⚠️ **Limitations:**
> - The file is converted to PDF — **slide editing is not available**
> - Exit/emphasis effects, motion paths, triggers and animation sounds are not played; slide transitions aren't either
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

#### Live input — which capture device works

CueDeck grabs the picture the same way Zoom and browsers do, so it sees **UVC** devices — the ones your OS exposes as a regular webcam.

| | Device | Why |
|---|---|---|
| ✅ Works | AVMatrix, Elgato Cam Link, cheap HDMI→USB dongles | UVC, no driver needed |
| ✅ Works | Blackmagic **ATEM Mini**, **Web Presenter** | present themselves as a webcam |
| ✅ Works | Laptop webcam, iPhone via Continuity | handy for testing the setup without a capture device |
| ❌ Not visible | Blackmagic **DeckLink**, **UltraStudio** | run through their own Desktop Video driver, never appear in the camera list |

**Five-second check:** open Photo Booth. If the device shows up there, CueDeck will pick it up.

About the **iPhone Continuity camera**: over Wi-Fi the first seconds look like a slideshow until the link ramps up — that's the wireless transport, not CueDeck. Wired, and on a regular capture device, this does not happen; the actual frame rate is shown in the corner of the preview.

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
- 🎞 **Videos inside PPTX slides** — a clip embedded in a slide plays right on the slide, in its exact position, in sync across operator, speaker and audience windows. The first "next" click starts the video (speakers launch clips themselves, as they're used to), the following click moves on; transport and audio work like regular video
- ✨ **PowerPoint on-click animations** — line-by-line text builds expand into step pages: the clicker walks through them like in the original PowerPoint, "back" hides lines again
- 🎬 **Video** — play clips between talks straight from the playlist. Play/pause, seek and audio stay in sync between the operator and the audience; sound goes to the main output only. The header shows the time-code and a large countdown to the end of the clip (orange at 30s, red at 10s). Controls: `Space` play/pause, `←/→` ±5s, `M` mute
- 📹 **Live input — a guest laptop on the hall screen** — the host or DJ shows up with their own laptop and runs content only from it? Feed their HDMI through a USB capture device and it joins the playlist like any presentation: click to preview, TAKE to air. The device is held by the app from the moment you add it until you remove it from the list, so switching is instant and hot-replugging the cable recovers on its own. A badge in the corner shows what the source actually delivers: resolution and measured frame rate. Three fit modes for guest 4:3 and 16:10 laptops — letterbox, fill with cropping, stretch; switchable on the fly without pulling the source off air
- 🎧 **Cue / SOLO monitoring — listen on headphones before going live** — program audio goes out its own path (sound card, HDMI to vMix) while the operator's headphones sit idle. Assign them a separate output and audition an incoming clip or a live input right in preview while something else is on air. Off by default: preview stays silent until you pick a device
- 📊 **Audio level meters** — a bar under preview and under program shows that sound is actually flowing: the clip does have an audio track, the guest laptop's signal hasn't dropped. Turns red on overload
- 🔊 **Audio output selection** — the "Audio…" button opens a menu to pick which device program sound goes to: sound card, laptop minijack, HDMI to a vMix machine, NDI, etc. The cue output lives there too. The choice is remembered
- 📝 **Operator notes → confidence monitor** — type in the operator window, text appears instantly on the speaker's screen. Silent communication channel during the presentation
- 💬 **Speaker message** — flash a message on the confidence monitor: ready presets ("Wrap up", "Closer to the mic", "Final slide") or your own text, shown large and blinking until you clear it. Right-click a preset to edit its text
- ⬛ **Blackout / Key Visual** — press `B`: audience sees your Key Visual image (if loaded) or a black screen, video sound is muted too. Switch slides freely — the audience sees nothing
- ⌨️ **Customizable hotkeys** — the "Keys…" button opens an editor: rebind any action to your liking (e.g. TAKE on `Tab`)
- 🖼 **Lists — a batch of photos and clips as one row** — the client brings forty photos for guest arrival, and three clips have to loop during the break? That's a single playlist entry, not forty. Modes: **loop**, **shuffle** (reshuffled on every pass), **single pass**. You set how long each photo is held and a **FADE** — a true crossfade between frames. A clip inside the batch plays in full and starts on its own. Reorder by dragging; the batch can be stepped through in preview to review it with the client before going live
- 🔁 **Per-clip loop** — each entry has its own: an idents clip loops while the speaker is on stage, a regular clip plays out and stops. The toggle is visible in the playlist, in preview and on air; the setting is saved with the project
- ⏸ **Hold on first frame** — a third take mode for video: the clip goes on air frozen, its first frame acts as a title card, and the speaker starts it with the clicker — just like a video on a slide
- 🎞 **Animated key visual** — Blackout can show a video file, not just a still: it loops silently
- 🛡 **Quit confirmation** — an accidental close or Cmd+Q mid-show no longer kills the audience screen silently: it asks "Save and quit / Quit without saving / Cancel". The prompt only appears on the operator screen and never on layout changes
- 📁 **Materials survive a move** — a project stores files **relative to itself**: carry the project folder on a flash drive to another computer and everything still opens. If files did move, you find out **when opening the project**, not when going live: the entry turns red with a "Locate file…" button. **"Find in folder…"** repairs every missing file at once by name, and **File → "Collect project into folder…"** copies the project and all its materials into one self-contained folder
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

### ☕ Support the project

CueDeck is free and built in spare time. If it saved your show, you can buy me a coffee:

**[☕ Donate via CloudTips →](https://pay.cloudtips.ru/p/b79fa042)**

---

## 📄 License

[MIT](LICENSE) © 2026 [Azat Khusaenov](https://github.com/ttpa3dhuk)
