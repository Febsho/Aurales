<p align="center">
  <img src="./public/app-logo.png?raw=true&v=3" alt="Aurales" width="120" />
</p>

<h1 align="center">Aurales</h1>

<p align="center">
  A modern, high-performance desktop streaming catalog app with multi-provider watch tracking sync, mood-based discovery, Stremio addon support, and native mpv playback.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.8-white?style=flat-square" alt="Version 0.2.8" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue?style=flat-square" alt="Windows and Linux" />
  <img src="https://img.shields.io/badge/built_with-Tauri_2-orange?style=flat-square" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/frontend-React_19-61dafb?style=flat-square" alt="React" />
  <img src="https://img.shields.io/badge/player-mpv-purple?style=flat-square" alt="mpv" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

Aurales is an elegant, offline-first desktop media hub that aggregates streaming metadata, handles watch status synchronization across major tracking services, supports the extensive Stremio addon ecosystem for streaming links, and utilizes a highly optimized embedded or native **mpv** window for flawless playback.

## Download & Install

Download version **0.2.8** from the [GitHub Releases](https://github.com/Febsho/Aurales/releases) page.

### Version 0.2.8 highlights

- New ranked and feature poster rows with theme-controlled inline trailer previews.
- Redesigned Watch Together entry page, navigation integration, and more reliable host/guest synchronization.
- TorBox debrid integration and improved stream preparation for faster playback starts.
- Stremio watch history, continue-watching, and library synchronization.
- More resilient personalized Discovery with bounded caches and automatic recovery from corrupted or oversized saved data.
- In-app AppImage and standalone Flatpak update installation with visible download progress.

### Windows

Download and run the NSIS setup file ending in `-setup.exe` (recommended). The `.msi` installer remains available for managed or enterprise installations.

### Linux

Aurales publishes two Linux downloads for x86-64 systems:

- **Flatpak bundle** — recommended for the most consistent installation across distributions.
- **AppImage** — portable and does not need a traditional installation.

#### Flatpak (all distributions)

Install Flatpak first if it is not already available:

**Ubuntu / Debian**

```bash
sudo apt update
sudo apt install flatpak curl
```

**Fedora**

```bash
sudo dnf install flatpak curl
```

**Arch Linux / EndeavourOS / Manjaro**

```bash
sudo pacman -S flatpak curl
```

**openSUSE**

```bash
sudo zypper install flatpak curl
```

Download and install Aurales directly from GitHub:

```bash
curl -fL \
  https://github.com/Febsho/Aurales/releases/download/v0.2.8/Aurales_0.2.8_amd64.flatpak \
  -o Aurales_0.2.8_amd64.flatpak
flatpak install --user -y ./Aurales_0.2.8_amd64.flatpak
flatpak run com.aurales.app
```

To update, run the download and `flatpak install --user` commands again with the new version number.

#### AppImage

The AppImage includes **mpv, libmpv, FFmpeg, and yt-dlp**. No system media
packages are required. If it reports that FUSE is missing, install `libfuse2`
on Debian and older Ubuntu releases, `libfuse2t64` on current Ubuntu releases,
`fuse-libs` on Fedora, or `fuse2` on Arch-based distributions.

Download Aurales directly from GitHub, install it for your user, and launch it:

```bash
mkdir -p ~/.local/bin
curl -fL \
  https://github.com/Febsho/Aurales/releases/download/v0.2.8/Aurales_0.2.8_amd64.AppImage \
  -o ~/.local/bin/aurales
chmod +x ~/.local/bin/aurales
~/.local/bin/aurales
```

To update the AppImage, run the `curl` command again with the new version number.

AppImage and Flatpak provide broad Linux coverage without publishing a separate package for every distribution. Native `.deb`, `.rpm`, Snap, and AUR packages can be added later if there is demand for package-manager integration.

## Features

### 🔍 Discovery & Search
- **Spotlight Hero Banner** — Rotating spotlight with user/critic ratings, detailed synopsis, cast lists, and backdrop art.
- **Mood-Based Discovery** — Curated categories (e.g., *"Heists & Cons"*, *"Mind Benders"*, *"Slice of Life"*) for Movies, Series, and Anime.
- **Advanced Filtering** — Narrow down by genre (Adventure, Fantasy, Horror, Sci-Fi, etc.) or by streaming network/platform (Netflix, Disney+, Prime Video, HBO Max, Crunchyroll, etc.).
- **Multi-Engine Search** — Query TMDB, TheTVDB, TVmaze, Trakt, MDBList, Cinemeta, and MyAnimeList (MAL) simultaneously.
- **AI-Powered Search** — Optional natural language query interpretation powered by OpenRouter AI.

### 🎬 Streaming & Playback
- **Stremio Addon Ecosystem** — Install community addons via URL to fetch streams, additional catalogs, metadata, and subtitles.
- **Stream Selection** — Choose from multiple available streams with quality, codec, audio channels, and file size details.
- **Native & Embedded mpv Player** — Full-featured desktop player with hardware acceleration, available as an inline embedded window or standard external overlay.
- **Intro/Outro Auto-Skip** — Skip intros and credits automatically using integration with the crowd-sourced **IntroDB** database.
- **Resume Playback** — Keep track of your progress and resume from where you left off across all media.

### 🔄 Watch Tracking & Sync
Aurales synchronizes your watch history, watchlist, rating, and current progress across multiple tracking providers:

| Service | Watch History | Watchlist | Scrobbling | Continue Watching |
| :--- | :---: | :---: | :---: | :---: |
| **Simkl** | ✓ | ✓ | ✓ | ✓ |
| **Trakt** | ✓ | ✓ | ✓ | ✓ |
| **AniList** (Anime) | ✓ | ✓ | ✓ | ✓ |
| **MDBList** | ✓ | ✓ | ✓ | ✓ |
| **PMDB** | ✓ | ✓ | ✓ | ✓ |

### 📂 Library & Layout customization
- **Customizable Home Shelves** — Drag-and-drop rows to curate your home screen (spotlight banners, poster carousels, landscape episode rows, compact lists).
- **Shelf Management** — Add, remove, rename, and reorder shelves directly from the settings.
- **Unified Library** — Browse watchlists and custom collections from all synced accounts in one interface.

### 💬 Watch Together (Co-Viewing)
- **Synchronized Viewing** — Create or join co-watching rooms using simple invite codes.
- **Real-Time Interactive Chat** — Text chat with overlay bubbles during playback.
- **Drawing Canvas** — Live drawing and annotation overlay directly onto the video screen for all participants.
- **Drift Correction** — Under-the-hood synchronization that adjusts playback speed to correct for latency and keep everyone in sync.

### 🌟 Anime Support
- **Dedicated Anime Mode** — Sync watch progress with AniList and Simkl with episode-level precision.
- **Cross-ID Resolution** — Automatic mapping between MAL, AniList, TMDB, and TheTVDB identifiers.
- **Moods & Season Handler** — Anime-specific discovery tabs and configuration for specials, ova, or unaired seasons.

### 🛠️ Subtitles & Real-Time AI Translation
- **Multi-Source Subtitles** — Select from embedded tracks, addon-provided subtitle catalogs, or download external SRT files.
- **Real-Time AI Translation** — Translate any active subtitle track on the fly into your target language using OpenRouter models (e.g., Gemini, LLaMA) with context-aware lookahead.

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Desktop Framework** | [Tauri 2](https://v2.tauri.app/) (Rust + TypeScript) |
| **Frontend UI** | React 19, Tailwind CSS 4, Zustand 5, React Router 7 |
| **Build System** | Vite 8, TypeScript |
| **Media Player** | Native mpv + libmpv FFI (bundled in Windows, AppImage, and Flatpak releases) |
| **Database & Cache** | SQLite (via rusqlite, static/bundled build) |

---

## Companion Watch Together Server

Aurales uses a lightweight WebSocket room coordinator server to manage co-watching rooms.

The server source code is located in the [watch-together-server](./watch-together-server) subdirectory.

### Running it locally:
```bash
cd watch-together-server
npm install
npm run dev
```
The server will boot at `http://localhost:3009` with WebSockets active at `ws://localhost:3009/ws`.

For detailed deployment guides (Docker, Nginx reverse proxy, HTTPS Certbot, and Oracle cloud firewall setup), refer to the [Watch Together Server README](./watch-together-server/README.md).

---

## Application Paths & Troubleshooting

- **App Database & Settings Cache**:
  - Windows: `%APPDATA%/com.aurales.app/`
  - Linux: `~/.local/share/com.aurales.app/`
- **Player Debug Logs**:
  - Located in `player_debug.log` at the root of the app directory during development. Helpful if you encounter subtitle rendering or video decoding issues.
- **Build Logs**:
  - `tauri-build.stdout.log` and `tauri-build.stderr.log` contain outputs from compiler stages.

---

## Building from Source

Requirements:

- Node.js LTS and npm
- Rust stable
- Tauri 2 system dependencies for your platform
- Linux: WebKitGTK 4.1 development packages, mpv/libmpv, FFmpeg, and the standard GTK build toolchain

```bash
npm ci
npm run build
npm run tauri build
```

Linux release bundles can be built with:

```bash
npm run tauri build -- --config src-tauri/tauri.linux.conf.json
```

Tagged releases are created by pushing a tag such as `v0.2.8`. The release workflow keeps the existing Windows NSIS/MSI outputs and publishes only AppImage and Flatpak for Linux. The Debian package produced in CI is an internal Flatpak assembly input and is not uploaded.

---

## License

This project is licensed under the [MIT License](./LICENSE) - see the file for details.
