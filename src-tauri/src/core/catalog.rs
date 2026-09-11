use crate::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HomeRow {
    pub id: String,
    pub title: String,
    pub addon_id: Option<String>,
    pub catalog_type: Option<String>,
    pub catalog_id: Option<String>,
    pub layout: String,
    pub enabled: bool,
    pub sort_order: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AddonRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub url: String,
    pub manifest_json: String,
    pub enabled: bool,
}

pub fn save_home_rows(db: &Database, rows: Vec<HomeRow>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM home_rows", [])
        .map_err(|error| error.to_string())?;
    for row in rows {
        conn.execute(
            "INSERT INTO home_rows (id, title, addon_id, catalog_type, catalog_id, layout, enabled, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                row.id,
                row.title,
                row.addon_id,
                row.catalog_type,
                row.catalog_id,
                row.layout,
                row.enabled as i32,
                row.sort_order,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn get_home_rows(db: &Database) -> Vec<HomeRow> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn
        .prepare("SELECT id, title, addon_id, catalog_type, catalog_id, layout, enabled, sort_order FROM home_rows ORDER BY sort_order")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(HomeRow {
                id: row.get(0)?,
                title: row.get(1)?,
                addon_id: row.get(2)?,
                catalog_type: row.get(3)?,
                catalog_id: row.get(4)?,
                layout: row.get(5)?,
                enabled: row.get::<_, i32>(6)? != 0,
                sort_order: row.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|row| row.ok())
        .collect()
}

pub fn save_addon(db: &Database, addon: AddonRecord) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO addons (id, name, version, url, manifest_json, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            addon.id,
            addon.name,
            addon.version,
            addon.url,
            addon.manifest_json,
            addon.enabled as i32,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn remove_addon(db: &Database, addon_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM addons WHERE id = ?1", [&addon_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_addons(db: &Database) -> Vec<AddonRecord> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn
        .prepare("SELECT id, name, version, url, manifest_json, enabled FROM addons")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(AddonRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                url: row.get(3)?,
                manifest_json: row.get(4)?,
                enabled: row.get::<_, i32>(5)? != 0,
            })
        })
        .unwrap()
        .filter_map(|row| row.ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_catalog_configuration_and_addons() {
        let directory = std::env::temp_dir().join(format!(
            "aurales-catalog-core-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let database = Database::new(directory.clone()).unwrap();
        let row = HomeRow {
            id: "home-1".into(),
            title: "Featured".into(),
            addon_id: Some("addon-1".into()),
            catalog_type: Some("movie".into()),
            catalog_id: Some("popular".into()),
            layout: "poster".into(),
            enabled: true,
            sort_order: 3,
        };
        let addon = AddonRecord {
            id: "addon-1".into(),
            name: "Example".into(),
            version: "1.0.0".into(),
            url: "https://example.test/manifest.json".into(),
            manifest_json: "{}".into(),
            enabled: true,
        };

        save_home_rows(&database, vec![row.clone()]).unwrap();
        save_addon(&database, addon.clone()).unwrap();
        assert_eq!(get_home_rows(&database), vec![row]);
        assert_eq!(get_addons(&database), vec![addon]);
        remove_addon(&database, "addon-1".into()).unwrap();
        assert!(get_addons(&database).is_empty());

        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
