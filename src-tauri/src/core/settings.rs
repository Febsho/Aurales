use crate::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

pub fn get_setting(db: &Database, key: String) -> Option<String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| {
        row.get(0)
    })
    .ok()
}

pub fn set_setting(db: &Database, key: String, value: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [&key, &value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_all_settings(db: &Database) -> Vec<Setting> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn.prepare("SELECT key, value FROM settings").unwrap();
    statement
        .query_map([], |row| {
            Ok(Setting {
                key: row.get(0)?,
                value: row.get(1)?,
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
    fn persists_and_lists_existing_setting_records() {
        let directory = std::env::temp_dir().join(format!(
            "aurales-settings-core-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let database = Database::new(directory.clone()).unwrap();

        set_setting(&database, "theme".into(), "dark".into()).unwrap();
        set_setting(&database, "theme".into(), "system".into()).unwrap();
        assert_eq!(
            get_setting(&database, "theme".into()),
            Some("system".into())
        );
        assert_eq!(
            get_all_settings(&database),
            vec![Setting {
                key: "theme".into(),
                value: "system".into(),
            }]
        );

        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
