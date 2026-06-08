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
            ",
        )?;
        Ok(())
    }
}
