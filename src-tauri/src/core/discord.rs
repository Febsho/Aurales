use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
type DiscordIpcStream = std::fs::File;
#[cfg(unix)]
type DiscordIpcStream = std::os::unix::net::UnixStream;

static PIPE: OnceLock<Mutex<Option<DiscordIpcStream>>> = OnceLock::new();
const APP_ID: &str = "1514350347227893951";

pub struct Activity {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    pub start_timestamp: Option<u64>,
    pub end_timestamp: Option<u64>,
    pub activity_type: Option<u32>,
}

fn pipe() -> &'static Mutex<Option<DiscordIpcStream>> {
    PIPE.get_or_init(|| Mutex::new(None))
}

#[cfg(unix)]
fn candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let runtime = PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }));
        if !roots.contains(&runtime) {
            roots.push(runtime);
        }
    }
    let tmp = PathBuf::from("/tmp");
    if !roots.contains(&tmp) {
        roots.push(tmp);
    }
    roots
        .into_iter()
        .flat_map(|root| {
            (0..10).flat_map(move |index| {
                let name = format!("discord-ipc-{index}");
                [
                    root.join(&name),
                    root.join("app/com.discordapp.Discord").join(&name),
                    root.join("snap.discord").join(&name),
                    root.join(".flatpak/com.discordapp.Discord/xdg-run")
                        .join(&name),
                ]
            })
        })
        .collect()
}

fn encode(opcode: u32, payload: &str) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(8 + payload.len());
    buffer.extend_from_slice(&opcode.to_le_bytes());
    buffer.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buffer.extend_from_slice(payload.as_bytes());
    buffer
}

fn connect() -> Result<(), String> {
    use std::io::{Read, Write};
    let mut guard = pipe().lock().map_err(|error| error.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    let mut socket = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(r"\\.\pipe\discord-ipc-0")
        .map_err(|error| format!("Discord not running or IPC unavailable: {error}"))?;
    #[cfg(unix)]
    let mut socket = {
        use std::os::unix::net::UnixStream;
        let mut failures = Vec::new();
        let mut connected = None;
        for path in candidates() {
            match UnixStream::connect(&path) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) if path.exists() => {
                    failures.push(format!("{}: {error}", path.display()))
                }
                Err(_) => {}
            }
        }
        let stream = connected.ok_or_else(|| {
            if failures.is_empty() {
                "Discord not running or no Discord IPC socket was found".to_string()
            } else {
                format!(
                    "Discord IPC sockets were unavailable: {}",
                    failures.join("; ")
                )
            }
        })?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .map_err(|error| format!("Failed to configure Discord IPC read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(2)))
            .map_err(|error| format!("Failed to configure Discord IPC write timeout: {error}"))?;
        stream
    };
    let handshake = serde_json::json!({ "v": 1, "client_id": APP_ID }).to_string();
    socket
        .write_all(&encode(0, &handshake))
        .map_err(|error| format!("Failed to send Discord handshake: {error}"))?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_WAIT};
        let handle = HANDLE(socket.as_raw_handle());
        let mut mode = PIPE_NOWAIT;
        unsafe {
            let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
        let mut response = Vec::new();
        let mut chunk = [0u8; 4096];
        let received = loop {
            match socket.read(&mut chunk) {
                Ok(count) if count > 0 => {
                    response.extend_from_slice(&chunk[..count]);
                    if response.len() >= 8 {
                        let body = u32::from_le_bytes([
                            response[4],
                            response[5],
                            response[6],
                            response[7],
                        ]) as usize;
                        if response.len() >= 8 + body {
                            break true;
                        }
                    }
                }
                _ => {
                    if std::time::Instant::now() >= deadline {
                        break false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
            }
        };
        let mut mode = PIPE_WAIT;
        unsafe {
            let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None);
        }
        if !received {
            return Err("Discord handshake timed out".to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut header = [0u8; 8];
        socket
            .read_exact(&mut header)
            .map_err(|error| format!("Failed to read Discord handshake response: {error}"))?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let mut body = vec![0u8; size];
        socket
            .read_exact(&mut body)
            .map_err(|error| format!("Failed to read Discord response body: {error}"))?;
    }
    *guard = Some(socket);
    Ok(())
}

fn activity_payload(activity: Activity) -> serde_json::Value {
    let mut value = serde_json::json!({ "type": activity.activity_type.unwrap_or(0) });
    if let Some(details) = activity.details {
        value["details"] = serde_json::json!(details);
    }
    if let Some(state) = activity.state {
        value["state"] = serde_json::json!(state);
    }
    let mut assets = serde_json::json!({});
    if let Some(image) = activity.large_image {
        assets["large_image"] = serde_json::json!(image);
    }
    if let Some(text) = activity.large_text {
        assets["large_text"] = serde_json::json!(text);
    }
    if let Some(image) = activity.small_image {
        assets["small_image"] = serde_json::json!(image);
    }
    if let Some(text) = activity.small_text {
        assets["small_text"] = serde_json::json!(text);
    }
    if assets != serde_json::json!({}) {
        value["assets"] = assets;
    }
    let mut timestamps = serde_json::json!({});
    if let Some(start) = activity.start_timestamp {
        timestamps["start"] = serde_json::json!(start);
    }
    if let Some(end) = activity.end_timestamp {
        timestamps["end"] = serde_json::json!(end);
    }
    if timestamps != serde_json::json!({}) {
        value["timestamps"] = timestamps;
    }
    value
}

fn write_activity(activity: serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    connect()?;
    let mut guard = pipe().lock().map_err(|error| error.to_string())?;
    let socket = guard
        .as_mut()
        .ok_or_else(|| "Discord IPC not connected".to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let payload = serde_json::json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce }).to_string();
    if let Err(error) = socket.write_all(&encode(1, &payload)) {
        *guard = None;
        return Err(format!("Failed to send Discord activity: {error}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::io::Read;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_WAIT};
        let handle = HANDLE(socket.as_raw_handle());
        let mut mode = PIPE_NOWAIT;
        unsafe {
            let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut drain = [0u8; 4096];
        let _ = socket.read(&mut drain);
        let mut mode = PIPE_WAIT;
        unsafe {
            let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None);
        }
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        socket
            .set_nonblocking(true)
            .map_err(|error| format!("Failed to configure Discord IPC socket: {error}"))?;
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut drain = [0u8; 8192];
        loop {
            match socket.read(&mut drain) {
                Ok(0) => {
                    *guard = None;
                    return Err("Discord IPC connection closed".to_string());
                }
                Ok(count) if count == drain.len() => continue,
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    *guard = None;
                    return Err(format!("Failed to read Discord IPC response: {error}"));
                }
            }
        }
        socket
            .set_nonblocking(false)
            .map_err(|error| format!("Failed to restore Discord IPC socket: {error}"))?;
    }
    Ok(())
}

pub fn set_activity(activity: Activity) -> Result<(), String> {
    write_activity(activity_payload(activity))
}
pub fn clear_activity() -> Result<(), String> {
    write_activity(serde_json::json!(null))
}
pub fn disconnect() {
    if let Ok(mut guard) = pipe().lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{activity_payload, encode, Activity};
    #[test]
    fn preserves_discord_wire_frame_and_optional_activity_fields() {
        assert_eq!(encode(1, "{}"), vec![1, 0, 0, 0, 2, 0, 0, 0, b'{', b'}']);
        let payload = activity_payload(Activity {
            details: Some("Episode 1".into()),
            state: None,
            large_image: Some("poster".into()),
            large_text: None,
            small_image: None,
            small_text: None,
            start_timestamp: Some(1),
            end_timestamp: None,
            activity_type: None,
        });
        assert_eq!(
            payload,
            serde_json::json!({"type": 0, "details": "Episode 1", "assets": {"large_image": "poster"}, "timestamps": {"start": 1}})
        );
    }
}
