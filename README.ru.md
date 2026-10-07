<p align="center"><img src="docs/screenshots/icon.png" width="96" alt="Иконка CueDeck"></p>

<h1 align="center">CueDeck</h1>

<p align="center"><b>Презентации всех спикеров с одного места — превью, TAKE, таймеры, суфлёр, трансляция.</b><br>
Бесплатно · macOS и Windows · для мероприятий и конференций</p>

<p align="center">
<a href="https://github.com/ttpa3dhuk/CueDeck/releases/latest"><b>⬇️ Скачать</b></a> ·
<a href="README.md">🇬🇧 English</a> ·
<a href="CHANGELOG.md">📋 Что нового</a> ·
<a href="https://www.youtube.com/watch?v=Vi5BDG_WoRg">🎥 Видеообзор</a>
</p>

![Следующего спикера готовишь в превью, жмёшь TAKE — он уходит в зал](docs/screenshots/take.gif)

Заранее собираешь всех спикеров — PDF, PowerPoint, Keynote, ролики, ноутбук гостя. Следующего готовишь в **превью**, жмёшь **TAKE**: он уходит в зал, подгружается его таймер, суфлёр переключается следом.

<sub>Интерфейс на скриншотах английский; русский выбирается при первом запуске.</sub>

## 🖥 Три экрана, один оператор

![Ноутбук оператора, суфлёр спикера и экран зала рядом](docs/screenshots/screens.png)

## 🗣 Суфлёр, который спикер правда читает

Текущий и следующий слайд, твои заметки в реальном времени, таймер желтеет и краснеет к концу. Или весь экран отдаётся таймеру — под отдельный монитор у сцены.

| | |
|---|---|
| ![Суфлёр: слайд, следующий, заметки, таймер](docs/screenshots/prompter.png) | ![Суфлёр в режиме «только таймер»](docs/screenshots/prompter-timer.png) |

Таймер и сообщение спикеру ставятся мышкой куда угодно:

<img src="docs/screenshots/settings-prompter.png" width="640" alt="Макет суфлёра в Настройках">

## 📡 Трансляция без OBS

Кнопка STREAM отправляет картинку и звук зала на YouTube, VK, Telegram — до 5 площадок разом. Площадку можно включить или отключить прямо в эфире; статистика подскажет, где проблема: компьютер, сеть или площадка.

<img src="docs/screenshots/stream.png" width="720" alt="Окно трансляции с площадками YouTube, VK и Telegram">

## 🔌 Выходы OMT для vMix и OBS

Таймер на прозрачном фоне, зал (со звуком) и суфлёр уходят в сеть источниками [OMT](https://github.com/openmediatransport) — открытой замены NDI. vMix 29+ видит их сам, OBS — с плагином OMT. Таймер ложится поверх картинки без ключа; когда vMix берёт источник CueDeck в эфир, кнопка OMT горит красным. Настройка — ⚙️ Настройки → Выходы OMT: имя, 720p / 1080p / 4K, 15–60 к/с. Ролики — только по проводу: каждый получатель берёт свой поток, ~60 Мбит/с на 1080p30.

## 🎛 Stream Deck и Companion

Готовая страница для [Bitfocus Companion](https://bitfocus.io/companion): живой таймер, TAKE с именем спикера, спикеры подсвечены зелёным в превью и красным в эфире. HTTP и OSC — для всего остального ([как подключить](companion/README.md)).

<img src="docs/screenshots/streamdeck.png" width="480" alt="Кнопки CueDeck на Stream Deck через Companion">

## ⬇️ Скачать

| Компьютер | Файл из [последнего релиза](https://github.com/ttpa3dhuk/CueDeck/releases/latest) |
|---|---|
| Mac на Apple Silicon (M1 и новее) | `CueDeck-<версия>-Silicon-mac.zip` |
| Mac на Intel | `CueDeck-<версия>-Intel-mac.zip` |
| Windows 10 / 11 | `CueDeck-<версия>-win.zip` |

<details>
<summary><b>Первый запуск</b> — приложение без подписи</summary>

**macOS:** распакуй, перетащи `CueDeck.app` в «Программы», затем правый клик → **Открыть** → **Открыть**. Если пишет «приложение повреждено»: `xattr -cr /Applications/CueDeck.app`.

**Windows:** распакуй и запусти `CueDeck.exe`. SmartScreen предупредит → **Подробнее** → **Выполнить в любом случае**.

Для **PowerPoint / Keynote** нужен [LibreOffice](https://ru.libreoffice.org/download/). PDF, картинки и видео работают без него.
</details>

<a href="https://www.youtube.com/watch?v=Vi5BDG_WoRg"><img src="https://img.youtube.com/vi/Vi5BDG_WoRg/maxresdefault.jpg" width="480" alt="Видеообзор всех возможностей"></a><br>
<sub>Видеообзор всех возможностей, 40 мин</sub>

## 📚 Подробнее

<details>
<summary><b>Все возможности</b></summary>

- **Превью / эфир** и **TAKE** (`Tab`); глобальный кликер — PgUp/PgDn листают, даже когда CueDeck не в фокусе
- **Плейлист спикеров** — перетаскивание, имя и таймер на каждого
- **Таймер** — обратный отсчёт, секундомер или часы; пресеты и ±1 мин на лету; тиканье и гонг
- **Заметки → суфлёр** мгновенно; заметки докладчика из PowerPoint подставляются сами
- **Сообщение спикеру** — «Заканчивайте», «Ближе к микрофону» или свой текст
- **Заставка / blackout** (`B`) — картинка или видео-заставка в зале, пока меняешь файлы
- **PowerPoint / Keynote / ODP** — видео внутри слайдов и анимации «по клику» играют
- **Ролики** синхронно во всех окнах; цикл у каждого, стоп на первом кадре
- **Списки фото/роликов** — одной строкой плейлиста, по кругу или вперемешку, с наплывом
- **Живой вход** — ноутбук гостя через USB-капчер HDMI встаёт в плейлист как обычный файл
- **Звук** — отдельные выходы для зала и предпрослушки в наушники, индикаторы уровня
- **Трансляция** — RTMP/RTMPS, до 5 площадок, журнал каждого эфира в файл
- **Stream Deck, Companion, OSC, HTTP**; MIDI-контроллеры
- **Профили площадки** — все настройки под знакомый зал одним выбором
- Проект переезжает на другой компьютер; пропавшие файлы видны при открытии, а не в эфире
- Подтверждение при закрытии посреди шоу; Справка → «Сообщить о проблеме…» сохраняет zip с журналом
- Русский и английский интерфейс
</details>

<details>
<summary><b>Форматы и устройства</b></summary>

| Что | Работает | Заметка |
|---|---|---|
| PDF, PNG, JPG, WebP, GIF, BMP | ✅ | открывается сразу |
| PPTX, PPT, ODP, Keynote | ✅ | конвертируется через LibreOffice один раз, дальше из кеша; эффекты исчезновения и переходы не играют |
| Видео H.264 + AAC (MP4, MOV, M4V), WebM | ✅ | гони в MP4 (H.264 + AAC) |
| HEVC / H.265 | ⚠️ | Mac — обычно да; Windows — нужны HEVC Video Extensions |
| ProRes, DNxHD | ❌ | перекодируй в [HandBrake](https://handbrake.fr/) |
| USB-захват (UVC): Elgato Cam Link, AVMatrix, ATEM Mini, веб-камеры | ✅ | видит Photo Booth — увидит и CueDeck |
| Blackmagic DeckLink / UltraStudio | ❌ | свой драйвер, камерой не видны |
</details>

<details>
<summary><b>Клавиши</b></summary>

Переназначаются в ⚙️ Настройки → Горячие клавиши.

| Клавиша | Действие |
|---|---|
| `Tab` | **TAKE** — превью в зал |
| `←` `→` / `Space` / `PgUp` `PgDn` | Эфир: предыдущий / следующий слайд |
| `[` `]` | Превью: предыдущий / следующий слайд |
| `B` | Заставка / blackout |
| `T` / `R` | Таймер: старт-пауза / сброс |
| `Cmd+,` | Настройки |
</details>

<details>
<summary><b>Сборка из исходников</b></summary>

```bash
git clone https://github.com/ttpa3dhuk/CueDeck.git
cd CueDeck
npm install
npm run dev           # режим разработки
npm test              # тесты
npm run package:mac   # zip для Mac (Apple Silicon + Intel)
npm run package:win   # zip для Windows
```

Electron + TypeScript.
</details>

Нашёл баг? [Заведи issue](https://github.com/ttpa3dhuk/CueDeck/issues/new/choose) — Справка → «Сообщить о проблеме…» сохраняет zip с журналом, его можно приложить.

☕ CueDeck бесплатный и делается в свободное время. Если выручил на шоу — [на кофе через CloudTips](https://pay.cloudtips.ru/p/b79fa042).

[MIT](LICENSE) © 2026 [Азат Хусаенов](https://github.com/ttpa3dhuk)
