use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{atomic::AtomicBool, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_SUBTITLE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SUBTITLE_STDERR_BYTES: usize = 32 * 1024;
const EMBEDDED_EXTRACT_TIMEOUT: Duration = Duration::from_secs(60);
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static SUBTITLE_CACHE_CLEANED: AtomicBool = AtomicBool::new(false);
const STALE_SUBTITLE_FILE_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn read_stderr_tail(mut reader: impl Read) -> String {
    let mut tail = VecDeque::with_capacity(MAX_SUBTITLE_STDERR_BYTES);
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                tail.extend(chunk[..count].iter().copied());
                while tail.len() > MAX_SUBTITLE_STDERR_BYTES {
                    tail.pop_front();
                }
            }
        }
    }
    String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).into_owned()
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn join_subtitle_readers(
    stdout_reader: &mut Option<JoinHandle<Result<Vec<u8>, String>>>,
    stderr_reader: &mut Option<JoinHandle<String>>,
) {
    if let Some(reader) = stdout_reader.take() {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader.take() {
        let _ = reader.join();
    }
}

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

fn cleanup_stale_subtitle_files() {
    if SUBTITLE_CACHE_CLEANED.load(Ordering::Acquire) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(cache_dir()) else {
        return;
    };
    if SUBTITLE_CACHE_CLEANED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age >= STALE_SUBTITLE_FILE_AGE)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn create_temp_file(
    directory: &std::path::Path,
    file_name: &str,
) -> Result<(std::path::PathBuf, std::fs::File), String> {
    let requested = std::path::Path::new(file_name);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("subtitle");
    let extension = requested.extension().and_then(|value| value.to_str());
    for _ in 0..16 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let unique_name = match extension {
            Some(extension) => format!(
                "{stem}-{}-{sequence}.{extension}",
                chrono::Utc::now().timestamp_millis()
            ),
            None => format!(
                "{stem}-{}-{sequence}",
                chrono::Utc::now().timestamp_millis()
            ),
        };
        let path = directory.join(unique_name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create subtitle cache file: {error}")),
        }
    }
    Err("Could not allocate a unique subtitle cache filename.".to_string())
}

pub fn download(url: String, file_name: String) -> Result<String, String> {
    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(120))
        .set("Accept", "text/vtt, application/x-subrip, text/plain, */*")
        .call()
        .map_err(|error| format!("Subtitle download failed: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_SUBTITLE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read subtitle: {error}"))?;
    if bytes.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err("Subtitle file exceeds the 10 MiB download limit.".to_string());
    }
    if bytes.is_empty() {
        return Err("Subtitle provider returned an empty file.".to_string());
    }
    let directory = cache_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create subtitle cache: {error}"))?;
    cleanup_stale_subtitle_files();
    let (path, mut file) = create_temp_file(&directory, &safe_subtitle_name(&file_name))?;
    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|error| format!("Failed to cache subtitle: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn write_temp(content: String, extension: String) -> Result<String, String> {
    if content.trim().is_empty() {
        return Err("Translated subtitle content is empty.".to_string());
    }
    if content.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err("Subtitle content exceeds the 10 MiB cache limit.".to_string());
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
    cleanup_stale_subtitle_files();
    let (path, mut file) = create_temp_file(&directory, &format!("translated.{extension}"))?;
    std::io::Write::write_all(&mut file, content.as_bytes())
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
    let mut content = String::new();
    std::fs::File::open(path)
        .map_err(|error| format!("Failed to open subtitle cache: {error}"))?
        .take(MAX_SUBTITLE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|error| format!("Failed to read subtitle cache: {error}"))?;
    if content.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err("Subtitle cache file exceeds the 10 MiB limit.".to_string());
    }
    Ok(content)
}

pub fn update_temp(path: String, content: String) -> Result<(), String> {
    let path = validate_cache_path(&path)?;
    if content.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err("Subtitle content exceeds the 10 MiB cache limit.".to_string());
    }
    std::fs::write(path, content.as_bytes())
        .map_err(|error| format!("Failed to update subtitle cache: {error}"))
}

pub fn extract_embedded(url: String, sub_index: u32) -> Result<String, String> {
    let ffmpeg = crate::thumbnails::find_ffmpeg();
    let mut command = Command::new(&ffmpeg);
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
        .arg("-fs")
        .arg((MAX_SUBTITLE_BYTES + 1).to_string())
        .arg("-f")
        .arg("srt")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err("ffmpeg subtitle output pipe was unavailable.".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_child(&mut child);
        return Err("ffmpeg subtitle error pipe was unavailable.".to_string());
    };
    let exceeded_limit = Arc::new(AtomicBool::new(false));
    let overflow_flag = Arc::clone(&exceeded_limit);
    let mut stdout_reader = Some(thread::spawn(move || {
        let mut output = Vec::new();
        let mut limited = stdout.take(MAX_SUBTITLE_BYTES + 1);
        limited
            .read_to_end(&mut output)
            .map_err(|error| format!("Failed to read extracted subtitle: {error}"))?;
        if output.len() as u64 > MAX_SUBTITLE_BYTES {
            overflow_flag.store(true, Ordering::Release);
        }
        Ok(output)
    }));
    let mut stderr_reader = Some(thread::spawn(move || read_stderr_tail(stderr)));
    let deadline = Instant::now() + EMBEDDED_EXTRACT_TIMEOUT;
    let status = loop {
        if exceeded_limit.load(Ordering::Acquire) {
            terminate_child(&mut child);
            join_subtitle_readers(&mut stdout_reader, &mut stderr_reader);
            return Err("Extracted subtitle exceeds the 10 MiB limit.".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                terminate_child(&mut child);
                join_subtitle_readers(&mut stdout_reader, &mut stderr_reader);
                return Err("ffmpeg subtitle extraction timed out after 60 seconds.".to_string());
            }
            Err(error) => {
                terminate_child(&mut child);
                join_subtitle_readers(&mut stdout_reader, &mut stderr_reader);
                return Err(format!("Failed while waiting for ffmpeg: {error}"));
            }
        }
    };
    let output = stdout_reader
        .take()
        .and_then(|reader| reader.join().ok())
        .ok_or_else(|| "ffmpeg subtitle output reader stopped unexpectedly.".to_string())??;
    let stderr = stderr_reader
        .take()
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    if output.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err("Extracted subtitle exceeds the 10 MiB limit.".to_string());
    }
    if !status.success() {
        return Err(format!(
            "ffmpeg subtitle extract failed: {}",
            stderr.lines().last().unwrap_or("unknown error")
        ));
    }
    let srt = String::from_utf8_lossy(&output).to_string();
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
