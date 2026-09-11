use std::io::Read;

fn safe_subtitle_name(file_name: &str) -> String {
    let cleaned: String = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "subtitle.srt".to_string()
    } else {
        cleaned
    }
}

fn cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("aurales-subtitles")
}

pub fn download(url: String, file_name: String) -> Result<String, String> {
    let response = ureq::get(&url)
        .set("Accept", "text/vtt, application/x-subrip, text/plain, */*")
        .call()
        .map_err(|error| format!("Subtitle download failed: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(10 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read subtitle: {error}"))?;
    if bytes.is_empty() {
        return Err("Subtitle provider returned an empty file.".to_string());
    }
    let directory = cache_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create subtitle cache: {error}"))?;
    let path = directory.join(format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        safe_subtitle_name(&file_name)
    ));
    std::fs::write(&path, bytes).map_err(|error| format!("Failed to cache subtitle: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn write_temp(content: String, extension: String) -> Result<String, String> {
    if content.trim().is_empty() {
        return Err("Translated subtitle content is empty.".to_string());
    }
    let extension: String = extension
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let extension = if extension.is_empty() {
        "srt"
    } else {
        extension.as_str()
    };
    let directory = cache_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create subtitle cache: {error}"))?;
    let path = directory.join(format!(
        "translated-{}.{}",
        chrono::Utc::now().timestamp_millis(),
        extension
    ));
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| format!("Failed to write translated subtitle: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn validate_cache_path(path: &str) -> Result<std::path::PathBuf, String> {
    let candidate = std::path::PathBuf::from(path);
    if candidate.parent() == Some(cache_dir().as_path()) {
        Ok(candidate)
    } else {
        Err("Subtitle file is outside Aurales' temporary cache.".to_string())
    }
}

pub fn read_temp(path: String) -> Result<String, String> {
    let path = validate_cache_path(&path)?;
    std::fs::read_to_string(path).map_err(|error| format!("Failed to read subtitle cache: {error}"))
}

pub fn update_temp(path: String, content: String) -> Result<(), String> {
    let path = validate_cache_path(&path)?;
    std::fs::write(path, content.as_bytes())
        .map_err(|error| format!("Failed to update subtitle cache: {error}"))
}

pub fn extract_embedded(url: String, sub_index: u32) -> Result<String, String> {
    let ffmpeg = crate::thumbnails::find_ffmpeg();
    let mut command = std::process::Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error");
    if url.starts_with("http://") || url.starts_with("https://") {
        command
            .arg("-seekable")
            .arg("1")
            .arg("-rw_timeout")
            .arg("30000000");
    }
    command
        .arg("-i")
        .arg(&url)
        .arg("-map")
        .arg(format!("0:s:{sub_index}"))
        .arg("-c:s")
        .arg("srt")
        .arg("-f")
        .arg("srt")
        .arg("pipe:1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg subtitle extract failed: {}",
            stderr.lines().last().unwrap_or("unknown error")
        ));
    }
    let srt = String::from_utf8_lossy(&output.stdout).to_string();
    if srt.trim().is_empty() {
        return Err("No subtitle data extracted from the source track.".to_string());
    }
    Ok(srt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_safe_file_name_and_cache_path_rules() {
        assert_eq!(safe_subtitle_name("A title: 1.srt"), "A_title__1.srt");
        assert_eq!(safe_subtitle_name(""), "subtitle.srt");
        assert!(validate_cache_path("/tmp/not-aurales.srt").is_err());
    }
}
