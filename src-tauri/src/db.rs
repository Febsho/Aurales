use rusqlite::{Connection, Result};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_dir).ok();
        let db_path = app_dir.join("orynt.db");
        let conn = Connection::open(db_path)?;
        let db = Database {
            conn: Mutex::new(conn),
        };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS addons (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                url TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                added_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS home_rows (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                addon_id TEXT,
                catalog_type TEXT,
                catalog_id TEXT,
                layout TEXT NOT NULL DEFAULT 'poster',
                enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS watch_progress (
                id TEXT PRIMARY KEY,
                media_type TEXT NOT NULL,
                media_id TEXT NOT NULL,
                season INTEGER,
                episode INTEGER,
                progress_seconds REAL NOT NULL DEFAULT 0,
                duration_seconds REAL NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS metadata_cache (
                cache_key TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                cached_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS app_media (
                id TEXT PRIMARY KEY, media_type TEXT NOT NULL, title TEXT NOT NULL,
                original_title TEXT, localized_title TEXT, year INTEGER, overview TEXT,
                poster TEXT, backdrop TEXT, logo TEXT, genres_json TEXT, runtime INTEGER,
                rating REAL, age_rating TEXT, language TEXT, country TEXT, tmdb_id INTEGER,
                tvdb_id INTEGER, imdb_id TEXT, trakt_id INTEGER, simkl_id INTEGER,
                anilist_id INTEGER, mal_id INTEGER, source_metadata_provider TEXT NOT NULL,
                source_addon_id TEXT, raw_json TEXT NOT NULL, updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_seasons (
                id TEXT PRIMARY KEY, local_media_id TEXT NOT NULL, season_number INTEGER NOT NULL,
                title TEXT, overview TEXT, poster TEXT, episode_count INTEGER, air_date TEXT,
                is_released INTEGER DEFAULT 1, raw_json TEXT NOT NULL,
                updated_at TEXT NOT NULL, FOREIGN KEY(local_media_id) REFERENCES app_media(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_episodes (
                id TEXT PRIMARY KEY, local_media_id TEXT NOT NULL, season_id TEXT NOT NULL,
                season_number INTEGER NOT NULL, episode_number INTEGER NOT NULL,
                absolute_episode_number INTEGER, title TEXT, overview TEXT, still TEXT, air_date TEXT,
                runtime INTEGER, tmdb_id INTEGER, tvdb_id INTEGER, anilist_id INTEGER,
                is_released INTEGER DEFAULT 1,
                raw_json TEXT NOT NULL, updated_at TEXT NOT NULL,
                FOREIGN KEY(local_media_id) REFERENCES app_media(id) ON DELETE CASCADE,
                FOREIGN KEY(season_id) REFERENCES app_seasons(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS addon_media_mappings (
                id TEXT PRIMARY KEY, addon_id TEXT NOT NULL, addon_item_id TEXT NOT NULL,
                local_media_id TEXT NOT NULL, media_type TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, UNIQUE(addon_id, addon_item_id)
            );

            CREATE TABLE IF NOT EXISTS metadata_resolution_log (
                id TEXT PRIMARY KEY, addon_id TEXT, addon_item_id TEXT, local_media_id TEXT,
                status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_app_media_imdb ON app_media(imdb_id);
            CREATE INDEX IF NOT EXISTS idx_app_media_tmdb ON app_media(tmdb_id);
            CREATE INDEX IF NOT EXISTS idx_app_media_tvdb ON app_media(tvdb_id);
            CREATE INDEX IF NOT EXISTS idx_addon_mapping_lookup ON addon_media_mappings(addon_id, addon_item_id);
            CREATE INDEX IF NOT EXISTS idx_app_episodes_media_season ON app_episodes(local_media_id, season_number);
            CREATE INDEX IF NOT EXISTS idx_app_seasons_media ON app_seasons(local_media_id);
            CREATE INDEX IF NOT EXISTS idx_media_cache_updated ON app_media(updated_at);
            CREATE INDEX IF NOT EXISTS idx_watch_progress_media ON watch_progress(media_id);
            CREATE TABLE IF NOT EXISTS anime_season_mappings (
                id TEXT PRIMARY KEY, local_media_id TEXT NOT NULL, season_number INTEGER NOT NULL,
                tvdb_id INTEGER, tvdb_series_id INTEGER, tvdb_season_number INTEGER,
                anilist_id INTEGER, mal_id INTEGER, title TEXT, year INTEGER,
                relation_type TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(local_media_id, season_number)
            );

            CREATE TABLE IF NOT EXISTS anime_episode_mappings (
                id TEXT PRIMARY KEY, local_media_id TEXT NOT NULL, season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL, absolute_episode_number INTEGER,
                tvdb_episode_id INTEGER, addon_id TEXT, addon_episode_id TEXT,
                anilist_id INTEGER, mal_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(local_media_id, season_number, episode_number)
            );

            CREATE TABLE IF NOT EXISTS anime_mapping_overrides (
                id TEXT PRIMARY KEY, local_media_id TEXT NOT NULL,
                override_type TEXT NOT NULL, tvdb_series_id INTEGER,
                tvdb_order_type TEXT, anilist_id INTEGER, mal_id INTEGER,
                season_number INTEGER, note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS cache_entries (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_cache_entries_category ON cache_entries(category);
            CREATE INDEX IF NOT EXISTS idx_cache_entries_expires ON cache_entries(expires_at);

            CREATE INDEX IF NOT EXISTS idx_anime_season_map_media ON anime_season_mappings(local_media_id);
            CREATE INDEX IF NOT EXISTS idx_anime_ep_map_media ON anime_episode_mappings(local_media_id);
            CREATE INDEX IF NOT EXISTS idx_anime_override_media ON anime_mapping_overrides(local_media_id);

            CREATE TABLE IF NOT EXISTS trakt_sync (
                id TEXT PRIMARY KEY,
                sync_type TEXT NOT NULL,
                media_id TEXT NOT NULL,
                trakt_id TEXT,
                data_json TEXT,
                synced_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS favorites (
                id TEXT PRIMARY KEY,
                media_type TEXT NOT NULL,
                media_id TEXT NOT NULL,
                title TEXT NOT NULL,
                poster_url TEXT,
                added_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS recently_watched (
                id TEXT PRIMARY KEY,
                media_type TEXT NOT NULL,
                media_id TEXT NOT NULL,
                title TEXT NOT NULL,
                poster_url TEXT,
                backdrop_url TEXT,
                watched_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS sync_accounts (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                username TEXT,
                avatar TEXT,
                access_token_encrypted TEXT,
                refresh_token_encrypted TEXT,
                connected_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_sync_at TEXT
            );

            CREATE TABLE IF NOT EXISTS provider_watchlist_items (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                local_media_id TEXT NOT NULL,
                media_type TEXT NOT NULL,
                external_id TEXT,
                title TEXT NOT NULL,
                year INTEGER,
                added_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_provider_watchlist_provider ON provider_watchlist_items(provider);

            CREATE TABLE IF NOT EXISTS provider_mappings (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                local_media_id TEXT NOT NULL,
                media_type TEXT NOT NULL,
                simkl_id INTEGER,
                tmdb_id INTEGER,
                tvdb_id INTEGER,
                imdb_id TEXT,
                mal_id INTEGER,
                title TEXT,
                year INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS anime_api_mappings (
                id TEXT PRIMARY KEY,
                local_media_id TEXT NOT NULL,
                tvdb_id INTEGER,
                tmdb_id INTEGER,
                anilist_id INTEGER,
                mal_id INTEGER,
                simkl_id INTEGER,
                trakt_id INTEGER,
                kitsu_id TEXT,
                anidb_id INTEGER,
                anime_planet_id TEXT,
                confidence REAL,
                source TEXT,
                raw_json TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT
            );

            CREATE TABLE IF NOT EXISTS anime_api_episode_mappings (
                id TEXT PRIMARY KEY,
                local_media_id TEXT NOT NULL,
                tvdb_series_id INTEGER,
                tvdb_season_number INTEGER,
                tvdb_episode_number INTEGER,
                tvdb_episode_id INTEGER,
                absolute_episode_number INTEGER,
                anilist_id INTEGER,
                anilist_episode_number INTEGER,
                mal_id INTEGER,
                mal_episode_number INTEGER,
                simkl_id INTEGER,
                simkl_episode_number INTEGER,
                simkl_season_number INTEGER,
                trakt_id INTEGER,
                trakt_slug TEXT,
                trakt_season_number INTEGER,
                trakt_episode_number INTEGER,
                tmdb_id INTEGER,
                tmdb_season_number INTEGER,
                tmdb_episode_number INTEGER,
                confidence REAL,
                raw_json TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_anime_api_map_local ON anime_api_mappings(local_media_id);
            CREATE INDEX IF NOT EXISTS idx_anime_api_map_tvdb ON anime_api_mappings(tvdb_id);
            CREATE INDEX IF NOT EXISTS idx_anime_api_map_anilist ON anime_api_mappings(anilist_id);
            CREATE INDEX IF NOT EXISTS idx_anime_api_ep_map_series ON anime_api_episode_mappings(tvdb_series_id, tvdb_season_number, tvdb_episode_number);

            CREATE TABLE IF NOT EXISTS anime_provider_overrides (
                id TEXT PRIMARY KEY,
                local_media_id TEXT NOT NULL,
                season_number INTEGER,
                episode_number INTEGER,
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_season_number INTEGER,
                provider_episode_number INTEGER,
                episode_offset INTEGER,
                note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_anime_prov_override_media ON anime_provider_overrides(local_media_id);

            CREATE TABLE IF NOT EXISTS sync_items (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                external_id TEXT,
                media_type TEXT NOT NULL,
                local_media_id TEXT,
                status TEXT,
                progress REAL,
                watched_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            ",
        )?;
        Ok(())
    }
}
