<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Aurales" width="120" />
</p>

<h1 align="center">Aurales</h1>

<p align="center">
  A modern desktop streaming catalog app with multi-provider sync, mood-based discovery, Stremio addon support, and native mpv playback.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/built_with-Tauri_2-orange?style=flat-square" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/frontend-React_19-61dafb?style=flat-square" alt="React" />
  <img src="https://img.shields.io/badge/player-mpv-purple?style=flat-square" alt="mpv" />
</p>

---



## Features

### Discovery & Search

- **Hero Banner** — rotating spotlight with ratings, synopsis, cast, and backdrop art
- **Mood-Based Discovery** — curated categories like "Heists & Cons", "Mind Benders", "Slice of Life" across Movies, Series, and Anime
- **Genre Filtering** — Adventure, Fantasy, Animation, Drama, Horror, Action, Comedy, Thriller, Sci-Fi, and more
- **Platform Filtering** — browse by streaming service (Netflix, Disney+, Prime Video, HBO Max, Hulu, Apple TV+, Crunchyroll, etc.)
- **Multi-Engine Search** — search across TMDB, TheTVDB, TVmaze, Trakt, MDBList, Cinemeta, and MAL simultaneously
- **AI-Powered Search** — natural language queries via OpenRouter (optional)
- **Region & Rating Filters** — filter by country and content certification



### Streaming & Playback

- **Stremio Addon Ecosystem** — install addons by URL for streams, metadata, subtitles, and catalogs
- **Stream Selection** — choose from multiple sources with quality, codec, audio, and file size info
- **Native mpv Player** — full-featured desktop player with hardware decoding
- **Embedded Player** — in-app overlay mode
- **Playback Controls** — speed (0.25x–2x), audio track switching, subtitle management
- **Auto Skip** — skip intros and outros automatically via IntroDB integration
- **Continue Watching** — resume from where you left off across all synced services



### Watch Tracking & Sync

Aurales syncs watch history, watchlists, and progress across multiple services:

| Service | Watch History | Watchlist | Scrobbling | Continue Watching |
|---------|:---:|:---:|:---:|:---:|
| **Simkl** | ✓ | ✓ | ✓ | ✓ |
| **Trakt** | ✓ | ✓ | ✓ | ✓ |
| **AniList** | ✓ | ✓ | — | ✓ |
| **MDBList** | ✓ | ✓ | ✓ | ✓ |
| **PMDB** | ✓ | ✓ | ✓ | ✓ |



### Library Management

- **Customizable Home Shelves** — drag-and-drop layout with hero banners, poster carousels, landscape rows, and compact lists
- **Multi-Service Collections** — browse Simkl, Trakt, AniList, and MDBList watchlists in one place
- **Shelf Management** — add, reorder, and remove shelves from your home screen



### Rich Media Details

- **Full Metadata** — ratings from multiple sources, genre tags, cast with photos, runtime, certification
- **Season & Episode Browser** — navigate seasons with episode thumbnails, descriptions, and watched status
- **Videos & Trailers** — behind-the-scenes clips and trailers inline
- **Recommendations** — "More Like This" suggestions
- **Person Pages** — cast and crew profiles with filmography



### Subtitles

- **Multi-Source Subtitles** — embedded, addon-provided, and downloadable
- **Customizable Styling** — font size, background opacity, text color
- **AI Translation** — translate subtitles in real-time via OpenRouter with context-aware lookahead

### Watch Together

- **Synchronized Viewing** — create or join rooms with shareable codes
- **Real-Time Chat** — text messaging during playback
- **Drawing Overlay** — draw on screen with live annotations
- **Playback Sync** — automatic drift correction keeps everyone in sync
- **Host Controls** — transfer host, ready checks, buffering status

### Anime Support

- **Dedicated Tracking** — separate AniList and Simkl anime sync with episode-level progress
- **Cross-ID Mapping** — automatic resolution between MAL, AniList, TMDB, and TheTVDB IDs
- **Anime Discovery** — dedicated anime tab with mood categories like "Action Packed", "Slice of Life", "Emotional Journeys"
- **Season Handling** — configurable settings for specials, unaired seasons, and Japanese titles

### Other Features

- **Discord Rich Presence** — show what you're watching in your Discord profile
- **Configuration Backup** — export and import all settings, tokens, and addon lists
- **SQLite Caching** — fast offline-first data with category-based cache management
- **Auto Updates** — in-app update checker with download progress and release notes
- **Keyboard Shortcuts** — full keyboard navigation support

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 19, TypeScript, Tailwind CSS 4 |
| Backend | Rust, SQLite (rusqlite) |
| Player | mpv (bundled) |
| State | Zustand |
| Build | Vite 8 |

## Development

```bash
# Install dependencies
npm install

# Run in development
npm run tauri dev

# Build for production
npm run tauri build
```

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://rustup.rs/) (stable)
- [mpv](https://mpv.io/) binary in `src-tauri/binaries/`

### Environment Variables

Create a `.env` file based on `.env.example` with your API keys:

- `VITE_TMDB_API_KEY` — [TMDB](https://www.themoviedb.org/settings/api)
- `VITE_TVDB_API_KEY` — [TheTVDB](https://thetvdb.com/api-information)
- `VITE_SIMKL_CLIENT_ID` — [Simkl](https://simkl.com/settings/developer/)
- `VITE_TRAKT_CLIENT_ID` / `VITE_TRAKT_CLIENT_SECRET` — [Trakt](https://trakt.tv/oauth/applications)
- `VITE_ANILIST_CLIENT_ID` / `VITE_ANILIST_CLIENT_SECRET` — [AniList](https://anilist.co/settings/developer)

## License

MIT
