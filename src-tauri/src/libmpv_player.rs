use libloading::Library;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_longlong, c_ulonglong, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

const MPV_FORMAT_NONE: c_int = 0;
const MPV_FORMAT_STRING: c_int = 1;
const MPV_FORMAT_FLAG: c_int = 3;
const MPV_FORMAT_INT64: c_int = 4;
const MPV_FORMAT_DOUBLE: c_int = 5;
const MPV_FORMAT_NODE: c_int = 6;
const MPV_FORMAT_NODE_ARRAY: c_int = 7;
const MPV_FORMAT_NODE_MAP: c_int = 8;
const MPV_FORMAT_BYTE_ARRAY: c_int = 9;

const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_LOG_MESSAGE: c_int = 2;
const MPV_EVENT_START_FILE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;
const MPV_EVENT_CLIENT_MESSAGE: c_int = 16;
const MPV_EVENT_SEEK: c_int = 20;
const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;
const MPV_EVENT_QUEUE_OVERFLOW: c_int = 24;

type MpvHandle = c_void;
type MpvCreate = unsafe extern "C" fn() -> *mut MpvHandle;
type MpvInitialize = unsafe extern "C" fn(*mut MpvHandle) -> c_int;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut MpvHandle);
type MpvSetOptionString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvCommand = unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> c_int;
type MpvClientId = unsafe extern "C" fn(*mut MpvHandle) -> c_longlong;
type MpvObserveProperty =
    unsafe extern "C" fn(*mut MpvHandle, c_ulonglong, *const c_char, c_int) -> c_int;
type MpvWaitEvent = unsafe extern "C" fn(*mut MpvHandle, c_double) -> *mut MpvEvent;
type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type MpvRequestLogMessages = unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> c_int;

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: c_ulonglong,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventLogMessage {
    prefix: *const c_char,
    level: *const c_char,
    text: *const c_char,
    log_level: c_int,
}

#[repr(C)]
struct MpvEventClientMessage {
    num_args: c_int,
    args: *mut *const c_char,
}

#[repr(C)]
struct MpvNode {
    u: MpvNodeUnion,
    format: c_int,
}

#[repr(C)]
union MpvNodeUnion {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double_: c_double,
    list: *mut MpvNodeList,
    ba: *mut MpvByteArray,
}

#[repr(C)]
struct MpvNodeList {
    num: c_int,
    values: *mut MpvNode,
    keys: *mut *mut c_char,
}

#[repr(C)]
struct MpvByteArray {
    data: *mut c_void,
    size: usize,
}

struct LibMpvApi {
    _library: Library,
    create: MpvCreate,
    initialize: MpvInitialize,
    terminate_destroy: MpvTerminateDestroy,
    set_option_string: MpvSetOptionString,
    command: MpvCommand,
    client_id: MpvClientId,
    observe_property: MpvObserveProperty,
    wait_event: MpvWaitEvent,
    error_string: MpvErrorString,
    request_log_messages: MpvRequestLogMessages,
}

unsafe impl Send for LibMpvApi {}
unsafe impl Sync for LibMpvApi {}

pub(crate) struct LibMpvPlayer {
    api: Arc<LibMpvApi>,
    handle: *mut MpvHandle,
    destroyed: AtomicBool,
    session_id: String,
}

unsafe impl Send for LibMpvPlayer {}
unsafe impl Sync for LibMpvPlayer {}

impl LibMpvPlayer {
    pub(crate) fn create(dll_path: &Path, session_id: String) -> Result<Arc<Self>, String> {
        let api = Arc::new(load_api(dll_path)?);
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err("mpv_create returned null".to_string());
        }

        Ok(Arc::new(Self {
            api,
            handle,
            destroyed: AtomicBool::new(false),
            session_id,
        }))
    }

    pub(crate) fn set_option(&self, name: &str, value: &str) -> Result<(), String> {
        let name = cstring(name)?;
        let value = cstring(value)?;
        let rc =
            unsafe { (self.api.set_option_string)(self.handle, name.as_ptr(), value.as_ptr()) };
        self.check(rc)
    }

    pub(crate) fn initialize(&self) -> Result<(), String> {
        let rc = unsafe { (self.api.initialize)(self.handle) };
        self.check(rc)
    }

    pub(crate) fn command(&self, command: &str, args: &[Value]) -> Result<(), String> {
        if self.destroyed.load(Ordering::SeqCst) {
            return Err("mpv player is shutting down".to_string());
        }

        let mut values = Vec::with_capacity(args.len() + 1);
        let command = match command {
            "set_property" => "set",
            "add_property" => "add",
            "cycle_property" => "cycle",
            other => other,
        };
        values.push(cstring(command)?);
        for value in args {
            values.push(cstring(&json_arg_to_mpv_string(value))?);
        }

        let mut ptrs: Vec<*const c_char> = values.iter().map(|value| value.as_ptr()).collect();
        ptrs.push(std::ptr::null());

        let rc = unsafe { (self.api.command)(self.handle, ptrs.as_ptr()) };
        self.check(rc)
    }

    pub(crate) fn client_target(&self) -> String {
        let id = unsafe { (self.api.client_id)(self.handle) };
        format!("@{}", id)
    }

    pub(crate) fn observe_properties(&self, properties: &[&str]) {
        for (index, property) in properties.iter().enumerate() {
            if let Ok(name) = cstring(property) {
                let rc = unsafe {
                    (self.api.observe_property)(
                        self.handle,
                        (index + 1) as c_ulonglong,
                        name.as_ptr(),
                        MPV_FORMAT_NODE,
                    )
                };
                if rc < 0 {
                    crate::commands::player_debug_log(format!(
                        "[MPV LIB] observe_property {} failed: {}",
                        property,
                        self.error_string(rc)
                    ));
                }
            }
        }
    }

    pub(crate) fn request_log_messages(&self, level: &str) {
        if let Ok(level) = cstring(level) {
            let rc = unsafe { (self.api.request_log_messages)(self.handle, level.as_ptr()) };
            if rc < 0 {
                crate::commands::player_debug_log(format!(
                    "[MPV LIB] request_log_messages failed: {}",
                    self.error_string(rc)
                ));
            }
        }
    }

    pub(crate) fn start_event_loop(self: &Arc<Self>, app: tauri::AppHandle) {
        let player = Arc::clone(self);
        std::thread::spawn(move || loop {
            if player.destroyed.load(Ordering::SeqCst) {
                return;
            }

            let event = unsafe { (player.api.wait_event)(player.handle, 0.5) };
            if event.is_null() {
                continue;
            }

            let event = unsafe { &*event };
            match event.event_id {
                MPV_EVENT_SHUTDOWN => {
                    crate::commands::player_debug_log(format!(
                        "[MPV EVENT] session={} shutdown",
                        player.session_id
                    ));
                    let _ = crate::commands::clear_player_if_session(&player.session_id);
                    return;
                }
                MPV_EVENT_PROPERTY_CHANGE => {
                    if !event.data.is_null() {
                        unsafe { handle_property_event(event.data as *const MpvEventProperty) };
                    }
                }
                MPV_EVENT_LOG_MESSAGE => {
                    if !event.data.is_null() {
                        unsafe {
                            handle_log_event(
                                &player.session_id,
                                event.data as *const MpvEventLogMessage,
                            )
                        };
                    }
                }
                MPV_EVENT_CLIENT_MESSAGE => {
                    if !event.data.is_null() {
                        unsafe {
                            handle_client_message_event(
                                &app,
                                &player.session_id,
                                event.data as *const MpvEventClientMessage,
                            )
                        };
                    }
                }
                MPV_EVENT_START_FILE
                | MPV_EVENT_END_FILE
                | MPV_EVENT_FILE_LOADED
                | MPV_EVENT_SEEK
                | MPV_EVENT_PLAYBACK_RESTART
                | MPV_EVENT_QUEUE_OVERFLOW => {
                    crate::commands::player_debug_log(format!(
                        "[MPV EVENT] session={} id={} error={}",
                        player.session_id, event.event_id, event.error
                    ));
                    if event.error >= 0
                        && (event.event_id == MPV_EVENT_FILE_LOADED
                            || event.event_id == MPV_EVENT_PLAYBACK_RESTART)
                    {
                        let _ = app.emit(
                            "mpv-playback-ready",
                            serde_json::json!({
                                "sessionId": player.session_id,
                                "eventId": event.event_id,
                            }),
                        );
                    }
                }
                _ => {}
            }
        });
    }

    pub(crate) fn shutdown(&self) {
        if !self.destroyed.swap(true, Ordering::SeqCst) {
            unsafe {
                (self.api.terminate_destroy)(self.handle);
            }
        }
    }

    fn check(&self, rc: c_int) -> Result<(), String> {
        if rc < 0 {
            Err(self.error_string(rc))
        } else {
            Ok(())
        }
    }

    fn error_string(&self, rc: c_int) -> String {
        unsafe {
            let ptr = (self.api.error_string)(rc);
            if ptr.is_null() {
                format!("mpv error {}", rc)
            } else {
                CStr::from_ptr(ptr).to_string_lossy().into_owned()
            }
        }
    }
}

impl Drop for LibMpvPlayer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(target_os = "windows")]
const LIBMPV_NAMES: &[&str] = &["libmpv-2.dll"];
#[cfg(target_os = "linux")]
const LIBMPV_NAMES: &[&str] = &["libmpv.so.2", "libmpv.so"];
#[cfg(target_os = "macos")]
const LIBMPV_NAMES: &[&str] = &["libmpv.2.dylib", "libmpv.dylib"];

pub(crate) fn libmpv_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in LIBMPV_NAMES {
                candidates.push(dir.join(name));
                candidates.push(dir.join("binaries").join(name));
                candidates.push(dir.join("resources").join(name));
            }
        }
    }
    for name in LIBMPV_NAMES {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(name),
        );
        candidates.push(PathBuf::from("src-tauri").join("binaries").join(name));
    }
    // Distro-installed libmpv lives on the loader path, not beside the app.
    #[cfg(target_os = "linux")]
    for name in LIBMPV_NAMES {
        for dir in ["/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib"] {
            candidates.push(PathBuf::from(dir).join(name));
        }
    }
    candidates
}

pub(crate) fn find_libmpv() -> Option<PathBuf> {
    libmpv_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn load_api(dll_path: &Path) -> Result<LibMpvApi, String> {
    let library = unsafe { Library::new(dll_path) }
        .map_err(|error| format!("Failed to load {}: {}", dll_path.display(), error))?;
    unsafe {
        Ok(LibMpvApi {
            create: *library.get(b"mpv_create\0").map_err(|e| e.to_string())?,
            initialize: *library
                .get(b"mpv_initialize\0")
                .map_err(|e| e.to_string())?,
            terminate_destroy: *library
                .get(b"mpv_terminate_destroy\0")
                .map_err(|e| e.to_string())?,
            set_option_string: *library
                .get(b"mpv_set_option_string\0")
                .map_err(|e| e.to_string())?,
            command: *library.get(b"mpv_command\0").map_err(|e| e.to_string())?,
            client_id: *library.get(b"mpv_client_id\0").map_err(|e| e.to_string())?,
            observe_property: *library
                .get(b"mpv_observe_property\0")
                .map_err(|e| e.to_string())?,
            wait_event: *library
                .get(b"mpv_wait_event\0")
                .map_err(|e| e.to_string())?,
            error_string: *library
                .get(b"mpv_error_string\0")
                .map_err(|e| e.to_string())?,
            request_log_messages: *library
                .get(b"mpv_request_log_messages\0")
                .map_err(|e| e.to_string())?,
            _library: library,
        })
    }
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("mpv argument contains an interior NUL: {}", value))
}

fn json_arg_to_mpv_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Bool(value) => {
            if *value {
                "yes".to_string()
            } else {
                "no".to_string()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::Null => "no".to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

unsafe fn handle_property_event(data: *const MpvEventProperty) {
    let property = &*data;
    if property.name.is_null() {
        return;
    }

    let name = CStr::from_ptr(property.name).to_string_lossy().into_owned();
    let value = if property.data.is_null() || property.format == MPV_FORMAT_NONE {
        Value::Null
    } else if property.format == MPV_FORMAT_NODE {
        mpv_node_to_json(&*(property.data as *const MpvNode))
    } else {
        mpv_raw_property_to_json(property.format, property.data)
    };

    crate::commands::cache_mpv_property(name, value);
}

unsafe fn handle_log_event(session_id: &str, data: *const MpvEventLogMessage) {
    let event = &*data;
    let level = cstr_to_string(event.level);
    if level != "error" && level != "warn" {
        return;
    }
    let prefix = cstr_to_string(event.prefix);
    let text = cstr_to_string(event.text).trim().to_string();
    if !text.is_empty() {
        crate::commands::player_debug_log(format!(
            "[MPV LOG] session={} {} {}",
            session_id, prefix, text
        ));
    }
}

#[derive(Deserialize)]
struct ThumbfastRender {
    width: u32,
    height: u32,
    thumbnail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailReadyPayload {
    path: String,
    width: u32,
    height: u32,
    session_id: String,
}

unsafe fn handle_client_message_event(
    app: &tauri::AppHandle,
    session_id: &str,
    data: *const MpvEventClientMessage,
) {
    let event = &*data;
    if event.num_args < 2 || event.args.is_null() {
        return;
    }

    let message = CStr::from_ptr(*event.args).to_string_lossy().into_owned();
    if message != "thumbfast-render" {
        return;
    }

    let json_ptr = *event.args.add(1);
    if json_ptr.is_null() {
        return;
    }

    let json = CStr::from_ptr(json_ptr).to_string_lossy();
    match serde_json::from_str::<ThumbfastRender>(&json) {
        Ok(render) => match convert_thumbfast_bgra_to_bmp_base64(&render) {
            Ok(data_url) => {
                let _ = app.emit(
                    "player-thumbnail-ready",
                    ThumbnailReadyPayload {
                        path: data_url,
                        width: render.width,
                        height: render.height,
                        session_id: session_id.to_string(),
                    },
                );
            }
            Err(error) => {
                crate::commands::player_debug_log(format!(
                    "[THUMBFAST] failed to convert thumbnail: {}",
                    error
                ));
            }
        },
        Err(error) => {
            crate::commands::player_debug_log(format!(
                "[THUMBFAST] failed to parse render payload: {}",
                error
            ));
        }
    }
}

fn convert_thumbfast_bgra_to_bmp_base64(render: &ThumbfastRender) -> Result<String, String> {
    let width = render.width.max(1);
    let height = render.height.max(1);
    let source = PathBuf::from(format!("{}.bgra", render.thumbnail));
    let bgra =
        std::fs::read(&source).map_err(|error| format!("read {}: {}", source.display(), error))?;

    // Delete raw video frame file immediately to avoid disk accumulation
    let _ = std::fs::remove_file(&source);

    let expected_len = width as usize * height as usize * 4;
    if bgra.len() < expected_len {
        return Err(format!(
            "thumbnail data too short: got {} bytes, expected {}",
            bgra.len(),
            expected_len
        ));
    }

    let file_header_len = 14u32;
    let dib_header_len = 40u32;
    let pixel_len = expected_len as u32;
    let file_len = file_header_len + dib_header_len + pixel_len;
    let mut bmp = Vec::with_capacity(file_len as usize);

    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_len.to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&(file_header_len + dib_header_len).to_le_bytes());
    bmp.extend_from_slice(&dib_header_len.to_le_bytes());
    bmp.extend_from_slice(&(width as i32).to_le_bytes());
    bmp.extend_from_slice(&(-(height as i32)).to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes());
    bmp.extend_from_slice(&32u16.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&pixel_len.to_le_bytes());
    bmp.extend_from_slice(&0i32.to_le_bytes());
    bmp.extend_from_slice(&0i32.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&bgra[..expected_len]);

    let base64_str = base64_encode(&bmp);
    Ok(format!("data:image/bmp;base64,{}", base64_str))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        match chunk.len() {
            3 => {
                let b = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
                result.push(CHARSET[((b >> 18) & 63) as usize] as char);
                result.push(CHARSET[((b >> 12) & 63) as usize] as char);
                result.push(CHARSET[((b >> 6) & 63) as usize] as char);
                result.push(CHARSET[(b & 63) as usize] as char);
            }
            2 => {
                let b = ((chunk[0] as u32) << 8) | (chunk[1] as u32);
                result.push(CHARSET[((b >> 10) & 63) as usize] as char);
                result.push(CHARSET[((b >> 4) & 63) as usize] as char);
                result.push(CHARSET[((b << 2) & 63) as usize] as char);
                result.push('=');
            }
            1 => {
                let b = chunk[0] as u32;
                result.push(CHARSET[((b >> 2) & 63) as usize] as char);
                result.push(CHARSET[((b << 4) & 63) as usize] as char);
                result.push('=');
                result.push('=');
            }
            _ => unreachable!(),
        }
    }
    result
}

unsafe fn mpv_raw_property_to_json(format: c_int, data: *mut c_void) -> Value {
    match format {
        MPV_FORMAT_STRING => {
            let ptr = *(data as *const *const c_char);
            if ptr.is_null() {
                Value::Null
            } else {
                Value::String(CStr::from_ptr(ptr).to_string_lossy().into_owned())
            }
        }
        MPV_FORMAT_FLAG => Value::Bool(*(data as *const c_int) != 0),
        MPV_FORMAT_INT64 => Value::Number(serde_json::Number::from(*(data as *const i64))),
        MPV_FORMAT_DOUBLE => serde_json::Number::from_f64(*(data as *const c_double))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

unsafe fn mpv_node_to_json(node: &MpvNode) -> Value {
    match node.format {
        MPV_FORMAT_NONE => Value::Null,
        MPV_FORMAT_STRING => {
            if node.u.string.is_null() {
                Value::Null
            } else {
                Value::String(CStr::from_ptr(node.u.string).to_string_lossy().into_owned())
            }
        }
        MPV_FORMAT_FLAG => Value::Bool(node.u.flag != 0),
        MPV_FORMAT_INT64 => Value::Number(serde_json::Number::from(node.u.int64)),
        MPV_FORMAT_DOUBLE => serde_json::Number::from_f64(node.u.double_)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        MPV_FORMAT_NODE_ARRAY | MPV_FORMAT_NODE_MAP => mpv_node_list_to_json(node),
        MPV_FORMAT_BYTE_ARRAY => Value::Null,
        _ => Value::Null,
    }
}

unsafe fn mpv_node_list_to_json(node: &MpvNode) -> Value {
    let list = node.u.list;
    if list.is_null() {
        return Value::Null;
    }
    let list = &*list;
    let len = list.num.max(0) as usize;
    if node.format == MPV_FORMAT_NODE_ARRAY {
        let mut values = Vec::with_capacity(len);
        for index in 0..len {
            values.push(mpv_node_to_json(&*list.values.add(index)));
        }
        Value::Array(values)
    } else {
        let mut map = serde_json::Map::new();
        for index in 0..len {
            let key_ptr = *list.keys.add(index);
            if !key_ptr.is_null() {
                let key = CStr::from_ptr(key_ptr).to_string_lossy().into_owned();
                map.insert(key, mpv_node_to_json(&*list.values.add(index)));
            }
        }
        Value::Object(map)
    }
}

unsafe fn cstr_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn create_video_child(
    parent_hwnd: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<isize, String> {
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, SetWindowPos, SWP_NOACTIVATE, SWP_SHOWWINDOW, WINDOW_EX_STYLE,
        WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
    };

    if parent_hwnd == 0 {
        return Err("Cannot create mpv video surface: parent window handle is missing".to_string());
    }

    let parent = HWND(parent_hwnd as *mut _);
    let mut origin = POINT { x, y };
    unsafe {
        let _ = ClientToScreen(parent, &mut origin);
    }

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0),
            w!("STATIC"),
            w!("AuralesMpvVideo"),
            WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            origin.x,
            origin.y,
            width.max(1),
            height.max(1),
            None,
            None,
            None,
            None,
        )
    }
    .map_err(|e| format!("Failed to create mpv video surface: {}", e))?;

    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(parent),
            origin.x,
            origin.y,
            width.max(1),
            height.max(1),
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    Ok(hwnd.0 as isize)
}

#[cfg(target_os = "windows")]
pub(crate) fn resize_video_child(
    parent_hwnd: isize,
    video_hwnd: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_SHOWWINDOW};

    let parent = HWND(parent_hwnd as *mut _);
    let mut origin = POINT { x, y };
    unsafe {
        let _ = ClientToScreen(parent, &mut origin);
        let _ = SetWindowPos(
            HWND(video_hwnd as *mut _),
            Some(parent),
            origin.x,
            origin.y,
            width.max(1),
            height.max(1),
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn destroy_video_child(video_hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    if video_hwnd != 0 {
        unsafe {
            let _ = DestroyWindow(HWND(video_hwnd as *mut _));
        }
    }
}
