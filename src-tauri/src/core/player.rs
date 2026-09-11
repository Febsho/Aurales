use std::path::PathBuf;

pub fn stable_stream_hash(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(target_os = "windows")]
const MPV_BINARY_NAMES: &[&str] = &["mpv.exe", "mpv-x86_64-pc-windows-msvc.exe"];
#[cfg(target_os = "linux")]
const MPV_BINARY_NAMES: &[&str] = &["mpv", "mpv-x86_64-unknown-linux-gnu"];
#[cfg(target_os = "macos")]
const MPV_BINARY_NAMES: &[&str] = &["mpv", "mpv-aarch64-apple-darwin", "mpv-x86_64-apple-darwin"];

#[cfg(target_os = "windows")]
const YTDLP_BINARY_NAMES: &[&str] = &["yt-dlp.exe", "yt-dlp-x86_64-pc-windows-msvc.exe"];
#[cfg(target_os = "linux")]
const YTDLP_BINARY_NAMES: &[&str] = &["yt-dlp", "yt-dlp-x86_64-unknown-linux-gnu"];
#[cfg(target_os = "macos")]
const YTDLP_BINARY_NAMES: &[&str] = &[
    "yt-dlp",
    "yt-dlp-aarch64-apple-darwin",
    "yt-dlp-x86_64-apple-darwin",
];

fn binary_candidates(names: &[&str]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            for name in names {
                candidates.push(directory.join(name));
                candidates.push(directory.join("binaries").join(name));
            }
        }
    }
    for name in names {
        candidates.push(PathBuf::from("src-tauri").join("binaries").join(name));
    }
    candidates
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

pub fn mpv_candidates() -> Vec<PathBuf> {
    binary_candidates(MPV_BINARY_NAMES)
}

pub fn find_mpv() -> Option<PathBuf> {
    if let Some(found) = mpv_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
    {
        return Some(found);
    }
    #[cfg(not(target_os = "windows"))]
    {
        return find_in_path("mpv");
    }
    #[cfg(target_os = "windows")]
    None
}

pub fn find_ytdlp() -> Option<PathBuf> {
    if let Some(found) = binary_candidates(YTDLP_BINARY_NAMES)
        .into_iter()
        .find(|candidate| candidate.exists())
    {
        return Some(found);
    }
    #[cfg(not(target_os = "windows"))]
    {
        return find_in_path("yt-dlp");
    }
    #[cfg(target_os = "windows")]
    None
}

pub fn resolve_ytdlp(video_id: String, max_height: Option<u32>) -> Result<Vec<String>, String> {
    if video_id.len() != 11
        || !video_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Invalid YouTube video id.".to_string());
    }
    let ytdlp = find_ytdlp().ok_or_else(|| "yt-dlp binary not found.".to_string())?;
    let max_height = max_height.unwrap_or(2160).clamp(360, 2160);
    let mut command = std::process::Command::new(&ytdlp);
    let format = if max_height <= 1080 {
        format!("bv*[height<={max_height}][vcodec^=avc1][protocol^=http]+ba[acodec^=mp4a][protocol^=http]/b[height<={max_height}][protocol^=http]")
    } else {
        format!("bv*[height<={max_height}][vcodec!^=av01][protocol^=http]+ba[protocol^=http]/b[height<={max_height}][protocol^=http]")
    };
    command
        .arg("-f")
        .arg(format)
        .arg("-S")
        .arg("res:2160,fps,br")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--quiet")
        .arg("--get-url")
        .arg(format!("https://www.youtube.com/watch?v={video_id}"));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("Failed to run yt-dlp: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp failed: {}",
            stderr.lines().last().unwrap_or("unknown error")
        ));
    }
    let urls: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| line.starts_with("http"))
        .collect();
    if urls.is_empty() {
        return Err("yt-dlp returned no stream URLs.".to_string());
    }
    Ok(urls)
}

/// Builds the stable diagnostic payload consumed by the player settings UI.
pub fn diagnostics(
    path: Option<PathBuf>,
    libmpv_path: Option<PathBuf>,
    candidates: Vec<PathBuf>,
    libmpv_candidates: Vec<PathBuf>,
) -> serde_json::Value {
    let path = path
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "Not Found".to_string());
    let libmpv_path = libmpv_path
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "Not Found".to_string());
    let candidates: Vec<String> = candidates
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    let libmpv_candidates: Vec<String> = libmpv_candidates
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    serde_json::json!({
        "path": path,
        "libmpvPath": libmpv_path,
        "candidates": candidates,
        "libmpvCandidates": libmpv_candidates,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg(test)]
mod tests {
    use super::{diagnostics, mpv_candidates, resolve_ytdlp, stable_stream_hash};

    #[test]
    fn keeps_the_existing_diagnostic_payload_shape() {
        let payload = diagnostics(None, None, vec![], vec![]);
        assert_eq!(payload["path"], "Not Found");
        assert_eq!(payload["libmpvPath"], "Not Found");
        assert_eq!(payload["candidates"], serde_json::json!([]));
        assert_eq!(payload["libmpvCandidates"], serde_json::json!([]));
        assert!(payload["os"].is_string());
        assert!(payload["arch"].is_string());
    }

    #[test]
    fn includes_the_existing_bundled_binary_candidate_paths() {
        assert!(mpv_candidates()
            .iter()
            .any(|candidate| candidate.ends_with("src-tauri/binaries/mpv")));
    }

    #[test]
    fn rejects_invalid_youtube_ids_before_starting_ytdlp() {
        assert_eq!(
            resolve_ytdlp("invalid".into(), None),
            Err("Invalid YouTube video id.".into())
        );
    }

    #[test]
    fn keeps_stream_identifiers_stable_without_exposing_urls() {
        assert_eq!(
            stable_stream_hash("https://example.com/video"),
            stable_stream_hash("https://example.com/video")
        );
        assert_ne!(
            stable_stream_hash("https://example.com/video"),
            stable_stream_hash("https://example.com/other")
        );
    }
}
