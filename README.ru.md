<p align="center"><img src="docs/screenshots/icon.png" width="96" alt="Иконка CueDeck"></p>

<h1 align="center">CueDeck</h1>

<p align="center"><b>Презентации всех спикеров с одного места: превью, TAKE, таймеры, суфлёр, трансляция.</b><br>
Бесплатно · macOS и Windows · для мероприятий и конференций</p>

<p align="center">
<a href="https://github.com/ttpa3dhuk/CueDeck/releases/latest"><b>Скачать</b></a> ·
<a href="README.md">English</a> ·
<a href="CHANGELOG.md">Что нового</a> ·
<a href="https://www.youtube.com/watch?v=Vi5BDG_WoRg">Видеообзор</a>
</p>

![Следующего спикера готовишь в превью, жмёшь TAKE, и он уходит в зал](docs/screenshots/take.gif)

Заранее собираешь всех спикеров: PDF, PowerPoint, Keynote, ролики, ноутбук гостя. Следующего готовишь в превью и жмёшь TAKE. Он уходит в зал, подгружается его таймер, суфлёр переключается следом.

<sub>Интерфейс на скриншотах английский, русский выбирается при первом запуске.</sub>

## Три экрана, один оператор

![Ноутбук оператора, суфлёр спикера и экран зала рядом](docs/screenshots/screens.png)

## Суфлёр, который спикер правда читает

Текущий и следующий слайд, твои заметки в реальном времени, таймер желтеет и краснеет к концу. Или весь экран отдаётся таймеру, под отдельный монитор у сцены.

| | |
|---|---|
| ![Суфлёр: слайд, следующий, заметки, таймер](docs/screenshots/prompter.png) | ![Суфлёр в режиме «только таймер»](docs/screenshots/prompter-timer.png) |

Таймер и сообщение спикеру ставятся мышкой куда угодно:

<img src="docs/screenshots/settings-prompter.png" width="640" alt="Макет суфлёра в Настройках">

## Трансляция без OBS

Кнопка STREAM отправляет картинку и звук зала на YouTube, VK и Telegram, до 5 площадок разом. Площадку можно включить или отключить прямо в эфире. Статистика показывает, где проблема: в компьютере, в сети или на площадке.

<img src="docs/screenshots/stream.png" width="720" alt="Окно трансляции с площадками YouTube, VK и Telegram">

## Выходы OMT для vMix и OBS

Таймер на прозрачном фоне, зал (со звуком) и суфлёр уходят в сеть источниками [OMT](https://github.com/openmediatransport), открытой заменой NDI. vMix 29+ видит их сам, для OBS нужен плагин OMT. Таймер ложится поверх картинки без ключа. Когда vMix берёт источник CueDeck в эфир, кнопка OMT горит красным.

Настройка: Настройки → Выходы OMT (имя, 720p / 1080p / 4K, 15–60 к/с). Ролики лучше гнать по проводу: каждый получатель берёт свой поток, около 60 Мбит/с на 1080p30. По Wi-Fi у нас доходило 11 кадров из 30.

Живой vMix 29 мы пока не проверяли, проверяли OBS. Если в vMix что-то пойдёт не так, [заведи issue](https://github.com/ttpa3dhuk/CueDeck/issues/new/choose).

## Stream Deck и Companion

Готовая страница для [Bitfocus Companion](https://bitfocus.io/companion): живой таймер, TAKE с именем спикера, лампа OMT (горит красным, когда vMix взял нас в эфир). На двух дополнительных страницах есть кнопка под каждую команду CueDeck, их можно копировать и раскладывать под свою деку. Ещё есть HTTP и OSC ([как подключить](companion/README.md)).

<img src="docs/screenshots/streamdeck.png" width="480" alt="Кнопки CueDeck на Stream Deck через Companion">

## Скачать

| Компьютер | Файл из [последнего релиза](https://github.com/ttpa3dhuk/CueDeck/releases/latest) |
|---|---|
| Mac на Apple Silicon (M1 и новее) | `CueDeck-<версия>-Silicon-mac.zip` |
| Mac на Intel | `CueDeck-<версия>-Intel-mac.zip` |
| Windows 10 / 11 | `CueDeck-<версия>-win.zip` |

<details>
<summary>Первый запуск: приложение без подписи</summary>

На macOS: распакуй, перетащи `CueDeck.app` в «Программы», затем правый клик, «Открыть» и ещё раз «Открыть». Если пишет «приложение повреждено»: `xattr -cr /Applications/CueDeck.app`.

На Windows: распакуй и запусти `CueDeck.exe`. SmartScreen предупредит, нажми «Подробнее», потом «Выполнить в любом случае». Всё равно не запускается? Смотри [Windows по шагам](docs/windows.ru.md).

Для PowerPoint и Keynote нужен [LibreOffice](https://ru.libreoffice.org/download/). PDF, картинки и видео работают без него.
</details>

<a href="https://www.youtube.com/watch?v=Vi5BDG_WoRg"><img src="https://img.youtube.com/vi/Vi5BDG_WoRg/maxresdefault.jpg" width="480" alt="Видеообзор всех возможностей"></a><br>
<sub>Видеообзор всех возможностей, 40 мин</sub>

## Подробнее

<details>
<summary>Все возможности</summary>

- Превью и эфир, TAKE на `Tab`. Глобальный кликер: PgUp/PgDn листают, даже когда CueDeck не в фокусе
- Плейлист спикеров: перетаскивание, имя и таймер на каждого
- Таймер: обратный отсчёт, секундомер или часы. Пресеты и ±1 мин на лету, тиканье и гонг
- Заметки идут в суфлёр мгновенно, заметки докладчика из PowerPoint подставляются сами
- Сообщение спикеру: «Заканчивайте», «Ближе к микрофону» или свой текст
- Заставка / blackout (`B`): картинка или видео-заставка в зале, пока меняешь файлы
- PowerPoint, Keynote, ODP: видео внутри слайдов и анимации «по клику» играют
- Ролики идут синхронно во всех окнах, цикл у каждого свой, стоп на первом кадре
- Списки фото и роликов одной строкой плейлиста, по кругу или вперемешку, с наплывом
- Живой вход: ноутбук гостя через USB-капчер HDMI встаёт в плейлист как обычный файл
- Звук: отдельные выходы для зала и предпрослушки в наушники, индикаторы уровня
- Трансляция: RTMP/RTMPS, до 5 площадок, журнал каждого эфира в файл
- Stream Deck, Companion, OSC, HTTP, MIDI-контроллеры
- Профили площадки: все настройки под знакомый зал одним выбором
- Проект переезжает на другой компьютер, пропавшие файлы видны при открытии, а не в эфире
- Подтверждение при закрытии посреди шоу. «Сообщить о проблеме…» в меню Help сохраняет zip с журналом
- Русский и английский интерфейс
</details>

<details>
<summary>Форматы и устройства</summary>

| Что | Работает | Заметка |
|---|---|---|
| PDF, PNG, JPG, WebP, GIF, BMP | да | открывается сразу |
| PPTX, PPT, ODP, Keynote | да | конвертируется через LibreOffice один раз, дальше из кеша. Эффекты исчезновения и переходы не играют |
| Видео H.264 + AAC (MP4, MOV, M4V), WebM | да | лучше гнать в MP4 (H.264 + AAC) |
| HEVC / H.265 | частично | на Mac обычно да, на Windows нужны HEVC Video Extensions |
| ProRes, DNxHD | нет | перекодируй в [HandBrake](https://handbrake.fr/) |
| USB-захват (UVC): Elgato Cam Link, AVMatrix, ATEM Mini, веб-камеры | да | видит Photo Booth, значит увидит и CueDeck |
| Blackmagic DeckLink / UltraStudio | нет | свой драйвер, камерой не видны |
</details>

<details>
<summary>Клавиши</summary>

Переназначаются в Настройки → Горячие клавиши.

| Клавиша | Действие |
|---|---|
| `Tab` | TAKE: превью в зал |
| `←` `→` / `Space` / `PgUp` `PgDn` | Эфир: предыдущий / следующий слайд |
| `[` `]` | Превью: предыдущий / следующий слайд |
| `B` | Заставка / blackout |
| `T` / `R` | Таймер: старт-пауза / сброс |
| `Cmd+,` | Настройки |
</details>

<details>
<summary>Сборка из исходников</summary>

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

Нашёл баг? [Заведи issue](https://github.com/ttpa3dhuk/CueDeck/issues/new/choose) или напиши в бот поддержки [@CueDeckSupport_Bot](https://t.me/CueDeckSupport_Bot) в Telegram. Пункт «Сообщить о проблеме…» в меню Help (на маке оно называется «Справка») сохраняет zip с журналом, его можно приложить.

CueDeck бесплатный и делается в свободное время. Если выручил на шоу, можно [на кофе через CloudTips](https://pay.cloudtips.ru/p/b79fa042).

[MIT](LICENSE) © 2026 [Азат Хусаенов](https://github.com/ttpa3dhuk)
