# companion-module-cuedeck-cuedeck

[Bitfocus Companion](https://bitfocus.io/companion) module for [CueDeck](https://github.com/ttpa3dhuk/CueDeck) — presentation playout for live events. User help: [companion/HELP.md](companion/HELP.md).

The module is developed inside the CueDeck repository (`companion-module/`), where a test checks every command it can send against CueDeck's command table. This repository is a mirror of that folder, published with `git subtree`.

```bash
corepack enable
yarn install
yarn package
```

License: MIT, see [LICENSE](LICENSE).

---

## По-русски

Модуль CueDeck для Bitfocus Companion 4/5. Что умеет и как подключить — [companion/HELP.md](companion/HELP.md) (эту же справку Companion показывает у подключения).

Чем лучше готовой страницы-файла (`companion/` в репо CueDeck): кнопки берутся из вкладки **Presets** и кладутся на любую страницу рядом со своими — ничего не затирается; действия выбираются из списков, а не набираются URL; цвета и мигание — фидбеки, без выражений; переменные модуль заводит сам.

**Где живёт.** Исходник — папка `companion-module/` в репо CueDeck (`ttpa3dhuk/CueDeck`). В каталоге Bitfocus модуля пока нет — раздаём `.tgz` напрямую — см. «Поставить в Companion без каталога». Раздел «Выпуск версии» ниже оставлен на будущее.

### Как устроено

| Файл                                             | Что там                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                                    | подключение: опрос `GET /api/state` 4 раза в секунду, отправка команд `GET /api/<команда>?value=…`, статус «нет связи»                            |
| `src/commands.ts`                                | действие → команда CueDeck. Без SDK — его проверяет тест CueDeck `tests/companion-module.test.ts`: каждая команда должна быть в `REMOTE_COMMANDS` |
| `src/state.ts`                                   | ответ `/api/state` → переменные (`timer`, `slide`, `speaker_1`…). Тоже покрыт тем тестом                                                          |
| `src/actions.ts` / `feedbacks.ts` / `presets.ts` | действия, фидбеки, «книга» кнопок (RU/EN)                                                                                                         |
| `companion/manifest.json`, `HELP.md`             | паспорт модуля для Companion и справка                                                                                                            |

Модуль говорит с CueDeck по тому же HTTP API, что и родная программа Stream Deck, поэтому работает с любой версией CueDeck, где есть внешнее управление (0.7.0+). Имена спикеров, следующий спикер и тексты пресетов на кнопках — с версии после 0.8.0 (поля `playlist.names`, `next`, `timerPresets`, `messagePresets` в `/api/state`).

### Сборка

Нужны Node 22 и yarn 4 (на маке — `/opt/homebrew/bin/node`; системный `/usr/local/bin/node` 20-й не подходит; yarn приходит через corepack).

```bash
cd companion-module && PATH=/opt/homebrew/bin:$PATH corepack yarn install
```

```bash
PATH=/opt/homebrew/bin:$PATH corepack yarn package
```

Получится `cuedeck-cuedeck-<версия>.tgz`. Версия берётся из `package.json`. Проверка по правилам Bitfocus — `corepack yarn check`.

> Пустой `yarn.lock` в папке нужен: без него yarn считает модуль частью проекта CueDeck и отказывается ставить.

### Поставить в Companion без каталога

Companion → **Modules** → **Import module package** → выбрать `.tgz`. Потом **Connections** → **+ Add connection** → CueDeck. Так же модуль можно отдавать клиентам, пока он не в каталоге.

**Обновить поставленный модуль.** Ту же версию поверх Companion не ставит (молча оставляет старую) — поднять `version` в `package.json`, собрать, импортировать, потом в подключении **Module Version** ✎ → новая. Старые версии удаляются в **Modules → CueDeck** корзиной, когда ими не пользуется ни одно подключение.

**Имя подключения** = префикс переменных: `$(cuedeck:timer)`. Если в Companion уже есть подключение `cuedeck` (от страницы-файла — это Generic HTTP), новое назовётся `cuedeck_2` — пресеты это учитывают сами, а в своих кнопках писать `$(cuedeck_2:timer)`.

### Каталог Bitfocus

**Первый раз.**

1. Вступить в Slack Bitfocus (ссылка на странице bitfocus.io/companion/support), канал `#module-development`: GitHub-ник `ttpa3dhuk` и имя модуля `cuedeck-cuedeck`. Репо `bitfocus/companion-module-cuedeck-cuedeck` создают они и дают доступ.
2. Один раз в репо CueDeck:
   ```bash
   git remote add bitfocus https://github.com/bitfocus/companion-module-cuedeck-cuedeck.git
   ```
3. Дальше — как обычный выпуск версии.

**Выпуск версии** (из корня репо CueDeck, всё закоммичено):

1. Поднять `version` в `companion-module/package.json`, закоммитить.
2. Отрезать папку модуля в отдельную историю и отправить:
   ```bash
   git subtree split --prefix=companion-module -b module-release
   ```
   ```bash
   git push bitfocus module-release:main
   ```
3. Тег — **только прямо в репо Bitfocus**, не локально: в репо CueDeck уже есть свои теги `v0.1.0`…`v0.7.0`, одноимённый тег модуля с ними столкнётся.
   ```bash
   git push bitfocus module-release:refs/tags/v0.1.0
   ```
4. developer.bitfocus.io (вход через GitHub) → **My Connections** → CueDeck → **Submit Version** → выбрать тег → **Submit**. Статус «Pending» — ждать ревью волонтёров (дни–недели), замечания приходят туда же. После одобрения модуль сразу доступен в Companion 4+.
