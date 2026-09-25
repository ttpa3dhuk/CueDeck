# companion-module-cuedeck

Модуль CueDeck для [Bitfocus Companion](https://bitfocus.io/companion) 4/5. Что умеет и как подключить — [companion/HELP.md](companion/HELP.md) (эту же справку Companion показывает у подключения).

Чем лучше готовой страницы-файла (`../companion/`): кнопки берутся из вкладки **Presets** и кладутся на любую страницу рядом со своими — ничего не затирается; действия выбираются из списков, а не набираются URL; цвета и мигание — фидбеки, без выражений; переменные модуль заводит сам.

## Как устроено

| Файл | Что там |
|---|---|
| `src/main.ts` | подключение: опрос `GET /api/state` 4 раза в секунду, отправка команд `GET /api/<команда>?value=…`, статус «нет связи» |
| `src/commands.ts` | действие → команда CueDeck. Без SDK — его проверяют тесты CueDeck (`../tests/companion-module.test.ts`): каждая команда должна быть в `REMOTE_COMMANDS` |
| `src/state.ts` | ответ `/api/state` → переменные (`timer`, `slide`, `speaker_1`…). Тоже покрыт тестами CueDeck |
| `src/actions.ts` / `feedbacks.ts` / `presets.ts` | действия, фидбеки, «книга» кнопок (RU/EN) |
| `companion/manifest.json`, `HELP.md` | паспорт модуля для Companion и справка |

Модуль говорит с CueDeck по тому же HTTP API, что и родная программа Stream Deck, поэтому работает с любой версией CueDeck, где есть внешнее управление (0.7.0+). Имена спикеров, следующий спикер и тексты пресетов на кнопках — с версии после 0.7.0 (поля `playlist.names`, `next`, `timerPresets`, `messagePresets` в `/api/state`).

## Сборка

Нужен Node 22 (на маке — `/opt/homebrew/bin/node`; системный `/usr/local/bin/node` 20-й не подходит).

```bash
cd companion-module && PATH=/opt/homebrew/bin:$PATH npm install
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run package
```

Получится `cuedeck-<версия>.tgz`. Версия берётся из `package.json`.

## Поставить в Companion без каталога

Companion → **Modules** → **Import module package** → выбрать `cuedeck-<версия>.tgz`. Потом **Connections** → **+ Add connection** → CueDeck. Так же модуль можно отдавать клиентам, пока он не в каталоге Bitfocus.

**Обновить поставленный модуль.** Ту же версию поверх Companion не ставит (молча оставляет старую) — поднять `version` в `package.json`, собрать, импортировать, потом в подключении **Module Version** ✎ → новая. Старые версии удаляются в **Modules → CueDeck** корзиной, когда ими не пользуется ни одно подключение.

**Имя подключения** = префикс переменных: `$(cuedeck:timer)`. Если в Companion уже есть подключение `cuedeck` (от страницы-файла — это Generic HTTP), новое назовётся `cuedeck_2` — пресеты это учитывают сами, а в своих кнопках писать `$(cuedeck_2:timer)`.

## Публикация в каталог Bitfocus

1. Попросить репозиторий `companion-module-cuedeck` в Slack Bitfocus, канал `#module-development` (имя согласовать там же).
2. Перенести папку в тот репозиторий (`git subtree split --prefix=companion-module`), завести yarn 4 (`corepack enable`, `yarn install`) — их проверки собирают модуль через yarn.
3. Developer Portal (developer.bitfocus.io, вход через GitHub) → git-тег `v0.1.0` → ревью волонтёрами (дни–недели).
