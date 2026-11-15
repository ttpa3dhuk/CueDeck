# Проверка общего PDF-источника в настоящем CueDeck

Этот host запускает собранный `out/main/index.js` со всеми настоящими панелями,
IPC и выходами. Собственный каталог данных нужен, потому что параллельная dev
может писать своё состояние. Установленный CueDeck не заменяется.

```sh
npm run build
node scripts/product-pdf-qa/build.mjs
```

Локальный JSON, вне Git:

```json
{
  "mode": "shared",
  "output": "/private/qa-application",
  "localOutput": "/private/qa-results",
  "cdpPort": 12181,
  "inspectorPort": 12182,
  "files": ["/private/a.pdf", "/private/b.pdf"],
  "pages": [2, 3, 4, 5, 10, 20, 50, 80, 2]
}
```

```sh
env -u ELECTRON_RUN_AS_NODE ELECTRON_ENTRY=generated/product-pdf-qa/app/qa-entry.cjs CUEDECK_PRODUCT_QA_CONFIG=/private/config.json npx electron-vite preview --skipBuild
python3 scripts/product-pdf-qa/run.py /private/config.json
```

`mode=legacy` включает прежние независимые PdfLoader через диагностический
`CUEDECK_SHARED_PDF=0`. Оба варианта используют один и тот же собранный продукт.
Для проверки настоящих дисплеев задайте `tile=false`: окна размещаются штатно
по выбранным экранам. По умолчанию окна собраны рядом на одном экране для автотеста.
Завершите свой host перед следующим вариантом. `npm run dev` здесь не используется:
его stop-dev может остановить чужую dev.

Driver проверяет оператор/суфлёр/зал, Next без повторного рендера подготовленного
ключа, Preview второго PDF без подмены PGM, TAKE с наплывом и сохранением документа,
восстановление владельца после принудительного crash. Сохраняет хеши RGBA и PNG.
Время readyMs включает управление через CDP, заканчивается на drawImage/putImageData;
два RAF не входят. Это не время появления на физическом мониторе.

`reference.py CONFIG pdf-loader-HASH.js` запускается отдельно, после замеров.
Он использует независимый прежний PdfLoader в точных целых физических размерах
получателя. Дополнительный worker этого прогона нельзя включать в benchmark.
Исходный UI мог давать PDF.js дробную ширину viewport, затем обрезать canvas вниз.
Новый контракт использует целые физические размеры; сравнение с дробным viewport
не является побайтной проверкой того же растра.

На Shuttle [shuttle.ps1](shuttle.ps1) создаёт собственный runtime с отдельным
CueDeckPdfQA.exe, ASAR и read-only копиями установленных native-библиотек. Перед
start выполнить inspect. Одноразовая Interactive ScheduledTask удаляется сразу.
Monitor пишет системный commit и память/CPU только QA-процессов; при commit выше90%
создаёт stop.flag для своего host. Cleanup проверяет отсутствие QA и задачи,
службы и исходный ASAR. Указанная DisabledTaskToVerify только читается.

Конфиг Windows содержит Windows output и порты12181/12182. Для driver через SSH
используйте отдельный локальный конфиг с forwarded cdpPort/inspectorPort и localOutput.
Передача PowerShell аргументов с пробелами должна идти через EncodedCommand.

Нативные Syphon/Spout и OMT проверяются внешними SDK-приёмниками отдельно от driver.
Статус on в приложении сам по себе не доказывает получение кадра. Версия, установщики,
релиз, main/NDI/PowerPoint ветки этим QA не меняются.

## Длительный прогон на Shuttle

[soak.cjs](soak.cjs) запускается отдельным контроллером в Node-режиме своего
CueDeckPdfQA.exe. Он управляет настоящими окнами через loopback CDP и проверяет
PID, путь приложения, путь его конфигурации и SHA256 QA-payload перед командами.
Для чтения целого app.asar используется original-fs: обычный Electron fs считает
архив каталогом. Установленный ASAR только читается для сверки до/после.

Сначала запустите GUI через shuttle.ps1 с отдельным Case. В локальном JSON
Case-controller.json, вне Git, нужны output, appConfig, executable, payloadAsar,
payloadSha256, installedAsar, files из двух PDF, cdpPort и inspectorPort.
Дополнительные параметры: seconds=1800, cadenceMs=2000, swapSeconds=600,
frontSeconds=600. Все пути задаются для Windows. Копии контроллера и
[soak-memory.ps1](soak-memory.ps1) лежат в Root рядом с конфигурацией.

[soak-start.ps1](soak-start.ps1) принимает Root/Case и запускает один ограниченный
прогон через Interactive Limited ScheduledTask. Определение задачи сразу удаляется;
это не повторяющаяся автоматизация. Не зависит от работающего SSH на маке.
Короткая конфигурация с seconds=25 проверяет сам стенд до основного запуска.

Контроллер проходит PDF вперёд/назад и делает заданные прыжки. Через swapSeconds
загружает другой файл в Preview, проверяет неизменность PGM, выполняет TAKE/Fade
и очищает старое Preview. Каждый десятый шаг сверяет готовые RGBA трёх PGM-панелей.
Это проверка согласованности получателей, а не независимый эталон декодирования PDF.
Следит за исключениями, ошибками renderer, потерей процессов и перезапуском owner.
Проверяет бюджеты192МиБ/128МиБ, сам Windows остаётся с прежними настройками питания:
на время QA используется powerSaveBlocker своего процесса.

В output: status.json, steps.jsonl, quality.jsonl, metrics.jsonl, memory.jsonl
и result.json. Sampler снимает память каждые5с; при system commit выше90% создаёт
stop.flag только для своего host. Файл STOP в output останавливает контроллер.
В конце он закрывает свою GUI-копию через штатный quit guard, отвечая «без сохранения»
только на её трёхкнопочный диалог выхода, и проверяет завершение PID за 20 секунд.
Затем останавливает sampler и сверяет установленный
ASAR. Внешняя проверка SSH/Sunshine/MIDI и отсутствия собственных задач после
завершения остаётся за проверяющим. Результат считается готовым только по result.json,
не по подтверждению запуска задачи.
