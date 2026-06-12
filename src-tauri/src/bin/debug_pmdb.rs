use rusqlite::Connection;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let appdata = std::env::var("APPDATA")?;
    let db_path = PathBuf::from(appdata)
        .join("com.orynt.app")
        .join("orynt.db");

    println!("Connecting to DB: {}", db_path.display());
    let conn = Connection::open(db_path)?;

    let mut stmt = conn.prepare("SELECT id, name, url, manifest_json FROM addons")?;
    let mut rows = stmt.query([])?;

    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let url: String = row.get(2)?;
        let manifest_json: String = row.get(3)?;
        println!("\n=================================");
        println!("Addon ID: {}", id);
        println!("Name: {}", name);
        println!("URL: {}", url);
        println!("Manifest JSON: {}", manifest_json);
    }

    Ok(())
}
