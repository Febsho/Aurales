/// Identifies the updater strategy supported by the running package.
pub fn install_kind() -> &'static str {
    #[cfg(target_os = "linux")]
    if std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists() {
        return "flatpak";
    }
    "self-updating"
}

pub fn flatpak_release_asset_url(version: &str) -> Result<String, String> {
    let valid = !version.is_empty()
        && version.len() <= 64
        && version.starts_with(|character: char| character.is_ascii_digit())
        && version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        });
    if !valid {
        return Err("The update version returned by the server is invalid.".to_string());
    }
    Ok(format!(
        "https://github.com/Febsho/Aurales/releases/download/v{version}/Aurales_{version}_amd64.flatpak"
    ))
}

/// Opens the established native video picker and returns a display-safe path.
pub fn select_local_video_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Video", &["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"])
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::flatpak_release_asset_url;

    #[test]
    fn builds_a_fixed_github_asset_url() {
        assert_eq!(
            flatpak_release_asset_url("0.2.8").unwrap(),
            "https://github.com/Febsho/Aurales/releases/download/v0.2.8/Aurales_0.2.8_amd64.flatpak"
        );
    }

    #[test]
    fn rejects_version_path_injection() {
        assert!(flatpak_release_asset_url("../../latest").is_err());
        assert!(flatpak_release_asset_url("0.2.8;rm").is_err());
    }
}
