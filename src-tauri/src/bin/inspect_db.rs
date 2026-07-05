use rusqlite::Connection;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let app_dir = dirs::data_dir()
        .map(|d| d.join("com.aurales.app"))
        .or_else(|| {
            let home = std::env::var("USERPROFILE").ok()?;
            Some(
                PathBuf::from(home)
                    .join("AppData")
                    .join("Roaming")
                    .join("com.aurales.app"),
            )
        })
        .expect("could not find app data dir");

    let db_path = app_dir.join("aurales.db");
    println!("Opening database at {:?}", db_path);

    if !db_path.exists() {
        println!("Database file does not exist.");
        return;
    }

    let conn = Connection::open(&db_path).expect("failed to open database");

    let report_path = PathBuf::from("C:\\Users\\justi\\.gemini\\antigravity\\brain\\9f527921-7883-43e4-9f63-df0ba057fe26\\scratch\\db_report.txt");
    let mut file = File::create(&report_path).expect("failed to create report file");

    writeln!(file, "--- ALL ADDON MAPPINGS FOR ANILIST ---").unwrap();
    let mut stmt = conn
        .prepare("SELECT addon_id, addon_item_id, local_media_id, media_type FROM addon_media_mappings WHERE addon_id = 'anilist'")
        .expect("stmt failed");
    let mut rows = stmt.query([]).expect("query failed");
    while let Some(row) = rows.next().expect("next failed") {
        let addon_id: String = row.get(0).unwrap();
        let addon_item_id: String = row.get(1).unwrap();
        let local_media_id: String = row.get(2).unwrap();
        let media_type: String = row.get(3).unwrap();
        writeln!(
            file,
            "Addon: {}, ItemID: {}, LocalID: {}, Type: {}",
            addon_id, addon_item_id, local_media_id, media_type
        )
        .unwrap();
    }

    writeln!(file, "\n--- ALL APP MEDIA ENTRIES WITH ANILIST_ID ---").unwrap();
    let mut stmt = conn
        .prepare("SELECT id, title, anilist_id, tvdb_id, tmdb_id FROM app_media WHERE anilist_id IS NOT NULL")
        .expect("stmt failed");
    let mut rows = stmt.query([]).expect("query failed");
    while let Some(row) = rows.next().expect("next failed") {
        let id: String = row.get(0).unwrap();
        let title: String = row.get(1).unwrap();
        let anilist_id: Option<i64> = row.get(2).unwrap();
        let tvdb_id: Option<i64> = row.get(3).unwrap();
        let tmdb_id: Option<i64> = row.get(4).unwrap();
        writeln!(
            file,
            "ID: {}, Title: {}, AniList: {:?}, TVDB: {:?}, TMDB: {:?}",
            id, title, anilist_id, tvdb_id, tmdb_id
        )
        .unwrap();
    }

    println!("Report written to {:?}", report_path);
}

// Minimal dirs module fallback to avoid extra dependencies
mod dirs {
    use std::path::PathBuf;
    pub fn data_dir() -> Option<PathBuf> {
        std::env::var("APPDATA").ok().map(PathBuf::from)
    }
}
