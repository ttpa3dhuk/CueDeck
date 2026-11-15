# Проверка общего PDF-рендера в Electron

Отдельная production-built QA-программа. Она не импортирует CueDeck main, настройки,
проект, updater или dev startup. В ней один владелец ядра и отдельные окна-получатели.
Контроль загружает настоящий PdfLoader текущей базы в независимых renderer.

```sh
node scripts/render-core-qa/build.mjs
```

Создайте локальный JSON вне Git:

```json
{
  "mode": "shared",
  "fixture": 0,
  "files": ["/private/a.pdf", "/private/b.pdf"],
  "pages": [1, 2, 3, 2, 1],
  "output": "/private/qa-results",
  "width": 960,
  "height": 540,
  "consumers": 4,
  "lifecycle": true
}
```

Из корня worktree:

```sh
env -u ELECTRON_RUN_AS_NODE ELECTRON_ENTRY=generated/render-core-qa/app/main.cjs RENDER_QA_CONFIG=/private/config.json npx electron-vite preview --skipBuild
```

Это запуск готового QA-приложения без dev/HMR. `npm run dev` не используется,
потому что stop-dev может остановить чужую рабочую сборку.

| Режим | Что проверяет |
| --- | --- |
| shared, consumers4 | Один PDF-владелец, реальные MessagePort и четыре renderer |
| independent | Независимый старый PdfLoader в каждом окне |
| shared, reference=true, consumers1, lifecycle=false | Каждая страница сравнивается с независимым прежним загрузчиком; отдельный прогон качества |
| lifecycle=true | Медленный ACK, burst, старое поколение, Preview другого PDF,720p/1080p, закрытие без ACK |

Качество: точные совпадения считаются отдельно. Небольшое отклонение допускается только
при ≤128 изменённых каналах из2 073 600 и max64/255 для кадра960×540. Это ограниченный
непобайтный результат, не pixel-perfect PASS. PNG обоих вариантов сохраняются. Белый
или частично пропавший слайд этот критерий не проходит. Предел явно записан в driver;
для другого размера/критерия приёмки его нужно пересмотреть до запуска.

`readyMs` заканчивается после рисования/ACK, `ms` включает ожидание двух RAF; группа
в main также включает SHA256 и возврат результатов. Не смешивайте эти метрики. Quality
добавляет ещё один PDF-документ, поэтому его память/время не являются benchmark ядра.

Отчёт содержит дерево процессов Electron, memory samples, PNG capturePage, RGBA SHA256
и состояние кэша/доставки после stop. Сырые PDF, картинки, конфиги и отчёты остаются
в ignored generated. Это не проверка физического телевизора или Spout receiver.

На Windows [shuttle.ps1](shuttle.ps1) копирует только известный runtime в собственную
QA-папку, использует отдельный app.asar и одноразовую Interactive ScheduledTask. Установленный
CueDeck не заменяется. Передавайте точный Root явно. Указанная через DisabledTaskToVerify
задача только читается; helper ничего не включает и не отключает. Для параметров с пробелами
используйте корректно закодированный PowerShell command, а не POSIX одинарные кавычки
в Windows cmd. Сначала inspect, затем start/monitor и cleanup. Монитор останавливает только
собственный QA-driver через abort.json при commit выше90% лимита.
