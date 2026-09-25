## CueDeck

[CueDeck](https://github.com/ttpa3dhuk/CueDeck) is a free presentation playout for live events: speaker playlist, preview / program, timer and messages on the confidence monitor, video, blackout (macOS / Windows).

The module controls CueDeck from Stream Deck and shows its state on the buttons: the running timer that flashes when time is over, slide counter, what is in preview, the next speaker, video time left, tally on speaker buttons.

### Setup

1. **CueDeck:** ⚙ button at the bottom → **External control** → ☑ **Enable**. The status line should read `● Running — 127.0.0.1 · HTTP 9420 · OSC 9421`. (CueDeck 0.7.0 is Russian-only: «Внешнее управление» → «Включить»; the interface language is in ⚙ Settings → Interface from the next version.)
2. **Companion:** add the **CueDeck** connection. Same computer — leave `127.0.0.1` / `9420`.
3. Open **Presets → CueDeck** and drag the buttons you need onto a page.

**Companion on another computer:** in CueDeck also tick ☑ **From network**; in the connection enter the IP of the CueDeck computer.

### Presets

| Section         | Buttons                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Timer           | start/pause with live time (colour as on the monitor, flashes after zero), start, pause, restart, reset, ±1 / ±5 min, 5 / 10 / 15 / 20 min, presets 1–4 from CueDeck, “timer only” ⛶, mode |
| Program         | NEXT with slide counter (amber on the last slide), BACK, TAKE with preview name, BLACKOUT, “on air” display                                                                                |
| Video on air    | play/pause with time left, from start, stop, ±10 s, sound on/off, loop                                                                                                                     |
| Playlist        | next / previous speaker into preview, speaker 1–8 into preview or straight on air — red when on air, green when in preview                                                                 |
| Speaker message | presets 1–4 (text from CueDeck), clear                                                                                                                                                     |
| Preview         | slide ▶ / ◀, video, clear                                                                                                                                                                  |

Preset button language (English by default, or Russian) — in the connection settings.

### Actions, feedbacks, variables

- **Actions** cover every CueDeck command. For anything not listed use **Custom command** with a path from CueDeck → ⚙ Settings → External control → **Command list…**, e.g. `timer/set/20`.
- **Feedbacks:** no connection, timer colour, time is over (blink), timer running, “timer only”, blackout, video playing, muted, loop, message shown, last slide, preview loaded, entry N on air / in preview.
- **Variables:** `$(cuedeck:timer)`, `$(cuedeck:slide)`, `$(cuedeck:preview)`, `$(cuedeck:next)`, `$(cuedeck:video_remaining)`, `$(cuedeck:speaker_1)`… — full list in **Variables → cuedeck**.

Program commands go **straight to the audience screen**, like the clicker.

---

## CueDeck (по-русски)

Модуль управляет CueDeck со Stream Deck и показывает его состояние на кнопках: живой таймер с миганием после нуля, счётчик слайдов, что в превью, следующий спикер, остаток ролика, красный/зелёный на кнопках спикеров (эфир / превью).

**Подключение:** в CueDeck ⚙ Настройки → **Внешнее управление** → ☑ **Включить**. В Companion добавить подключение **CueDeck** (на этом же компьютере ничего не менять). Дальше **Presets → CueDeck** — перетащить нужные кнопки на страницу. Язык подписей на кнопках пресетов — в настройках подключения.

**Companion на другом компьютере:** в CueDeck ещё ☑ **Из сети**, в подключении — IP компьютера с CueDeck.

Команда, которой нет в списке действий, — действие **Custom command** и путь из CueDeck → ⚙ Настройки → Внешнее управление → **Список команд…** (например `timer/set/20`).

Команды эфира идут **сразу в зал**, как с кликера.
