<p align="center">
  <img src="./public/app-logo.png?raw=true&v=3" alt="Aurales" width="120" />
</p>

<h1 align="center">Aurales</h1>

<p align="center">
  A modern, high-performance desktop streaming catalog app with multi-provider watch tracking sync, mood-based discovery, Stremio addon support, and native mpv playback.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/built_with-Tauri_2-orange?style=flat-square" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/frontend-React_19-61dafb?style=flat-square" alt="React" />
  <img src="https://img.shields.io/badge/player-mpv-purple?style=flat-square" alt="mpv" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

Aurales is an elegant, offline-first desktop media hub that aggregates streaming metadata, handles watch status synchronization across major tracking services, supports the extensive Stremio addon ecosystem for streaming links, and utilizes a highly optimized embedded or native **mpv** window for flawless playback.

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
| **Media Player** | Native mpv (bundled sidecar) + libmpv FFI |
| **Database & Cache** | SQLite (via rusqlite, static/bundled build) |

---

## Development Setup

Follow these steps to set up Aurales locally for development.

### 1. Prerequisites
- **Node.js** (LTS version recommended)
- **Rust** (stable toolchain)
- **7-Zip** (required for automated binary downloads on Windows; make sure `7z.exe` is in your PATH or installed in standard program files)

### 2. Clone and Install Dependencies
```bash
git clone https://github.com/Febsho/Aurales.git
cd aurales-app
npm install
```

### 3. Setup Sidecar Binaries (Crucial)
Tauri relies on external helper executables (sidecars) to drive video playback and resolve stream links. These **must** be placed in the `src-tauri/binaries/` directory with correct target triples before building or running.

#### Windows (Automated)
Run the bundled script to automatically fetch and configure `mpv.exe`, `libmpv-2.dll`, `yt-dlp.exe`, and `ffmpeg.exe` from official releases:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-binaries.ps1
```

#### Manual / Non-Windows
If you are setting this up manually, you need to download and rename the binaries inside `src-tauri/binaries/`:
1. **mpv**: Download the binary for your platform. Rename it to match your target triple (e.g. `mpv-x86_64-pc-windows-msvc.exe` or `mpv-aarch64-apple-darwin`).
2. **libmpv-2.dll** (Windows-only): Required for the inline embedded player mode. Download `libmpv-2.dll` (from dev builds of mpv) and place it in the binaries folder.
3. **yt-dlp**: Download the executable and rename it to match your target triple (e.g. `yt-dlp-x86_64-pc-windows-msvc.exe`).
4. **ffmpeg** (Optional): Place `ffmpeg` or `ffmpeg.exe` in the binaries directory to enable local video thumbnail generation.

### 4. Configure Environment Variables
Copy `.env.example` to `.env.local` and add your client keys:
```bash
cp .env.example .env.local
```
Fill in the API keys for the services you wish to use:
- `VITE_TMDB_API_KEY` — Movie and Series metadata
- `VITE_TVDB_API_KEY` — Alternative TV metadata and episode listings
- `VITE_TRAKT_CLIENT_ID` / `VITE_TRAKT_CLIENT_SECRET` — Trakt watch history sync
- `VITE_SIMKL_CLIENT_ID` / `SIMKL_CLIENT_SECRET` — Simkl watch history sync
- `VITE_ANILIST_CLIENT_ID` / `VITE_ANILIST_CLIENT_SECRET` — AniList anime tracking
- **OpenRouter AI Keys** (Optional) can be added directly inside the application's account settings tab.

### 5. Running the App
Start the Vite dev server and Tauri window:
```bash
npm run tauri dev
```

To compile production-ready MSI/NSIS installers:
```bash
npm run tauri build
```

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
- **Player Debug Logs**:
  - Located in `player_debug.log` at the root of the app directory during development. Helpful if you encounter subtitle rendering or video decoding issues.
- **Build Logs**:
  - `tauri-build.stdout.log` and `tauri-build.stderr.log` contain outputs from compiler stages.

---

## License

This project is licensed under the [MIT License](./LICENSE) - see the file for details.
