# CueDeck

[![Release](https://img.shields.io/github/v/release/ttpa3dhuk/CueDeck)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/ttpa3dhuk/CueDeck/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run every speaker's slides at a live event from one seat — with a preview/program switcher, per-speaker timers and a confidence monitor.**

🇷🇺 [Русская версия](README.ru.md) · 📋 [What's new](CHANGELOG.md) · ⬇️ [Download](https://github.com/ttpa3dhuk/CueDeck/releases/latest)

![CueDeck operator window: speaker playlist, preview and program decks, prompter monitor, timer, notes and TAKE](docs/screenshots/operator.png)

## 💡 Why

Each speaker brings a different file — PDF, PowerPoint, Keynote, a video, their own laptop. You need to switch fast, keep each speaker on time and give them notes the audience never sees. PowerPoint Presenter View handles one deck at a time; PDF viewers have no timer and no notes.

CueDeck is built the way a video switcher works: line up all the speakers in a playlist beforehand, stage the next one in **Preview**, press **TAKE** — it goes to the hall. The audience screen never shows a file dialog.

## ✨ Features

**🎛 Show control**
- **Preview / Program** with **TAKE** (`Tab`) — cue the next file off-air while the current one stays live
- Three windows on three screens: **operator**, **prompter** (slide + next slide + notes + timer), **audience** (slide only)
- **Blackout / key visual** (`B`) — the hall sees a still or a looping video while you change files
- Global clicker — PgUp/PgDn flip slides even when CueDeck isn't focused

**🗣 Speakers**
- **Speaker playlist** — drag-and-drop, a name and a timer per speaker
- **Timer** — countdown with presets and ±1 min on the fly, stopwatch or clock; placed anywhere on the prompter, or full-screen for a separate monitor
- **Notes → prompter** in real time; PowerPoint speaker notes come in automatically
- Flash message to the speaker: "Wrap up", "Closer to the mic", or your own text

**🎞 Media**
- PDF, images, **PowerPoint / Keynote / ODP** (via LibreOffice) — embedded videos and on-click animations play
- **Videos** in the playlist, synced across windows; per-clip loop, hold on first frame
- **Photo/video lists** — one playlist row, loop or shuffle with crossfade
- **Live input** — a guest laptop over a USB HDMI capture card joins the playlist like any file
- Separate audio outputs for the hall and for headphone **cue/solo**, level meters

**📡 Streaming and control**
- **Built-in streaming** — the STREAM button sends the hall picture and sound to YouTube, VK, Telegram, up to 5 destinations at once (RTMP/RTMPS), no OBS needed
- **Stream Deck, Bitfocus Companion, OSC** — a ready-made Companion page with a live timer on the key ([setup guide, RU](companion/README.md))
- MIDI controllers

**🛟 Prep and safety**
- **Venue profiles** — all settings for a known venue in one pick
- Projects survive a move to another computer; missing files are flagged when you open the project, not on air
- Quit confirmation mid-show, problem report for testers (Help → Report a problem)

![Prompter screen: current slide, next slide, speaker notes and the countdown timer](docs/screenshots/prompter.png)

## ⬇️ Download and install

Latest version — **[GitHub Releases](https://github.com/ttpa3dhuk/CueDeck/releases/latest)**.

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 and later) | `CueDeck-<version>-Silicon-mac.zip` |
| Mac with Intel | `CueDeck-<version>-Intel-mac.zip` |
| Windows 10 / 11 | `CueDeck-<version>-win.zip` |

**macOS:** unzip and drag `CueDeck.app` to Applications. The app isn't notarized, so the first launch is right-click → **Open** → **Open**. If macOS says the app is damaged: `xattr -cr /Applications/CueDeck.app`.

**Windows:** unzip and run `CueDeck.exe`. SmartScreen will warn → **More info** → **Run anyway**.

**PowerPoint / Keynote** files need [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/) installed. PDF, images and videos work without it.

🎥 [Full walkthrough video, 40 min (in Russian)](https://www.youtube.com/watch?v=Vi5BDG_WoRg)

## 📄 Formats and devices

| What | Works | Note |
|---|---|---|
| PDF, PNG, JPG, WebP, GIF, BMP | ✅ | opens instantly |
| PPTX, PPT, ODP, Keynote | ✅ | converted once via LibreOffice, then cached; exit effects and transitions don't play |
| Video H.264 + AAC (MP4, MOV, M4V), WebM | ✅ | recommended: export to MP4 (H.264 + AAC) |
| HEVC / H.265 | ⚠️ | Mac — usually yes; Windows needs HEVC Video Extensions |
| ProRes, DNxHD | ❌ | transcode with [HandBrake](https://handbrake.fr/) |
| USB capture (UVC): Elgato Cam Link, AVMatrix, ATEM Mini, webcams | ✅ | if Photo Booth / Camera sees it, CueDeck will |
| Blackmagic DeckLink / UltraStudio | ❌ | own driver, not visible as a camera |

## ⌨️ Keyboard

Defaults below; remap in ⚙️ Settings → Keyboard shortcuts.

| Key | Action |
|---|---|
| `Tab` | **TAKE** — send preview to the hall |
| `←` `→` / `Space` / `PgUp` `PgDn` | Program: previous / next slide |
| `[` `]` | Preview: previous / next slide |
| `B` | Blackout / key visual |
| `T` / `R` | Timer start-pause / reset |
| `Cmd+,` | Settings |

## 🎛 Stream Deck and Companion

⚙️ Settings → **External control** → enable. **Command list…** opens a page with every command as a ready-to-copy URL (HTTP on port 9420, OSC on 9421). For Bitfocus Companion there's a ready-made page: Settings → **Companion page…** → import it in Companion. Step by step — [companion/README.md](companion/README.md).

## 🔧 Build from source

```bash
git clone https://github.com/ttpa3dhuk/CueDeck.git
cd CueDeck
npm install
npm run dev           # development mode
npm test              # tests
npm run package:mac   # Mac zips (Apple Silicon + Intel)
npm run package:win   # Windows zip
```

Electron + TypeScript. Found a bug — [open an issue](https://github.com/ttpa3dhuk/CueDeck/issues/new/choose); Help → Report a problem saves a zip with logs you can attach.

## ☕ Support

CueDeck is free and built in spare time. If it saved your show — [buy me a coffee via CloudTips](https://pay.cloudtips.ru/p/b79fa042).

## 📄 License

[MIT](LICENSE) © 2026 [Azat Khusaenov](https://github.com/ttpa3dhuk)
