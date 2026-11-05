# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Выбор основной модели в CueDeck — исключение зоны, 2026-11-05

Решение Азата для этой зоны заменяет общее правило перехода на Astra при сложной задаче. Причина — сохранить недельный лимит токенов.

- Вся разработка, включая архитектуру, код, отладку, проверки и подготовку предрелизных файлов, выполняется на Sol/Terra. Не останавливать работу и не просить переключения на Astra из-за сложности задачи.
- При необходимости подключать DeepSeek по действующей схеме выбора модели/effort; основной агент проверяет его результат. Это не заменяет тесты и приёмку.
- Только после полного прохода предрелиза, на этапе финальных тестов перед выпуском, Азат по своей отмашке включает Astra для совместного итогового прохода. До этого Astra не требуется.
- Ручной выбор модели остаётся за Азатом: запись этого правила не переключает работающую сессию автоматически. Не утверждать фактическую модель без подтверждения.
- Правила читки релиза, финальной сборки и отдельного разрешения на публикацию сохраняются.

## Ответы Азату (уточнение 2026-10-15)

Коротко и тезисно, минимум текста. Подробности — по вопросу Азата. Не превращать короткий ответ в шаблон с множеством секций. Старый вопрос о «пробной неделе» относился к Claude; повторно не задавать.

## Настройки при разработке и проверках (решение Азата, 2026-10-22)

По умолчанию не сохранять и не резервировать настройки/состояние CueDeck, не создавать отдельный тестовый профиль ради их сохранности и не спрашивать об этом. Можно менять текущие настройки и при необходимости сбрасывать их до заводских в рамках порученной разработки и проверок. Сохранение делать только если Азат сам прямо попросил сохранить текущее состояние. Не останавливать работу и длинные прогоны ради вопроса о настройках: профили площадки и шоу пользователь сохраняет отдельно.

Это правило относится к настройкам и состоянию CueDeck. Оно не разрешает удалять исходники, пользовательские проекты и медиа или менять настройки других приложений вне задачи.

## Ответы коллегам и поддержка проекта (2026-10-16)

Азату отвечать коротко и прямо. В сообщениях коллегам давать немного больше рабочего контекста: что надо продумать в интерфейсе, сохранить в проекте и проверить на конечном экране, особенно Windows. Не писать «легко», «быстро», «просто добавим». Показывать реальную работу и причины затрат времени, без выдуманной сложности и неподтверждённых обещаний. Пример согласованного тона: ответ Роману в feedback/FB-003.md от 2026-10-16.

В финальных Telegram-постах о релизах ненавязчиво напоминать о донатах: поддержка помогает выделять время на CueDeck. Без давления на пользователей; текст сначала показать Азату. Тексты для людей по-прежнему через azat-voice + humanizer.

## Порядок выпуска релиза (правило Азата, 2026-10-14)

**Не загружать SHA256SUMS.txt и другие отдельные файлы контрольных сумм в релизы.** Правило Азата 2026-10-15. Хеши проверять локально и сверять с digest GitHub; в Assets только пользовательские сборки.

Сначала подготовить описание изменений и показать Азату. Во время чтения он вспоминает дополнительные проверки и исправления: разобрать их, внести согласованные изменения или явно оставить на следующие фиксы. Только после завершения читки и согласования состава релиза поднимать финальную версию и собирать установщики/архивы. Не запускать финальную сборку параллельно с первым чтением текста. Затем проверить файлы и публиковать по отмашке Азата. В каждом описании релиза оставлять инструкцию: Help / «Справка» → «Сообщить о проблеме…», ZIP на рабочем столе → @CueDeckSupport_Bot; Cmd/Ctrl+Shift+M отмечает момент сбоя.

## 🛑 Только одна рабочая сборка (правило Азата, 2026-10-08)

**Одновременно жива ровно одна dev-сборка CueDeck.** Dev-Electron не умирает от обычного `pkill`/SIGTERM — перезапуски «по-простому» трижды плодили копии (LESSONS 2026-09-28, 2026-10-08).
- Запуск — только `env -u ELECTRON_RUN_AS_NODE npm run dev`: скрипт `scripts/stop-dev.cjs` сам добивает прежнюю сборку (`kill -9`) и не стартует, если она не закрылась. Electron руками (`node_modules/.bin/electron …`) не запускать.
- Остановить — `pkill -f "electron-vite dev"; pkill -9 -f "CueDeck/node_modules/electron/dist"`, затем `pgrep -f "CueDeck/node_modules/electron"` — пусто.
- Упакованную сборку проверил — сразу `lsregister -u` и удалить `release/mac*` (иначе macOS видит лишние CueDeck.app); локальные архивы прошлого релиза не затирать.
- **В начале сессии открыть `LESSONS.md`.**

## Отзывы и синхронизация сессий

`feedback/` — общий локальный реестр отзывов, вся папка в `.gitignore`. При работе с отзывами сначала читать `feedback/README.md`. Не читать всю базу: через `rg` искать автора/Telegram/ID/тему в `feedback/INDEX.md`, затем открывать только нужную карточку и её актуальные задачи; историю читать по необходимости. Сбор и разбор обновляют одну карточку FB-xxx. Статусы только в карточке; PLAN.md и индекс содержат ссылки. Перед записью перечитывать нужный раздел с диска, не перезаписывать чужие изменения. После работы сохранять результат и проверку. Старый FEEDBACK.md — только указатель на новую базу.

## ⚠️ Прочитать первым делом: PLAN.md

**`PLAN.md` в корне проекта — план работ и очередь задач.** Он в `.gitignore`, поэтому автоматически не подгружается: **открой его руками в начале сессии.** Там приоритеты P0/P1/P2, история решений по каждой фиче и грабли, которые уже оплачены временем.

**Грабли одним списком — `LESSONS.md`** (локальный, как этот файл; новые грабли — сразу туда).

**Решения «почему так, а не иначе» — `DECISIONS.md`** (локальный, `.git/info/exclude`; новое решение Азата — строкой-разделом в конец).

### Состояние на 2026-10-09, день (v0.10.2)

**v0.10.2 выложена на GitHub 2026-10-09** — по отзыву тестера с YouTube: выключение любой горячей клавиши (✕, пустая строка в `cuedeck.hotkeys`), Enter — строка карты `takeAlt` (раньше был зашит мимо карты), справка по Esc/клику мимо, `removeMenu()` у зала и суфлёра на Windows. **Бот поддержки** `@CueDeckSupport_Bot` (`SUPPORT_URL` в shared/types.ts): кнопка в окне отчёта после сохранения + Help → «Поддержка в Telegram…». Сам бот живёт на минике, код локально в `support-bot/` (exclude), устройство — `support-bot/README.md`.

### Состояние на 2026-10-09 (после v0.10.1)

**Stream Deck / Companion (PLAN 2.27):** лампа OMT «Зал» (`cuedeck_omt_*`), модуль 0.2.0 (язык «Auto» по `/api/state.lang`), шаблон Companion — **библиотека** из трёх страниц, где есть каждая команда (тест `tests/companion-page.test.ts`), образцы на переменных кнопок `$(local:…)`, пресеты на кнопках, окошки «В ЭФИРЕ»/«ПРЕВЬЮ». В командах: `timer/set`/`timer/preset` сбрасывают прошедшее время, ± на секундомере двигает показанное время (`adjustPatch`), край плейлиста — ok без действия. Раскладка страницы 1 не закончена — ждёт таблицу Азата.

### Состояние на 2026-10-08 (v0.10.0)

**v0.10.0 выложена на GitHub 2026-10-08** — выходы OMT. Упакованная мак-сборка проверена (OMT в сети), Windows-сборка проверена на шаттле. Живой vMix 29 — не проверен.

**Выходы OMT** (PLAN 2.24, раздел «Выходы OMT» ниже): таймер с альфой, зал со звуком, суфлёр; tally от vMix. Проверено: OBS на маке, Windows (шаттл LightRig), замеры по кабелю/Wi-Fi. Не проверено: живой vMix 29. Перед выпуском — подумать про подпись exe (Smart App Control на чистой Windows 11 не пускает неподписанное).

### Состояние на 2026-09-29 (v0.9.0)

**v0.9.0 выложена на GitHub 2026-09-29** — встроенная трансляция (PLAN 2.21): YouTube, VK, Telegram проверены вживую по отдельности и разом, упакованная мак-сборка стримит (локальный сервер). Не проверено: Windows, живой пульт по USB. Следующее по решению Азата — микшер (PLAN 2.19).

### Состояние на 2026-09-28, день (после v0.8.1)

**Встроенная трансляция RTMP/RTMPS** (PLAN 2.21, раздел «Трансляция RTMP/RTMPS» ниже): кнопка STREAM, до 5 площадок, включение/отключение на лету, статистика и журнал «Компьютер / Сеть / Площадка». YouTube (основной + резервный), VK и Telegram (RTMPS) проверены вживую. Меню «Правка» добавлено — на маке без него не работал Cmd+V. Не проверено: вход с пульта, Windows, packaged. Тестовый проект под стримы — `stream-test/stream-test.pdpres` (два ролика со звуком на цикле, вне git).

### Состояние на 2026-09-28 (v0.8.1)

**v0.8.1 выложена на GitHub 2026-09-28** — профили площадки, заметки докладчика из PPTX (PLAN 2.23), исправлена нумерация страниц при скрытых слайдах. Микшер (2.19) — только после RTMP (2.21), решение Азата 2026-09-28.


После v0.8.0 в main (не выпущено): **профили площадки** (`profiles.ts` + `profile-core.ts`, раздел «Настройки → Профили площадки», PLAN 2.18 шаг 6), в dev смена языка — без перезапуска (`app.relaunch()` в dev electron-vite даёт пустое окно — LESSONS), сокращённые тексты «Настроек». Настоящий Stream Deck MK.2 проверен со страницей-файлом и модулем 0.1.0. Следующее — PLAN 2.23 (заметки из PowerPoint).

### Состояние на 2026-09-24

**v0.7.0 выложена на GitHub 2026-09-24** — внешнее управление (`src/main/remote/`: HTTP + OSC, Stream Deck / Companion, команды эфира сразу в эфир), готовая страница Bitfocus Companion (`companion/`, CueDeck сам толкает переменные), одно окно «Настройки» (7+ разделов, всё настроечное переехало с панелей), суфлёр мышкой (таймер/сообщение/колонки/цвет на макете), MIDI — выбор устройств, светлая тема по умолчанию для новых установок. Проверено на dev-сборке на маке (curl, OSC-пакеты, CDP-мышь, живой Companion 5.0.6 с эмулятором деки, Азат гонял кнопки сам). **Настоящий Stream Deck MK.2 (15 кнопок) проверен 2026-09-28** — все кнопки ядра 5×3, отображение на деке, мигание в минусе; в тот же день — модуль `cuedeck-cuedeck` 0.1.0 на той же деке (tally спикеров). **Не проверено:** Windows, Companion на другом компьютере, packaged-сборка. Дальше — PLAN 2.18: MIDI learn (без живого сценария: WING снят 2026-09-28 — к CueDeck не относится), модуль Companion (3c), профили площадки (6).

### Состояние на 2026-09-17

**v0.6.3 выложена на GitHub 2026-09-17 — диагностика для тестеров:** журнал действий в файл + «Help → Сообщить о проблеме…» → zip на рабочем столе, который тестер присылает в Telegram. Маркер «здесь что-то не то» — `Cmd/Ctrl+Shift+M`, ловится по физической клавише (работает на русской раскладке). Подробности — раздел «Диагностика» ниже и `src/main/diag.ts`. Проверено на dev-сборке на маке (журнал, маркеры хоткеем и из меню, отчёт со скриншотами, тайминги зала). Не проверено живьём: перехват `console-message` рендереров и баннер «в прошлый раз закрылся аварийно» (он включается только в packaged-сборке).

### Состояние на 2026-08-30 (конец сессии)

**v0.6.2 выложена на GitHub 2026-08-30** — режим «только таймер» на суфлёре (кнопка ⛶, два состояния: со вспышкой и без) и внятные имена окон под системы захвата (`CueDeck` / `PROMPTER - TIMER` / `MAIN - PRESENTATIONS`). Обе фичи Азат посмотрел на дев-сборке до релиза. Открытые хвосты с 0.6.1 (ниже) никуда не делись: промаргивание на Windows и интерфейс на Windows живьём.

### Состояние на 2026-08-16

**v0.6.1 выложена на GitHub 2026-08-16** (тег v0.6.1, три архива Silicon/Intel/Win) — списки фото/роликов, «Захват», циклы у записи, видео-заставка, наплыв, режим «стоп на первом кадре». Азат проверил на маке перед выкладкой. **Windows-прогона по-прежнему не было** (2.4): перед сборкой прогнан только статический аудит путей в семантике win32 (относительные пути проекта, другой диск, выбор кандидата при перепривязке — все инварианты держатся).

До неё в тот же день вышла v0.6.0 (подтверждение при закрытии, плашка поддержки, работа с пропавшими материалами).

**Азат прогнал релиз на маке — работает.** Что осталось открытым:

1. **🐞 Промаргивание предыдущего файла** — главное открытое. Азат берёт на работу самый старый ноут парка; протокол из четырёх фактов — в PLAN.md, секция «🐞 ОТКРЫТ: промаргивание…». Решают пункты 2 и 3 протокола (деки одного формата против разного). Без его результата не чиним.
2. **Windows вживую** — интерфейс на Windows не видел никто (PLAN 2.4). Оба сегодняшних релиза туда уехали только со статическим аудитом путей.
3. **Мелочи, которые ждут глаз:** что смена раскладки не спрашивает подтверждение выхода (следует из конструкции — гард висит только на окне оператора).

Решения по монетизации (не менять без Азата): механизма снятия nag-плашки НЕТ, лицензия MIT. **С 2026-10-07 — CueDeck open source «по кайфу»** (DECISIONS 027): платные плагины/SDK/лицензионные отчисления — не запрет, а предупредить и решить вместе с Азатом до подключения. `CUEDECK_NO_NAG=1` пропускает плашку в разработке.



## Commands

```bash
npm run dev                          # dev mode with HMR
PRESENTER_DEV_TILE=1 npm run dev    # tile all windows on one screen (single-display debug)
npm run build                        # production build → out/
npm run preview                      # run production build
npm run typecheck                    # TypeScript check without emit
npm run package:mac                  # build DMG + ZIP for Mac (arm64 + x64)
npm run package:win                  # build ZIP for Windows x64 (uses wine on Mac)
npm run package:all                  # both Mac + Windows
```

Output of packaging lives in `release/`. Cleanup: `rm -rf release out`.

Тесты — vitest: `npx vitest run` (файлы в `tests/`). Тесты `pptx-media` используют реальную презу `resources/Презентация1.pptx` (вне git) — без неё скипаются.

**Запуск Electron из-под Codex (VSCode):** оболочка наследует `ELECTRON_RUN_AS_NODE=1`, и электрон падает на старте с «Cannot read properties of undefined (reading 'exports')» / «Cannot find module 'electron'». Запускать: `env -u ELECTRON_RUN_AS_NODE npm run dev`. Из обычного терминала (RUN.command Азата) всё работает как есть. Перед показом фичи Азату: убить все Electron-процессы, поднять одну свежую дев-сборку.

## Architecture

Electron + electron-vite + TypeScript. Three processes:

### Main process (`src/main/`)

`StateStore` (state.ts) is the single source of truth. All mutations go through `store.patch()`, which immediately broadcasts `state:patch` IPC diffs to every registered `BrowserWindow`. On window creation `state:full` is sent once.

Key modules:
- `layout.ts` — pure functions: `Layout` / `Role` types, `rolesForLayout`, `autoAssignDisplays`
- `windows.ts` — creates/repositions `BrowserWindow` per role; `applyLayout` reconciles the active window set. Переезд окна на другой дисплей / смена fullscreen-режима = **пересоздание окна** (двигать fullscreen-окно через Spaces setBounds'ом ненадёжно — macOS возвращает его на прежний экран даже после 'leave-full-screen'). Диалог выбора раскладки при старте — кастомное frameless-окно `boot-dialog.ts` (страница в data:-URL, ответ через `document.title`), НЕ `dialog.showMessageBox`: NSAlert не даёт управлять вертикальным порядком кнопок (низ резервирует под cancel) и не умеет разделитель/плашку доната. Заодно база под nag-плашку (PLAN 2.12)
- `display-mapping.ts` — persists display topology → layout mapping via `electron-store`, keyed by sorted display IDs; also persists last PDF path, timer settings (mode/position/scale/duration), playlist, key visual, project path, notes font size, output-monitor toggle, UI theme
- `output-monitor.ts` — монитор суфлёра у оператора: каждые 500 мс `capturePage()` окна суфлёра (без суфлёра — зала) → resize 480px → JPEG → IPC `monitor:frame` оператору. Захват компоновщика Chromium, macOS Screen Recording не нужен. В solo держит **скрытое** окно суфлёра (`createHiddenSpeakerWindow`, capturePage со `stayHidden:true`) — преднастройка проекта без второго экрана. Выкл. чекбоксом в «Настройки → Экраны» (`outputMonitorsEnabled`)
- `ipc.ts` — all `ipcMain.handle` registrations; owns `openFile()` which loads a file, computes SHA1, reads sidecar notes, patches state; `kindOf(path)` returns `'pdf' | 'image' | 'pptx' | null`
- `notes-store.ts` — debounced (500ms) atomic sidecar writer (`<name>.notes.json` next to the PDF); SHA1-mismatch detection on load
- `pptx-converter.ts` — converts PPTX/ODP/KEY via `soffice --headless --convert-to pdf`; caches result by SHA1 in `userData/pptx-cache/`
- `pptx-media.ts` — препроцессор PPTX перед конвертацией (см. раздел «PPTX: видео и анимации» ниже). Свой минимальный zip-reader/writer и regex-хирургия OOXML — **хрупкий модуль, менять только с прогоном `tests/pptx-media.test.ts`**
- `project.ts` — loads/saves `.pdpres` project files (playlist + keyVisualPath JSON), migrates legacy field names
- **Цикл видео и видео-заставка (1.25):** `videoLoop` в состоянии (персист) — по `video:ended` main перезапускает логические часы вместо паузы на последнем кадре, индикатор-кнопка LOOP живёт в транспорте видео (нажата — залита, отжата — полупрозрачная), флаг пишется в `PlaylistEntry.loop`. Заставка (KV) может быть видеофайлом: зал берёт её потоком `cuedeck-media://stream/keyvisual`, `keyvisual:read` для видео возвращает `null` (в память не тянем), элемент зациклен и нем, играет только пока показана. Признак «заставка это видео» рендереры считают сами через `isVideoPath()` в `renderer/shared/video.ts` — дублировать это в состоянии не нужно
- **Списки (1.26):** `kind:'list'` — пачка фото/роликов одной записью плейлиста (`items`, `photoSec`, `listMode`, `fadeMs`). Своей логики показа у списка НЕТ: main по очереди открывает элементы обычным `openFile`, окна показывают их как любой файл. Очередь двигают таймер фотографий (main) и `video:ended` от оператора. Порядок обхода — `listOrder` (в 'shuffle' тасуется на каждом проходе), состояние: `listIndex` (элемент), `listPos` (позиция обхода), `previewListIndex` (прокрутка пачки в превью теми же ◀ ▶). Любая загрузка в эфир мимо проигрывателя вызывает `stopListPlayback()` — иначе таймер подменял бы картинку под чужим материалом
- `updater.ts` — notify-only GitHub Releases poller; compares `app.getVersion()` against `tag_name` of latest release
- `diag.ts` — журнал (electron-log) + отчёт о проблеме; см. раздел «Диагностика». `initDiag()` вызывается первой строкой в `index.ts`, `instrumentIpc()` — до `registerIpcHandlers()`, `registerDiagIpc()` — после
- `quit-guard.ts` — подтверждение при закрытии (три кнопки, sheet на окне оператора). Единая точка выхода `requestQuit()`, куда ведут и крестик окна оператора, и `before-quit`. Гард вешается **только на окно оператора** через `setOperatorWindowHook` из `windows.ts` — окна зала и суфлёра штатно пересоздаются при каждой смене раскладки, общий обработчик спрашивал бы подтверждение на каждом переключении экранов. Хук, а не прямой импорт, — чтобы не создавать цикл `windows ↔ ipc ↔ quit-guard`
- `nag-dialog.ts` — плашка поддержки при запуске (PLAN 2.12): 5 секунд без возможности закрыть, первым экраном **до** `boot-dialog`. Окон приложения на этот момент ещё нет, поэтому на зал/суфлёр вылезти не может. Пропускается при перезапуске раньше 10 минут (`lastLaunchAt`) и по `CUEDECK_NO_NAG=1`

### Preload (`src/preload/`)

`index.ts` exposes `window.api` via `contextBridge`. Full type contract is in `api.ts` (`PresenterApi`). State types (`AppState`, `PlaylistEntry`, …) live in `src/shared/types.ts` — single source of truth, re-exported by `src/main/state.ts` and `src/preload/api.ts` (renderers import from the preload module).

### Renderers (`src/renderer/`)

Two HTML entry points built by Vite:

| Entry | Roles served | Notes |
|-------|-------------|-------|
| `presenter/index.html` | `operator`, `speaker` | Distinguished by `?role=` URL param; `document.body.dataset.role` drives CSS |
| `audience/index.html` | `audience` | Fullscreen slide + blackout/keyvisual overlay only |

Shared renderer utilities (`src/renderer/shared/`):
- `bus.ts` — initialises state from `window.api.state.get()`, merges incoming `state:patch` IPC, notifies subscribers. Must call `initBus()` before any other state access.
- `pdf-loader.ts` — wraps `pdfjs-dist`; LRU offscreen canvas cache (8 entries, keyed `page@width`), in-flight deduplication, `docToken` for stale-render cancellation
- `timer.ts` — pure functions only: `elapsedMs`, `remainingMs`, `timerColor`, `formatMs`, `timerView(timer, mode)`; `startTick(interval, fn)` is a generic tick driver (250ms is the typical timer cadence)

### Data flow

```
Renderer action
  → window.api.*(...)           # contextBridge
  → ipcRenderer.invoke(channel)
  → ipcMain.handle(channel)
  → store.patch(partial)
  → webContents.send('state:patch', partial)  # to ALL windows
  → bus.ts merges patch → notifies subscribers
  → applyState() re-renders UI
```

### File format handling

- **PDF** — read bytes via `pdf:read` IPC, rendered in each window independently via pdfjs-dist
- **Image** (png/jpg/jpeg/webp/gif/bmp) — read bytes, shown via `<img>` with blob URL; `totalSlides` reported as 1
- **PPTX/PPT/ODP/KEY** — `pdf:read` returns the cached converted PDF bytes (transparent to renderer); LibreOffice required (`brew install --cask libreoffice`)
- **Video** (mp4/m4v/mov/webm) — NOT read through `pdf:read` (files can be multi-GB). Streamed over a custom `cuedeck-media://` protocol registered in `index.ts` (`handleMediaRequest`), which serves only the currently-open file with HTTP Range support so the `<video>` element can seek. `kindOf` → `'video'`; SHA1 comes from `computeStatSha1` (path+size+mtime, no full read). `totalSlides` = 1.

### Живой вход — внешний источник (2.13)

Внешняя картинка (USB-капчер HDMI, камера, айфон по Continuity) живёт в состоянии как обычный «файл» с псевдо-путём `live://device?v=<метка камеры>&a=<метка звука>` и `FileKind = 'live'` (`src/shared/live.ts`). Благодаря этому плейлист, превью, TAKE, персист и `.pdpres` работают без изменений. Устройство запоминается **меткой, а не deviceId** — id меняется при перевтыкании и рестарте.

Каждое окно открывает потоки само (`renderer/shared/live-stream.ts`): Chromium держит физическое устройство открытым один раз в capture-сервисе и раздаёт копию клиентам, поэтому эксклюзивный капчер не ломается и декод не умножается. Раздача по WebRTC не нужна.

**`LivePool` + `LiveView` — устройство удерживается постоянно.** Просьба Азата: источник занят приложением с момента добавления в плейлист и до удаления оттуда. Брать и отпускать устройство на каждое переключение превью/эфира нельзя — капчер пересогласовывает формат (секунда чёрного кадра), а Continuity-камера айфона на отпускании выходит из режима показа и сама не возвращается. Поэтому `LivePool.retain(uris)` держит потоки, а `LiveView.show(uri)` только вешает готовый поток на `<video>` через `srcObject`. Оператор удерживает **все** живые записи плейлиста плюс эфирный и превью-источники (удаление записи из списка не должно гасить то, что идёт в зал); зал и суфлёр — только эфирный.

Кто удерживает: **плейлист ∪ то, что в эфире**. Превью защиты не получает намеренно — иначе удалённая из списка запись продолжала бы держать устройство занятым из невидимого деска (`playlist:remove` дополнительно чистит превью, если оно смотрело на удалённый живой вход). Эфир защищён: удаление строки не гасит зал.

Переназначение устройств у существующей записи — `playlist:update-live` (кнопка ⚙ на карточке): меняется псевдо-путь, поэтому деки, смотрящие на старый, переводятся следом.

**Режим вписывания** (`LiveFit`: `contain` / `cover` / `fill`) — гости приносят ноуты 4:3 и 16:10. Живёт полем `liveFit` у записи плейлиста (за источником, а не глобально), правится селектором прямо на шине эфира и превью — просьбу «заполните весь экран» надо отрабатывать, не снимая источник с эфира. Поле опциональное: сохранённые до 2.13 плейлисты его не имеют, `liveFitFor()` отдаёт дефолт. Он же ищет запись сначала по playlistId, потом по пути — деск может пережить и очистку `currentPlaylistId`, и смену устройств.

Сторож в пуле (раз в 2 с): `track.readyState === 'ended'` или `track.muted` три тика подряд (ровно так выглядит «картинка замерла») → поток пересобирается; после ошибки — ретрай раз в 5 с и внеочередная попытка на `devicechange`. Поэтому воткнутый позже капчер и вернувшийся айфон подхватываются сами.

**Правила, которые нельзя нарушать:**

- Аудиообработка выключается принудительно (`echoCancellation`/`noiseSuppression`/`autoGainControl: false`) — иначе Chromium жуёт музыку как речь в мессенджере.
- Аудиодорожка берётся по роли окна (`audioRole`), НЕ по текущему mute — иначе «звук выкл» пересобирает поток и картинка в зале моргает.
- У живого входа свой счётчик `setSinkId`, отдельный от файла-видео.
- Кликер на живом входе молчит (`programNext`/`programPrev` выходят сразу) — иначе случайный клик уводил бы эфир на следующего спикера через autoAdvance.
- Blackmagic UltraStudio / DeckLink через `getUserMedia` НЕ видны (свой драйвер); ATEM Mini и Web Presenter — видны.

### Предпрослушка (SOLO/PFL) и индикаторы уровня

Два независимых аудиотракта: `audioOutputId` — **эфир** (звук зала), `previewAudioOutputId` — **предпрослушка** в наушники оператора (послушать принесённый ролик или внешний вход в превью до выдачи). `null` у предпрослушки = выключена, превью немое. Дефолта «системный выход» у неё нет **намеренно**: на площадке системный выход запросто окажется трактом зала, и превью зазвучало бы в зал.

**Грабля, оплаченная спайком: с немого `<video>` уровень звука не снимается ничем** — ни `captureStream()`, ни `createMediaElementSource` дают ровные нули (контрольный незаглушённый элемент — реальные пики). Отсюда вся конструкция измерителей:

- **живой вход** меряется по потоку с устройства из пула (`LivePool.get`) — работает всегда, элемент при этом может быть немым;
- **ролик в превью** меряется по элементу и потому показывается только при включённой предпрослушке;
- **ролик в эфире** меряет то окно, которое реально озвучивает зал (зал, а в solo — сам оператор), и шлёт число оператору по IPC `meter:report` → `meter:program-level`. Через состояние такое гнать нельзя — поток чисел 10 раз в секунду. Пакет старше 1 с считается протухшим.

`captureStream()` выбран вместо `createMediaElementSource` осознанно: это тап, он не перехватывает выход элемента. `createMediaElementSource` увёл бы звук в граф Web Audio и сломал маршрутизацию через `setSinkId`.

### PPTX: видео и анимации (`pptx-media.ts`, v0.4.0)

При открытии `.pptx` (только настоящий pptx; ppt/odp/key идут мимо) `preparePptxMedia()` разбирает zip и:

1. **Видео в слайдах (2.10):** находит `p:pic` с `a:videoFile`, извлекает ролики в `userData/pptx-cache/<sha1>.media/`, пишет manifest `<sha1>.media.json` (`{version, rebuilt, slideMedia:[{slide, rect, file}]}`; rect — доли слайда из EMU). LibreOffice получает копию с обнулёнными видеофайлами → PDF лёгкий, постеры на месте. Рендереры кладут `<video id="media-overlay">` поверх канваса по rect (общий клок `state.video`, оператор — авторитет). Раздача — `cuedeck-media://stream/slide/<deck>/<file>`. В manifest только Chromium-кодеки (mp4/m4v/mov/webm); wmv/avi стрипаются ради веса, но остаются постером.
2. **Анимации «по клику» (2.11):** парсит `p:timing` (клик-группы mainSeq), слайд с N кликами разворачивает в N+1 slide-частей (`slideN_cdS.xml` + патч presentation.xml/.rels/[Content_Types]). Скрытие «ещё не появившихся» — НЕ удаление, а невидимость: alpha-0 `solidFill` на ранах + `<a:buNone/>` (иначе плывёт раскладка/автофит). Кликер листает шаги как страницы.

3. **Заметки докладчика (2.23, 2026-09-28):** текст плейсхолдера `type="body"` из `ppt/notesSlides` (связь — rels слайда) → `pageNotes` в manifest (версия 3) по страницам PDF; слайд с шагами даёт заметку всем шагам. В `inspectFile` (ipc.ts) — `{...заметки PPTX, ...файл-спутник}`: правка оператора главнее, в том числе пустая. В спутник пишется **только своё** (`ownNotes` отбрасывает совпадающее с PPTX) — иначе копия заметок застряла бы там и перекрыла обновлённую презентацию. Манифест v2 дочитывается без пересоздания PDF.
4. **Скрытые слайды (`show="0"`) LibreOffice в PDF не выводит** — страниц, шагов, видео и заметок у них нет (до 2026-09-28 нумерация после скрытого слайда съезжала на +1 у видео и шагов).

**Механика кликера (просьба Азата, живые шоу):** в `programNext()` первый «далее» на странице с видео при позиции 0 запускает ролик, следующий листает. «Назад» всегда листает. Смена слайда сбрасывает клок (`resetProgramVideoOnSlideChange`).

**Грабли, оплаченные кровью — не переоткрывать:**

- LibreOffice ≥7.6 рендерит прозрачность текста (alpha в solidFill), но **игнорирует alpha в buClr** → буллеты глушить только `<a:buNone/>`.
- Zip local header ≠ central directory: смещения полей разные (comp/uncomp size в local — 18/22, в CD — 20/24). Симптом ошибки — unzip «mismatching local filename».
- `zlib.crc32` есть только с Node 20.15 — в модуле своя таблица CRC32 (vitest бежит на системном ноде).
- Анимации в реальных деках привязаны к **абзацам** (`spTgt` + `pRg st/end`), не к фигурам.
- Клики без entrance-целей (mediacall/exit/emphasis) шаг НЕ создают; слайд с видео не разворачивается (конфликт с клик-запуском ролика).
- Любая ошибка разбора → деградация: конвертируем оригинал без оверлеев/шагов (`try/catch` вокруг всего, тесты «деградация» это фиксируют).

**Известные хвосты:** счётчик «Слайд X из Y» считает шаги как страницы; заметки ключуются по страницам (свои заметки оператора на анимированных деках сдвигаются, если билд в PPTX поменяли); заметки из Keynote/ODP/PPT не берутся; превью-деск оверлей не показывает (постер); одно видео на слайд.

### Video playback sync

`AppState.video` (`VideoState`) is a logical playback clock shared across windows, mirroring the timer pattern — never stream `currentTime` over IPC. Fields: `playing`, `anchorSec`, `anchorAt` (wall-clock at anchor, null when paused), `durationSec`, `muted`. Current position is derived: `playing && anchorAt ? anchorSec + (now-anchorAt)/1000 : anchorSec` (see `StateStore.videoPositionSec` and `shared/video.ts videoPosition`).

- Only the **operator** issues mutations (`video:play/pause/toggle/seek/seek-by/set-duration/ended/set-muted/toggle-muted`). The operator's `<video>` is the authority for `loadedmetadata` (→ `setDuration`) and `ended` (→ pause at end).
- Each renderer reconciles its element to the clock via `syncVideoElement` on every state patch **and** on a 250/500ms tick (drift > 0.4s → hard seek; match play/pause). The tick guards against buffering drift.
- **Audio routing** (`shared/video.ts shouldMute`): only the audio role outputs sound — audience when present, else operator in solo; speaker is always muted. Plus the global `video.muted` (M key / 🔊 button) mutes the program feed.
- Operator transport bar (`#video-controls`, op-only) shows when `fileKind === 'video'`: play/pause, restart, scrub (commits seek on `change`, not `input`), time, mute. Keyboard when video is open: Space = play/pause, ←/→ = ±5s, M = mute.

### Layouts and windows

```
solo                    → [operator]
presenter-audience      → [operator, audience*]
operator-speaker-audience → [operator, speaker*, audience*]
```
`*` = fullscreen, placed on external display

`PRESENTER_DEV_TILE=1` tiles all windows on one screen in a 2×2 grid instead of sending them fullscreen to external displays.

Display → role mapping persists per display topology key (sorted display IDs joined by comma). On topology change, operator window receives `display:topology-changed` for user notification.

### Timer

`AppState.timer` has `durationMs`, `startedAt`, `elapsedMs`, `running`. Three display modes via `AppState.timerMode`:
- `countdown` — `durationMs - elapsedMs`, colored green/yellow/red by % remaining, pulses red on overtime
- `stopwatch` — counts up from 0, neutral color
- `clock` — system time, ignores timer state

`AppState.timerPosition` (`top-left`/`top-right`/`bottom-left`/`bottom-right`/`hidden`/`full`/`full-noflash`/`free`) applies only on speaker. `free` — центр в `AppState.timerFree` (доли экрана), CSS через `--timer-x/--timer-y`; ставится перетаскиванием в «Настройки → Суфлёр» — fixed-position overlay with `font-size: calc(88px * var(--timer-scale, 1))`.

**`full` / `full-noflash` — «только таймер» (2026-08-30).** Весь суфлёрский экран отдан таймеру: чёрный фон, цифры по центру, всё остальное скрыто (слайд, «Дальше», заметки, сообщение спикеру). Два состояния различаются **только** белой вспышкой на нуле (`full-noflash` её гасит — на чистом сигнале в микшер она заливает весь кадр); вёрстка общая, CSS ловит оба через `[data-timer-position^="full"]`, код — через `isFullTimer()`. Кнопка ⛶ работает не как позиция, а как тумблер: первое нажатие → `full` (кнопка синяя), следующее → `full-noflash` (зелёная), дальше по кругу; выход — любой другой кнопкой группы. Смысл — отдать этот выход по HDMI/NDI в микшер (Resolume/vMix), где его кадрируют и кладут на промптер: раньше ради таймера поднимали отдельную машину с vMix. Кегль считается от высоты экрана, но зажат по ширине через `--timer-chars` (длину строки таймера кладёт в CSS-переменную `applyTimerView`) — «−01:02:33» не уезжает за край даже на максимуме A+. **Грабля:** скрытие `.grid` не порождает `resize`, поэтому `renderCurrent()` при нулевой ширине выходит, не пометив слайд отрисованным, а `applyState` на переходе в `full` и обратно перерисовывает суфлёр принудительно — иначе возврат в угол давал пустой канвас. `AppState.timerScale` (default 1.0, range 0.5–2.5) is set as a `--timer-scale` CSS custom property on `documentElement`.

### Имена окон (`src/shared/window-titles.ts`)

Окна называются `CueDeck` (оператор), `PROMPTER - TIMER` (суфлёр), `MAIN - PRESENTATIONS` (зал) — по этим строкам окна ищут системы захвата (NDI Screen Capture, OBS, vMix Window Capture), они показывают в списке ровно заголовок окна. До 2026-08-30 оператор и суфлёр звались одинаково («CueDeck» из общего `<title>`), и различить их в списке было нельзя.

**Заголовок ставится в двух местах, и это не дублирование:** `title` в `BrowserWindow` (чтобы имя не мигало до загрузки страницы) и `document.title` в рендерере. Страница `presenter/index.html` обслуживает две роли, поэтому статический `<title>` для суфлёра не годится — а он перебивает `title` окна. Только ASCII-латиница: списки окон в чужих программах приезжают в чужой кодировке. Строки видны наружу — менять только по просьбе Азата.

### UI theme

`AppState.uiTheme` (`'dark' | 'light'`, persisted) применяется **только к окну оператора**: `body[data-theme]` + переопределение CSS-переменных палитры в style.css (`body[data-theme="light"]`). Суфлёр и зал всегда тёмные — это выходные поверхности. Переключается в «Настройки → Интерфейс». Новые цвета в operator-UI задавать через переменные палитры, тёмные хардкоды — добавлять override в светлый блок.

### Blackout & Key Visual

`AppState.blackout` is sticky — never reset by file changes (only by user). When blackout is on AND `keyVisualPath` is set, audience shows the image fullscreen with `object-fit: contain`; otherwise plain black. Key visual bytes loaded via `keyvisual:read` IPC, displayed via blob URL.

### Notes panel layout

The notes panel lives in `.sidebar` — a CSS grid with `grid-template-rows: minmax(0, 1fr) minmax(0, 1fr)`. Notes textarea has `flex: 1; height: 0; min-height: 0` — relies on flex to fill available space.

**Critical CSS rules** (do not remove):
- `.next-slide, .notes` must have `overflow: hidden` — prevents intrinsic textarea height from pushing the grid row and stealing space from next-slide panel.
- `<textarea rows="1">` in the HTML — minimises browser UA intrinsic height, important at large font sizes.

Font size is controlled via `--notes-font-size` CSS custom property set on `documentElement`, range 10–48px, persisted in `electron-store` via `AppState.notesFontSize`.

### Projects (`.pdpres`)

JSON files with `schemaVersion`, `playlist`, `keyVisualPath`.

**Пути к материалам (schema v2, 2026-08-16).** Файл, лежащий рядом с `.pdpres` (в той же папке или подпапках), сохраняется **относительным путём** — папка проекта переезжает на флешке между машинами и ОС, ничего не рассыпается. Что выше или на другом диске — остаётся абсолютным. Разделитель в относительных путях всегда `/` (проект с Windows должен открываться на маке; `resolve()` понимает оба). Живые входы (`live://…`) не трогаются. Хелперы `toStoredPath` / `fromStoredPath` в `project.ts`; старые проекты с абсолютными путями читаются без изменений.

**Перепривязка и сборка.** `project-files.ts` (без Electron, покрыт тестами): `indexFolder` — индекс папки «имя в нижнем регистре → пути» (глубина 6, потолок 50 000 файлов, скрытые папки пропускаются); `pickBestCandidate` — из одинаковых имён берёт наименее вложенный путь; `uniqueName` — разводит коллизии суффиксом `-2`. На них стоят `playlist:relink-folder` (найти все пропавшие в указанной папке) и `project:consolidate` (File → «Собрать проект в папку…»: копия всех материалов в `<папка проекта>/материалы/` + пересохранение проекта там же → самодостаточная папка под флешку). Consolidate копирует один исходник один раз (тот же ролик у двух спикеров), переносит заметки-спутники и **не** копирует их «сами в себя» у ненайденных материалов — иначе `copyFile` затрёт файл заметок.

**Пропавшие материалы.** `AppState.missingIds` — id записей, чьих файлов нет на диске. Считает `refreshMissingFiles()` в `ipc.ts`: при открытии проекта, восстановлении сессии, добавлении/удалении записей, при ошибке открытия и на `focus` окна оператора (воткнули флешку — метки обновились сами). Оператор видит красную пунктирную карточку с кнопкой «Указать файл…» (`playlist:relocate` меняет путь/имя/kind, сохраняя комментарий и таймер) и баннер «Не найдено файлов: N из M» при открытии проекта. Смысл — узнать о пропаже при подготовке, а не в момент выдачи в зал. `project:new` clears playlist/keyVisual/current file. `project:save` writes to current `projectPath` or opens dialog if null. `project:open` replaces playlist + keyVisualPath; current file is cleared (user picks an entry to activate). Menu shortcuts: Cmd+N / Cmd+S / Cmd+Shift+O / Cmd+Shift+S.

### Внешнее управление (`src/main/remote/`) — Stream Deck, Companion, OSC (PLAN 2.18)

Слушатели в main-процессе, поэтому команды доходят **при любом активном окне**. HTTP `127.0.0.1:9420` (GET/POST) — для родной программы Elgato (действие «Website» с галкой «GET request in background», без плагинов) и Companion Generic HTTP; OSC UDP `9421` — Companion Generic OSC, grandMA3, QLab. Настройки (`remote` в electron-store: enabled/httpPort/oscPort/lan/companionPush/companionHost) и живой статус (`AppState.remote`) — окно **«Настройки»** (⚙ в нижней панели / меню «Настройки…»), раздел «Внешнее управление», применяется сразу. По умолчанию выключено.

- `commands.ts` — **единая таблица команд** (без Electron, тесты `tests/remote.test.ts`). HTTP `/api/timer/add/5` и OSC `/cuedeck/timer/add 5` приходят сюда одинаковыми сегментами. Команда переводится в вызовы ipc-каналов (`timer:adjust`…), **своей логики не исполняет**. Новая команда = строка в `REMOTE_COMMANDS`; справочная страница берёт её оттуда. В README команд нет (с 2026-10-07 — README.md английский, README.ru.md русский, скриншоты в `docs/screenshots/`, снимать с вымышленных демо-слайдов в чистом профиле — как именно, `generated/readme-shots/README.md`; карточка для соцсетей `docs/screenshots/social-preview.png` загружается руками в Settings → Social preview).
- `server.ts` — `captureIpcHandlers()` (вызывается между `instrumentIpc()` и `registerIpcHandlers()`) запоминает обработчики `ipcMain.handle`, и внешний вход зовёт **те же функции, что кнопки оператора**. Команды идут строго по очереди (`restart` = reset+start, `toggle` видит результат прошлого нажатия). Без «из сети» слушаем 127.0.0.1 + ::1 и отбиваем чужой `Host`.
- `osc.ts` — свой разбор OSC 1.0 (сообщения, бандлы, i f d h s T F N), без зависимостей. У команд без аргумента OSC-аргумент `0`/`false` = «кнопку отпустили» → игнор, иначе toggle с TouchOSC срабатывал бы дважды.
- `help-page.ts` — `GET /`: готовые URL с «копировать», OSC-адреса, живой таймер (опрос `/api/state`).

**Команды эфира — сразу в эфир** (решение Азата 2026-09-24): Stream Deck — пульт оператора, как кликер. `next` идёт через `programNext` (первый «далее» на слайде с роликом его запускает). Видео-команды без ролика в эфире и `take` с пустым превью отвечают ошибкой (400 → ⚠ на кнопке), а не тихим «успехом»; ошибки обработчиков (`{ok:false}`) тоже доходят до кнопки. `playlist/next` считает от дальней из «эфир / превью»: после ЭФИРа прежний спикер уезжает в превью (обмен деками), от него считать нельзя. Номера карточек (`body.remote-on`, CSS-счётчик) = N в `playlist/select/N`.

`/api/state` — снимок состояния (таймер, эфир: слайд/всего/осталось, ролик, превью, номер в плейлисте) для чужих интеграций и будущего плагина Elgato (PLAN 2.18, шаг 3b, на паузе, кандидат в PRO).

**Companion — готовая страница (шаг 3, 2026-09-24).** CueDeck **сам толкает** состояние в custom-переменные Companion (`companion-push.ts`: `POST http://127.0.0.1:8000/api/custom-variable/<имя>/value?value=…` — встроенный HTTP API Companion, пустое значение только через `?value=`, телом Companion его отвергает). Раз в 250 мс только изменившееся, раз в 5 с всё целиком (Companion мог перезапуститься), 404 = переменных нет = страницу не импортировали → статус в «Настройки → Внешнее управление». Переменные — `companion-vars.ts` (`COMPANION_VARS`, `cuedeck_*`, флаги '1'/'0'); `cuedeck_seen` (unix-секунды) + `$(internal:time_unix)` дают «нет связи» через 10 с после падения. При выходе `companionGoodbye()` гасит таймер на кнопках.
**Модуль Companion (2026-09-25, PLAN 2.18 шаг 3c)** — `companion-module/`, самостоятельный пакет (свой package.json, Node 22: `PATH=/opt/homebrew/bin:$PATH npm run package` → `cuedeck-<версия>.tgz`; системный `/usr/local/bin/node` 20-й не годится). Опрашивает `GET /api/state` раз в 250 мс, команды — `GET /api/<путь>?value=…` (аргумент всегда в `?value=`, чтобы текст со слэшем доходил целиком). Модуль не может импортировать `REMOTE_COMMANDS`, поэтому сверка — `tests/companion-module.test.ts`: **новая команда или переименование в `commands.ts` → проверить модуль** (`companion-module/src/commands.ts`). Поля `/api/state` только добавлять — модуль у клиентов обновляется не сразу. Устройство и публикация в каталог — `companion-module/README.md`.

**Статус трансляции в Companion (2026-09-28, хвост PLAN 2.21).** И толкаемые переменные, и модуль, и готовая страница знают про стрим:
- `companion-vars.ts` — 4 новые: `cuedeck_stream_running`, `cuedeck_stream_warn`, `cuedeck_stream_live`, `cuedeck_stream_total` (площадок в эфире/включено). `warn` — только пока трансляция идёт (не «горит», если стрим выключен, а площадка осталась в статусе с прошлого раза).
- Модуль — команда `stream` (toggle/on/off → `stream/toggle` и т.д. в `commands.ts`), фидбэки `stream_running` (красный фон) и `stream_warn` (жёлтый, мигает), 4 переменные в `state.ts`, пресет «STREAM» с площадками в подписи. `s.stream` — опциональное поле (CueDeck до 0.8.1 его не отдаёт), при отсутствии — просто выключенное состояние, не падает.
- Готовая страница (`companion/build.ts`) — кнопка STREAM в ряду 1, колонка 5 (зона Stream Deck XL, core 5×3 не тронут): красная в эфире, мигает жёлтым при проблеме, внизу «живых/всего».
Страница — `companion/build.ts` → `companion/CueDeck.companionconfig` (`npm run companion:build`), JSON экспорта Companion 5.0.6, встроен в приложение через `?raw` и сохраняется кнопкой «Страница Companion…». Мануал для клиента — `companion/README.md`. **Грабли Companion 5:** кегль текста — % от высоты элемента (подписи 25–36, крупнее «Shrink to fit» режет слово пополам); `+` в выражениях складывает только числа — строки через `concat()`; `blink(500)` работает в выражении цвета фона; Full Import **заменяет** кнопки и custom-переменные (импорт рядом с чужими страницами — открытый вопрос); модуль Generic HTTP Companion докачивает сам при импорте (нужен интернет).

### Профили площадки (`profiles.ts`, `profile-core.ts`) — 2026-09-28

Снимок настроек под зал. Список в electron-store (`venueProfiles`) + файл `.cueprofile` (JSON, `kind: 'venue-profile'`, `schemaVersion`). Состав — `VenueProfileSettings` в `shared/types.ts`, разбит на 9 групп (`GROUP_KEYS` в profile-core: каждое поле ровно в одной группе — тест держит). Оператор галками выбирает группы: сохранить / обновить (merge только отмеченных) / применить (отмеченное ∩ что в профиле). Профиль без `groups` (старый) = все группы.

- **Применяет main через те же обработчики ipc**, что кнопки «Настроек» (`callIpcHandler` из `remote/server.ts`): у настроек свои побочные действия (кликер захватывает клавиши, remote перезапускает слушатели). Новая настройка площадки = поле в `VenueProfileSettings` + ключ в `GROUP_KEYS` + вызов в `applySettings`.
- Раскладка — последней и только если отличается (пересоздаёт окна); карта экранов не из профиля (id дисплеев у машин разные) — сохранённая для топологии или `autoAssignDisplays`.
- **Звук — в рендерере**: выходы видит только он, id у машины свой → в профиле `{id,label}`, ищется по имени; не нашёлся — не трогаем + ⚠.
- Не входят (решение Азата): плейлист, тема, язык, горячие клавиши, кегль заметок, путь к LibreOffice, длительность таймера.

### Трансляция RTMP/RTMPS (`src/main/stream/`, `src/renderer/stream/`) — 2026-09-28, PLAN 2.21

Без ffmpeg (DECISIONS 024): окно зала → захват вкладки (`setDisplayMediaRequestHandler` отдаёт `mainFrame` окна зала + его звук, `enableLocalEcho: true` — зал не глохнет) → **скрытое окно-кодировщик** (`renderer/stream/main.ts`: свой таймер кадров на заданную частоту, холст 16:9 с полями, WebCodecs H.264 аппаратно + AAC 48 кГц, мини-микс «эфир + пульт» через Web Audio — это потоки, не `<video>`, поэтому можно) → IPC пакетами → `streamer.ts` → FLV-теги (`flv.ts`) → свой RTMP-издатель (`rtmp.ts`, AMF0 — `amf0.ts`) → до 5 площадок одной копией.

- **Метки времени:** кодировщик считает от своего старта (`t0` в конфиге), main переводит во время трансляции; у каждой площадки своё начало с первого ключевого кадра. Звук — счётчиком сэмплов, подтягивается к часам при расхождении > 150 мс.
- **Всё медиа — одним chunk stream** (`CSID_MEDIA` в rtmp.ts, как OBS/ffmpeg): звук/видео/метаданные в разных каналах Telegram принимает, но зрителям не показывает (LESSONS 2026-09-29).
- **Медленный канал:** очередь в сокете > ~2 с потока → видео выбрасывается до ключевого кадра (звук держится дольше). Площадка отвалилась → переподключение 2/4/8/15 с, остальные не замечают.
- **solo:** трансляция держит скрытое окно зала (`createHiddenAudienceWindow`), и звук эфира играет оно — `audioRole(layout, streaming)` в `shared/video.ts`.
- **Статус** — `AppState.stream`: настройки, по площадкам цифры, `reasons` (почему мигает, с пометкой `local`/`network`/`remote` = Компьютер/Сеть/Площадка), журнал `log`. Кнопка STREAM в `.bottombar-left`, окно — `stream-ui.ts`.
- **Ключи потоков — секрет:** в журнал (`describeArgs`) и отчёт (`state.json`, `prefs.json`) идут как `***` (`hideStreamKeys` в diag.ts).
- Качество меняется только до старта; громкости и вход с пульта — на лету. Внешнее управление: `stream/toggle|on|off`, `/api/state` → `stream`.
- Звук стрима «эфир + пульт» — временный: по ТЗ Азата стрим будет брать звук с шины микшера Main или A–D (DECISIONS 025, PLAN 2.19).

### Выходы OMT (`src/main/omt/`, `src/renderer/overlay/`, `src/renderer/omt-audio/`) — 2026-10-08, PLAN 2.24

Источники Open Media Transport (MIT, от vMix) в локальной сети: vMix 29+, OBS с плагином OMT. Раздел «Настройки → Выходы OMT», кнопка OMT на нижней панели (видна, пока включён хоть один выход; красная — tally «в эфире» у vMix, зелёная — «в превью»).

- **libomt** — готовые бинарники официального релиза, в git их нет: `scripts/fetch-omt.cjs` качает zip с GitHub (sha256 сверяется) в `vendor/omt/{mac,win}` (запускается в `npm run dev` и `package:*`), в сборке — `Resources/omt` (extraResources). Привязка через **koffi** (FFI, без node-gyp; в main — external, `asarUnpack`). Грузится лениво, при первом включённом выходе; не загрузилась — выходы «недоступны», остальное работает. Журнал libomt — `<папка журналов>/omt.log`, едет в отчёт.
- **Кодек сами:** libvmx `VMX_EncodeBGRA/BGRX` → `VMX_SaveTo`, в `omt_send` уходит готовый VMX1. Сжимаем только новый кадр, повторяем сжатый с заданной частотой (свой таймер по расписанию). Отдавать libomt сырой BGRA 30 раз/с = треть ядра M-мака впустую. Кадр в байты превращается только когда кодек свободен (копия 8 МБ в main). Метки времени свои (`hrtime`/100 нс), не `-1`.
- **Таймер** — offscreen прозрачное окно `renderer/overlay` (`paint` даёт BGRA с альфой, premultiplied); размер окна = разрешение / scaleFactor.
- **Зал / суфлёр** — `beginFrameSubscription` окна роли из раскладки; нет окна — общее скрытое (`acquireGhost`/`releaseGhost` в windows.ts: одно на роль, держатели — трансляция, монитор, OMT; две регистрации роли в store перебили бы друг друга). Скрытые окна — без рамки, `useContentSize`, `enableLargerThanScreen` (иначе Windows ест 16 px, мак — заголовок).
- **Звук зала** — окно `renderer/omt-audio`: тот же захват вкладки зала, что у трансляции (`allowAudienceCapture` в streamer.ts; два захвата одной вкладки с local echo друг другу не мешают — проверено), Web Audio → 48 кГц, куски по 20 мс → IPC `omt:audio` → FPA1. Пока «Зал» со звуком включён, в solo звучит скрытое окно зала (`programCaptured()` в shared/video.ts), как при трансляции.
- Разрешение 720p/1080p/4K (смена = перезапуск выхода), частота 15–60 и звук — на лету. Tally опрашивается 5 раз/с, получатели — раз в секунду; `/api/state.omt`. Раз в 10 с при получателях в журнал: кадров от источника / сжато (мс) / отправлено — по ним видно узкое место.
- **Сеть:** OMT — unicast, каждому получателю своя копия; ролик 1080p30 ≈ 60 Мбит/с. Поиск — mDNS, приём — TCP 6400 (на Windows брандмауэр спросит при первом запуске). Wi-Fi для ролика не годится (замеры — PLAN 2.24).

### Окно «Настройки» (2026-09-24) — всё, что настраивает саму программу

Решение Азата: «всё, что связано с настройкой самой программы, — в Настройки». Модалка `#settings-modal` у оператора: разделы слева (`.settings-nav button[data-section]`), содержимое справа (`section.settings-section[data-section]`), высота постоянная. Новый раздел = кнопка + секция с тем же `data-section` + ветка в `showSettingsSection()`. Открывается ⚙️ в нижней панели и `Cmd+,` (меню «Настройки…»; раньше `Cmd+,` была «Настройка экранов»).

| Раздел | Что | Особенность |
|---|---|---|
| Профили площадки | выпадающий список профилей + галки групп (см. «Профили площадки» выше) | сразу; раскладку — с подтверждением |
| Экраны | бывшая модалка «Настройка экранов» (`#setup-section`, `buildSetupModal`) | **единственный** со своими «Отмена/Применить»: смена раскладки пересобирает окна |
| Суфлёр | макет экрана суфлёра (пропорции дисплея суфлёра): таймер тащится мышкой → `timerPosition: 'free'` + `timerFree {x,y}` (центр в долях экрана, `timer:set-free`); размер — уголок `.pt-handle` или колёсико (`timerScale`, диапазон 0.3–4); угловые кнопки ↖↗↙↘, ✥ свободно, ✕, ⛶. Там же: **цвет таймера** (`timerColor` #rrggbb | null, пресеты + «Свой…» = системная палитра через `<input type=color>`; `timerWarnColors` — жёлтый/красный в конце поверх своего цвета; на суфлёре через `--speaker-timer-*`, у оператора цвета служебные); **колонки** (`speakerLayout {sidebarPct 18–60, nextPct 15–85|null}` — границы тянутся на макете и сплиттерами на самом суфлёре, раньше жили в localStorage суфлёра — разовая миграция в `setupSpeakerSplitters`); **сообщение спикеру** (`speakerMsgLayout {pos|null, scale 0.3–3}`, `data-msg-free`, `--msg-x/y/scale`). Слои макета: границы < таймер < сообщение; в ⛶ таймер мышь не ловит, сообщение тусклое (суфлёр его прячет). Колёсико над сообщением — его размер, в остальном макете — таймер. Геометрия макета = CSS суфлёра × k (высота макета / высота экрана) — менять CSS таймера/сообщения суфлёра → менять `renderPrompterMock` | сразу |
| Кликер | «Глобально» (PgUp/PgDn системно) и «Стрелки» — переехали с панели таймера | сразу |
| Звук | бывшая модалка «Звук» (`renderAudioSection`) | сразу |
| Горячие клавиши | бывшая модалка (`renderHotkeysSection`); уход из раздела / закрытие отменяет перехват клавиши (`cancelHotkeyCapture`) | сразу |
| Интерфейс | тема оператора (радио вместо кнопки ☀️). **По умолчанию светлая** для новых установок (Азат 2026-09-24); у старых тема записана в файл настроек явно (electron-store пишет умолчания при первом запуске) — не переключаются | сразу |
| PPTX / LibreOffice | путь к soffice (`soffice:current`), «Проверить снова», «Указать папку…»; всплывающая `#lo-modal` при отсутствии осталась | сразу |
| Внешнее управление | Stream Deck / Companion / OSC | сразу |
| Выходы OMT | Таймер / Зал / Суфлёр: имя, разрешение, частота, «Звук эфира», «Сообщение спикеру на таймере»; статус второй строкой | сразу |
| MIDI | Web MIDI: входы, галки (несколько устройств), лампочка активности; выбор по **имени** (`midiInputs`, `midi:get/set-enabled`) — id портов меняется при перевтыкании | сразу; назначение команд — PLAN 2.18 шаг 5 |

**Не настройки, остаются на панелях** (управление шоу): Тик/Гонг/Повтор таймера, режимы выдачи видео/слайдов на шине превью.

Нижняя панель оператора — только ⚙️ и «?» (значки, подпись в `title`).

### Диагностика (`diag.ts`) — журнал и отчёт о проблеме

Зачем: тестеры на своих машинах ловят баги вида «нажал — не сработало», «файл добавился и не играет», промаргивание, — и это не краши, стека нет. Нужен **журнал действий**, чтобы по нему увидеть, где оборвалась цепочка «нажал → main получил → состояние изменилось → окно отработало».

**Журнал** — electron-log, файл `main.log` (ротация 5 МБ → `main.old.log`). Папка: мак `~/Library/Logs/CueDeck/` (в dev — `cue-deck`, по `app.name`), Windows `%APPDATA%\cue-deck\logs\` (проверено на шаттле 2026-10-08). Кнопка «Открыть папку журналов» в окне отчёта — чтобы не искать. Что пишется:

- **Каждый invoke из рендерера** — `instrumentIpc()` подменяет `ipcMain.handle` одной обёрткой (вместо правки 90+ хендлеров, новые каналы попадают сами): канал + аргументы (строки обрезаются, `note:update` — только slide и длина, байты не пишутся), результат `{ok:false|error}` → warn, вызов дольше 1 с → длительность (кроме каналов с системным диалогом). Read-only каналы (`*:read`, `state:get`, …) — в `QUIET_CHANNELS`, не шумят.
- **Изменения состояния** по белому списку (`project()` в diag.ts): эфир/превью, слайд, blackout, раскладка, дисплеи, таймер, плейлист.
- **Окна и дисплеи**: создание/закрытие окон по заголовку, `display-added/removed/metrics-changed`.
- **Ошибки**: `console-message` уровня warning+ из всех окон (сюда же попадают `Uncaught …` рендереров — отдельный перехват в preload не нужен), `render-process-gone` / `child-process-gone` / `did-fail-load` / `unresponsive` (eventLogger), необработанные исключения main (`errorHandler`, **без** системного диалога — молча в журнал, приложение живёт).
- **Из рендереров** через `window.api.diag.log(level, msg, data?)` — точечно там, где ошибки раньше глотались: зал пишет тайминги («pdf открыт за N мс», «слайд K отрисован за N мс» — по ним ищем промаргивание), ошибки `<video>` с `MediaError.code`, падения `applyState`/`bootstrap`.
- `soffice:` — старт/готово/ошибка конвертации с длительностью.

**Журналы эфиров** (`main/stream/streamer.ts`, 2026-09-28) — свой файл на каждую трансляцию: `<папка журналов>/streams/stream-<дата>_<время>.log` (та же папка, что и `main.log` — `logsDir()` вынесена в `diag.ts`, а не заведена отдельно). Пишется построчно тем же `note()`, что кладёт строки в окно оператора, — переживает вылет и перезапуск программы, в отличие от журнала в памяти (200 строк, теряется). Хранятся последние 30 файлов, старые подчищаются при следующем старте. На стопе — итог по каждой площадке (кадры/потери/переподключения/МБ) отдельными строками. Кнопка «Сохранить…» в окне трансляции (рядом с «Копировать») копирует файл текущего/последнего эфира на рабочий стол через `stream:save-log`. Три обрыва подряд сразу после подключения у одной площадки → отдельная строка «похоже, эфир там завершён или ключ сменился» (`noteFlapping`) вместо голого «оборвалась» на каждой попытке.

**Маркер ⚑** — оператор во время шоу жмёт `Cmd/Ctrl+Shift+M` (или Help → «Отметить момент в журнале»): строка `⚑ МАРКЕР #n` в журнале + баннер у оператора, окон нет. Хоткей в `presenter/main.ts` ловится по `e.code === 'KeyM'` до проверки `isTypingTarget` — работает на любой раскладке и из текстового поля; пункт меню с тем же акселератором может сработать параллельно, дубль в пределах 400 мс глушит `markMoment`.

**Отчёт** — Help → «Сообщить о проблеме…» (модалка `#report-modal` только у оператора): поле комментария (Cmd/Ctrl+Enter — сохранить, Esc — закрыть), список маркеров, «Сохранить отчёт» → `~/Desktop/CueDeck-report-<дата>_<время>.zip`: `report.txt` (версия, ОС, CPU/RAM, Electron, дисплеи, аптайм, комментарий, маркеры), `state.json` (AppState; текст заметок заменён длиной), `prefs.json` (electron-store), `main.log` + `main.old.log`, последние 5 файлов `streams/*.log` (журналы эфиров, см. выше), `screen-<role>.jpg` (capturePage всех активных окон, ≤1280 px). Содержимого презентаций в отчёте нет — только пути. Zip пишется своим writer'ом (deflate, без zip64) — `pptx-media.ts` умеет только перестраивать чужой архив. Автоотправки нет намеренно: на площадке интернета может не быть; Sentry/свой приёмник — следующий шаг, когда тестеров станет больше двух.

**Флаг `cleanExit`** (electron-store): false на старте, true в `requestQuit()` перед `app.exit`. Запуск с false → warn в журнале и баннер оператору «в прошлый раз закрылся аварийно». Ведётся **только в packaged-сборке**: в dev каждый рестарт electron-vite/Ctrl+C — это kill, а `process.on('SIGINT'|'SIGTERM')` в main-процессе Electron не срабатывает (проверено: обработчик не вызывается, процесс не завершается) — баннер висел бы после каждого перезапуска.

### Auto-update

`updater.ts` calls GitHub API for latest release tag, compares to `app.getVersion()` semver-style. If newer, sends `update:available` IPC to operator window → blue banner with `Скачать` (opens release URL via `external:open` → `shell.openExternal`). Check fires 5s after boot, then every 24h.

**Critical: bump version in `package.json` for every bugfix release**, otherwise installed users won't get the notification (version compare returns `0`). Workflow:
1. Bump version (0.1.2 → 0.1.3) in package.json
2. `git commit -am "Fix X" && git push`
3. `npm run package:mac && npm run package:win`
4. `git tag vX.Y.Z && git push origin vX.Y.Z`
4a. **Windows-сборка на маке требует Rosetta**: electron-builder правит CueDeck.exe (иконка, версия) через wine — x86-программу. Симптом без Rosetta: `wine64: bad CPU type in executable`. После обновления macOS проверить `arch -x86_64 /usr/bin/true`; нет — Азат ставит сам: `sudo softwareupdate --install-rosetta --agree-to-license` (2026-09-24: после macOS 27 Rosetta пропала). Собирать Windows без правки exe (`signAndEditExecutable: false`) нельзя — у exe будет иконка и подпись Electron.
**Единый формат описания релиза — решение Азата, 2026-10-20.** Ориентиры: отредактированные Азатом [v0.11.1](https://github.com/ttpa3dhuk/CueDeck/releases/tag/v0.11.1) и [v0.10.3](https://github.com/ttpa3dhuk/CueDeck/releases/tag/v0.10.3). Перед написанием читать azat-voice + humanizer. Короткое вступление без повторения подробностей списка; далее фиксированный порядок ниже. Не менять стиль от релиза к релизу. Одна функция описывается один раз, платформы указываются точно. Перед показом проверять орфографию, пробелы между словами/числами/единицами (0 минут, 128 МиБ), названия кнопок по интерфейсу и ссылки. Не обещать отсутствия ошибок по среднему FPS или по одним unit-тестам.

```markdown
Коротко: что добавили и зачем, один абзац.

## Что изменилось
### Название функции
Как пользоваться: путь в меню, действие, результат.

## Исправлено
- Конкретные исправления без повторов предыдущего раздела.

## Что пока не исправлено
Известные проблемы и непроверенные сценарии. Если таких нет, раздел пропускается.

## Если нашли проблему
Help / «Справка» → «Сообщить о проблеме…», ZIP на рабочем столе → @CueDeckSupport_Bot.
Cmd/Ctrl+Shift+M отмечает момент сбоя.

## Как поддержать CueDeck
Звезда GitHub с инструкцией Star; рекомендации и соцсети; лайк/комментарий/репост;
отзывы и воспроизводимые баги; код/перевод/документация; донат без давления.
```

В опубликованном тексте не оставлять служебные пометки и незаполненные ссылки. Блок «Скачать», таблицу файлов и ссылки на установщики в описание не добавлять: Assets уже содержит файлы (решение Азата 2026-10-20). В разделе поддержки не обещать гарантированный рейтинг или попадание в Trending за число звёзд. Эмодзи немного и по месту, без жирных подписей перед каждым пунктом и рекламных формулировок.

Протоколы, API, имена переменных — не в описание релиза. При необходимости ссылку на [инструкцию Windows](docs/windows.ru.md) включать в помощь при проблемах, без блока загрузок. CHANGELOG.md — один короткий абзац в том же духе (без жирного и тире). Текст — через `--notes-file`, править можно и после публикации: `gh release edit vX.Y.Z --notes-file …`.

5. Релиз: три zip (~370 МБ) одной командой `gh release create` не влезают в 5-минутный таймаут Bash-тула. Надёжный путь: `gh release create vX.Y.Z --draft --title "..." --notes "..."` → `gh release upload vX.Y.Z <zip>` по одному → `gh release edit vX.Y.Z --draft=false`.

### Distribution

`electron-builder` config lives in `package.json` `"build"` block. Mac builds are **ZIP only** (DMG dropped) for both arm64 and x64 with **ad-hoc signing** (`identity: "-"`). Unsigned would trigger "app is damaged" on Apple Silicon. Windows ZIP for x64 (NSIS would need wine — currently we don't need it). GitHub repo: `ttpa3dhuk/CueDeck`.

After `package:mac`, `scripts/rename-mac.cjs` renames arch suffixes to human-readable names:
```
release/CueDeck-X.Y.Z-Silicon-mac.zip  ← Mac Apple Silicon
release/CueDeck-X.Y.Z-Intel-mac.zip    ← Mac Intel
release/CueDeck-X.Y.Z-win.zip          ← Windows x64
```

### Privacy / what NOT to commit

`.gitignore` blocks `*.pdf`, `*.pptx`, `*.ppt`, `*.odp`, `*.key`, `*.notes.json`, `*.pdpres`, `pptx-cache/`, `AGENTS.md`. PPTX cache lives in `userData` outside the repo. If contributors drop test files into the project dir, they won't accidentally land in commits.

**Только локально (`.git/info/exclude`, с 2026-10-07):** `SESSION-RESUME.md`, `JOURNAL.md`, `LESSONS.md`, `DECISIONS.md`, `docs/vmix-interview.md`, `resources/`, `generated/`. Репо публичный — внутренние заметки, планы и рабочие материалы в git не класть. В коде не ссылаться на PLAN/LESSONS номерами — у читателя этих файлов нет. **Подписи коммитов тоже публичны** (GitHub показывает их у каждой папки в корне): без PLAN/LESSONS/DECISIONS/SESSION-RESUME, без «внутреннее/убрано из публичного» — только что изменилось в программе (решение Азата 2026-10-07; тогда же переписаны подписи коммитов после v0.9.0, бэкап — локальный тег `backup/pre-rewrite-2026-10-07`).

## Формат общения с Азатом

Действуют глобальные правила из `~/.Codex/AGENTS.md`: **ответ = эмодзи + жирный итог первой строкой → секции `##` с таблицами → `---` → одна строка «что дальше»**; физическое действие в реальном времени — звуковая отмашка `say -v Milena`; ASR-ошибки диктовки чинить молча; **семь раз отмерь — один раз отрежь**: до начала любой работы разобрать 2–3 способа и выбрать осознанно (выбор — Азату одной строкой), на живых системах — бэкап, сухой прогон и проверка на малом; пошло не тем путём — стоп и откат, а не заплатки и обход через права. Если глобального файла на машине нет (миник, новая машина) — эти четыре правила действуют по этому абзацу.


## Выпуск и обновление на трёх устройствах — 2026-10-24

Для подготовки/публикации CueDeck и обновления установленных копий использовать локальный скилл [cuedeck-release](/Users/azatlife/.codex/skills/cuedeck-release/SKILL.md). В нём проверенные пути Mac/Shuttle/Mini, скрипты установки и порядок проверки. После разрешённой публикации обновлять все три устройства; явное поручение установить локальную сборку допускает обновление до публикации. Не запускать packaged Mac-копии из временных папок: появляется диалог переноса в «Программы». Сначала установка, затем запуск единственной /Applications/CueDeck.app.


## Скриншоты и GIF для README — 2026-11-01

При обновлении иллюстраций README использовать локальный скилл [cuedeck-readme-media](/Users/azatlife/.codex/skills/cuedeck-readme-media/SKILL.md). В нём карта кадров, штатная заставка пустого проекта, размеры/CDP, RU/EN демо-сценарий, сборка GIF и проверка. Использовать обычный Markdown вместо HTML: редактор Азата показывал HTML-вставки кодом. Скилл содержит готовые скрипты и демо-файлы, поэтому не восстанавливать процесс из старых generated-папок.
# Проверка завершения сессии (2026-11-01)

«Завершаем сессию» = обновить контекст, commit + push результата сессии и проверить удалённые коммиты. Нужные ignored/untracked материалы и внутренние заметки требуют отдельного приватного удалённого резервирования, потому что публичный git их не содержит. Выполнять сценарий из [глобального AGENTS.md](/Users/azatlife/.codex/AGENTS.md), раздел «Завершение сессии: удалённое сохранение». Не объявлять полное сохранение, пока есть необходимые данные только на ноутбуке. Не включать чужие параллельные изменения общим add. Это не разрешение на релиз или отправку писем; настройки CueDeck по-прежнему не резервировать без отдельной просьбы.

## Обязательное завершение сессии (правило Азата, 01.11.2026)

Фразы «завершаем сессию», «закрываем сессию», «заканчиваем», «на сегодня всё» запускают весь порядок ниже без дополнительных напоминаний и разрешения на commit/push. Цель: после потери MacBook продолжить работу с другого устройства.

1. Сохранить файлы всей работы этой сессии. Перечислить затронутые зоны, репозитории и устройства; не захватывать чужие параллельные изменения общим `git add`.
2. До коммита обновить `JOURNAL.md` каждой затронутой зоны: что сделали, выяснили и решили. Обновить `SESSION-RESUME.md`: текущее состояние, незавершённое и точный следующий шаг. Все договорённости о будущем перенести в `PLAN.md`, решения в `DECISIONS.md`, костыли, ошибки, неудачные подходы и ограничения в `LESSONS.md` с причиной и способом обхода/исправления. Не оставлять существенный контекст только в переписке. Если событий для раздела нет, так и сказать, не выдумывать.
3. Проверить diff и статус, выполнить подходящие проверки. Закоммитить результат сессии во всех затронутых репозиториях и обязательно выполнить push на GitHub. Незавершённое сохранять в рабочей ветке с честным статусом. Не делать force push, reset/clean, релиз или merge под видом сохранения.
4. Если менялись файлы/сервисы Mac mini, сохранить и синхронизировать их по правилам зоны. Проверить фактические файлы и состояние затронутых сервисов на mini; не перезаписывать более свежую работу. Копия на mini не заменяет GitHub.
5. Проверить untracked и ignored: нужные заметки, локальные летописи, материалы, fixtures, скрипты, навыки и инструкции должны восстанавливаться. Секреты и внутренние материалы не публиковать; сохранить их в согласованном приватном удалённом хранилище. Проверить список/хеши и выборочное скачивание. Если места нет, согласовать его и явно назвать пробел. Настройки CueDeck сохранять только по отдельной просьбе.
6. После push выполнить fetch и подтвердить наличие созданных коммитов на нужной удалённой ветке. Учесть остаток `git status`, отдельно назвать чужие изменения. Успех команды push сам по себе не подтверждает сохранение локальных материалов.
7. Только после проверок отчитаться таблицей: GitHub (репозиторий, ветка, хеш, проверка), Mac mini (что синхронизировано и проверено либо «не затрагивали»), летопись, планы/точка продолжения, грабли/костыли, приватные резервные материалы. Дать ссылки на файлы и удалённые коммиты. Азат должен видеть, что летопись действительно обновлена.

При любом пробеле писать **«сессия сохранена не полностью»**, перечислить оставшееся только локально, причину и следующий шаг. Запрещено говорить «сессия завершена» по одному локальному сохранению, коммиту или непроверенному push. Отправка писем, публикация релиза и merge сохраняют отдельные правила разрешения.
