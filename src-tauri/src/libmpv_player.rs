use libloading::Library;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_longlong, c_ulonglong, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
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

const MPV_END_FILE_REASON_EOF: c_int = 0;
const MPV_END_FILE_REASON_STOP: c_int = 2;
const MPV_END_FILE_REASON_QUIT: c_int = 3;
const MPV_END_FILE_REASON_ERROR: c_int = 4;
const MPV_END_FILE_REASON_REDIRECT: c_int = 5;

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
#[cfg(target_os = "linux")]
type MpvRenderContext = c_void;
#[cfg(target_os = "linux")]
type MpvRenderContextCreate = unsafe extern "C" fn(
    *mut *mut MpvRenderContext,
    *mut MpvHandle,
    *mut MpvRenderParam,
) -> c_int;
#[cfg(target_os = "linux")]
type MpvRenderContextUpdate =
    unsafe extern "C" fn(*mut MpvRenderContext) -> c_ulonglong;
#[cfg(target_os = "linux")]
type MpvRenderContextRender =
    unsafe extern "C" fn(*mut MpvRenderContext, *mut MpvRenderParam) -> c_int;
#[cfg(target_os = "linux")]
type MpvRenderContextFree = unsafe extern "C" fn(*mut MpvRenderContext);

#[cfg(target_os = "linux")]
const MPV_RENDER_PARAM_INVALID: c_int = 0;
#[cfg(target_os = "linux")]
const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
#[cfg(target_os = "linux")]
const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
#[cfg(target_os = "linux")]
const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
#[cfg(target_os = "linux")]
const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;

#[cfg(target_os = "linux")]
#[repr(C)]
struct MpvRenderParam {
    param_type: c_int,
    data: *mut c_void,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct MpvOpenGlInitParams {
    get_proc_address:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
    get_proc_address_ctx: *mut c_void,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct MpvOpenGlFbo {
    fbo: c_int,
    width: c_int,
    height: c_int,
    internal_format: c_int,
}

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
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    playlist_entry_id: c_longlong,
    playlist_insert_id: c_longlong,
    playlist_insert_num_entries: c_int,
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
    #[cfg(target_os = "linux")]
    render_context_create: MpvRenderContextCreate,
    #[cfg(target_os = "linux")]
    render_context_update: MpvRenderContextUpdate,
    #[cfg(target_os = "linux")]
    render_context_render: MpvRenderContextRender,
    #[cfg(target_os = "linux")]
    render_context_free: MpvRenderContextFree,
}

unsafe impl Send for LibMpvApi {}
unsafe impl Sync for LibMpvApi {}

#[cfg(target_os = "linux")]
pub(crate) fn initialize_numeric_locale() -> Result<(), String> {
    static NUMERIC_LOCALE_READY: OnceLock<bool> = OnceLock::new();
    let ready = NUMERIC_LOCALE_READY.get_or_init(|| {
        // libmpv's client API requires a process-wide C numeric locale. GTK
        // initializes the user's locale first, so do this after GTK startup
        // but before creating the first mpv handle.
        let locale = b"C\0";
        !unsafe { libc::setlocale(libc::LC_NUMERIC, locale.as_ptr().cast()) }.is_null()
    });
    if *ready {
        Ok(())
    } else {
        Err("failed to set LC_NUMERIC=C before initializing libmpv".to_string())
    }
}

pub(crate) struct LibMpvPlayer {
    api: Arc<LibMpvApi>,
    handle: *mut MpvHandle,
    destroyed: AtomicBool,
    session_id: String,
    #[cfg(target_os = "linux")]
    render_context: std::sync::Mutex<Option<usize>>,
}

unsafe impl Send for LibMpvPlayer {}
unsafe impl Sync for LibMpvPlayer {}

impl LibMpvPlayer {
    pub(crate) fn create(dll_path: &Path, session_id: String) -> Result<Arc<Self>, String> {
        #[cfg(target_os = "linux")]
        initialize_numeric_locale()?;

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
            #[cfg(target_os = "linux")]
            render_context: std::sync::Mutex::new(None),
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
                MPV_EVENT_END_FILE => {
                    let (reason, error_code) = if event.data.is_null() {
                        (-1, 0)
                    } else {
                        let end = unsafe { &*(event.data as *const MpvEventEndFile) };
                        (end.reason, end.error)
                    };
                    let reason_str = match reason {
                        MPV_END_FILE_REASON_EOF => "eof",
                        MPV_END_FILE_REASON_STOP => "stop",
                        MPV_END_FILE_REASON_QUIT => "quit",
                        MPV_END_FILE_REASON_ERROR => "error",
                        MPV_END_FILE_REASON_REDIRECT => "redirect",
                        _ => "unknown",
                    };
                    let error_message = if reason == MPV_END_FILE_REASON_ERROR {
                        Some(player.error_string(error_code))
                    } else {
                        None
                    };
                    crate::commands::player_debug_log(format!(
                        "[MPV EVENT] session={} end-file reason={}{}",
                        player.session_id,
                        reason_str,
                        error_message
                            .as_deref()
                            .map(|message| format!(" error={}", message))
                            .unwrap_or_default()
                    ));
                    let _ = app.emit(
                        "mpv-end-file",
                        serde_json::json!({
                            "sessionId": player.session_id,
                            "reason": reason_str,
                            "error": error_message,
                        }),
                    );
                }
                MPV_EVENT_START_FILE
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

    pub(crate) fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    pub(crate) fn shutdown(&self) {
        if !self.destroyed.swap(true, Ordering::SeqCst) {
            unsafe {
                (self.api.terminate_destroy)(self.handle);
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) unsafe fn create_opengl_render_context(
        &self,
        get_proc_address: unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
        ) -> *mut c_void,
    ) -> Result<(), String> {
        let mut slot = self.render_context.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }

        let api_name = b"opengl\0";
        let mut init = MpvOpenGlInitParams {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut params = [
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_API_TYPE,
                data: api_name.as_ptr() as *mut c_void,
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&mut init as *mut MpvOpenGlInitParams).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let mut context = std::ptr::null_mut();
        let rc = (self.api.render_context_create)(
            &mut context,
            self.handle,
            params.as_mut_ptr(),
        );
        self.check(rc)?;
        if context.is_null() {
            return Err("libmpv created a null OpenGL render context".to_string());
        }
        *slot = Some(context as usize);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(crate) unsafe fn render_opengl_frame(
        &self,
        framebuffer: c_int,
        width: c_int,
        height: c_int,
    ) -> Result<(), String> {
        let slot = self.render_context.lock().map_err(|e| e.to_string())?;
        let Some(context) = *slot else {
            return Ok(());
        };
        (self.api.render_context_update)(context as *mut MpvRenderContext);
        let mut fbo = MpvOpenGlFbo {
            fbo: framebuffer,
            width: width.max(1),
            height: height.max(1),
            internal_format: 0,
        };
        let mut flip_y: c_int = 1;
        let mut params = [
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_OPENGL_FBO,
                data: (&mut fbo as *mut MpvOpenGlFbo).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_FLIP_Y,
                data: (&mut flip_y as *mut c_int).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        self.check((self.api.render_context_render)(
            context as *mut MpvRenderContext,
            params.as_mut_ptr(),
        ))
    }

    #[cfg(target_os = "linux")]
    pub(crate) unsafe fn free_opengl_render_context(&self) {
        if let Ok(mut slot) = self.render_context.lock() {
            if let Some(context) = slot.take() {
                (self.api.render_context_free)(context as *mut MpvRenderContext);
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
const LIBMPV_NAMES: &[&str] = &["libmpv.so.2", "libmpv.so.1", "libmpv.so"];
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
                // Tauri places AppImage resources below usr/lib/Aurales while
                // the executable lives in usr/bin.
                candidates.push(
                    dir.join("..")
                        .join("lib")
                        .join("Aurales")
                        .join("libmpv")
                        .join(name),
                );
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
        for dir in [
            "/app/lib",
            "/app/lib/x86_64-linux-gnu",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib64",
            "/usr/lib",
        ] {
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
            #[cfg(target_os = "linux")]
            render_context_create: *library
                .get(b"mpv_render_context_create\0")
                .map_err(|e| e.to_string())?,
            #[cfg(target_os = "linux")]
            render_context_update: *library
                .get(b"mpv_render_context_update\0")
                .map_err(|e| e.to_string())?,
            #[cfg(target_os = "linux")]
            render_context_render: *library
                .get(b"mpv_render_context_render\0")
                .map_err(|e| e.to_string())?,
            #[cfg(target_os = "linux")]
            render_context_free: *library
                .get(b"mpv_render_context_free\0")
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

// Linux uses the same layout as the Windows native player: a native mpv
// surface sits below the transparent WebKitGTK view while React renders the
// controls above it. X11 child windows make that possible without duplicating
// the player UI. Wayland does not expose embeddable window IDs, so the app is
// started through X11/XWayland when DISPLAY is available.
#[cfg(target_os = "linux")]
#[allow(dead_code)]
mod linux_x11 {
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    type Display = c_void;
    type Window = c_ulong;
    type Atom = c_ulong;

    static NATIVE_SURFACE_CONTROLS: AtomicBool = AtomicBool::new(false);

    #[repr(C)]
    #[derive(Clone, Copy)]
    union ClientMessageData {
        bytes: [c_char; 20],
        shorts: [i16; 10],
        longs: [c_long; 5],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct XClientMessageEvent {
        event_type: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut Display,
        window: Window,
        message_type: Atom,
        format: c_int,
        data: ClientMessageData,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    union XEvent {
        event_type: c_int,
        client_message: XClientMessageEvent,
        padding: [c_long; 24],
    }

    #[repr(C)]
    struct XWindowChanges {
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        border_width: c_int,
        sibling: Window,
        stack_mode: c_int,
    }

    const CW_SIBLING: c_uint = 1 << 5;
    const CW_STACK_MODE: c_uint = 1 << 6;
    const BELOW: c_int = 1;
    const CLIENT_MESSAGE: c_int = 33;
    const SUBSTRUCTURE_NOTIFY_MASK: c_long = 1 << 19;
    const SUBSTRUCTURE_REDIRECT_MASK: c_long = 1 << 20;
    const NET_WM_STATE_REMOVE: c_long = 0;
    const NET_WM_STATE_ADD: c_long = 1;

    #[link(name = "X11")]
    extern "C" {
        fn XInitThreads() -> c_int;
        fn XOpenDisplay(name: *const c_char) -> *mut Display;
        fn XCloseDisplay(display: *mut Display) -> c_int;
        fn XDefaultRootWindow(display: *mut Display) -> Window;
        fn XInternAtom(
            display: *mut Display,
            atom_name: *const c_char,
            only_if_exists: c_int,
        ) -> Atom;
        fn XSendEvent(
            display: *mut Display,
            window: Window,
            propagate: c_int,
            event_mask: c_long,
            event: *mut XEvent,
        ) -> c_int;
        fn XQueryTree(
            display: *mut Display,
            window: Window,
            root_return: *mut Window,
            parent_return: *mut Window,
            children_return: *mut *mut Window,
            child_count_return: *mut c_uint,
        ) -> c_int;
        fn XFree(data: *mut c_void) -> c_int;
        fn XTranslateCoordinates(
            display: *mut Display,
            source: Window,
            destination: Window,
            source_x: c_int,
            source_y: c_int,
            destination_x: *mut c_int,
            destination_y: *mut c_int,
            child_return: *mut Window,
        ) -> c_int;
        fn XGetGeometry(
            display: *mut Display,
            drawable: Window,
            root_return: *mut Window,
            x_return: *mut c_int,
            y_return: *mut c_int,
            width_return: *mut c_uint,
            height_return: *mut c_uint,
            border_width_return: *mut c_uint,
            depth_return: *mut c_uint,
        ) -> c_int;
        fn XCreateSimpleWindow(
            display: *mut Display,
            parent: Window,
            x: c_int,
            y: c_int,
            width: c_uint,
            height: c_uint,
            border_width: c_uint,
            border: c_ulong,
            background: c_ulong,
        ) -> Window;
        fn XMapWindow(display: *mut Display, window: Window) -> c_int;
        fn XConfigureWindow(
            display: *mut Display,
            window: Window,
            value_mask: c_uint,
            changes: *mut XWindowChanges,
        ) -> c_int;
        fn XLowerWindow(display: *mut Display, window: Window) -> c_int;
        fn XRaiseWindow(display: *mut Display, window: Window) -> c_int;
        fn XRestackWindows(
            display: *mut Display,
            windows: *mut Window,
            window_count: c_int,
        ) -> c_int;
        fn XSync(display: *mut Display, discard: c_int) -> c_int;
        fn XMoveResizeWindow(
            display: *mut Display,
            window: Window,
            x: c_int,
            y: c_int,
            width: c_uint,
            height: c_uint,
        ) -> c_int;
        fn XDestroyWindow(display: *mut Display, window: Window) -> c_int;
        fn XFlush(display: *mut Display) -> c_int;
    }

    fn display_slot() -> &'static Mutex<usize> {
        static DISPLAY: OnceLock<Mutex<usize>> = OnceLock::new();
        DISPLAY.get_or_init(|| Mutex::new(0))
    }

    pub(crate) fn initialize() {
        // Must run before GTK initializes Xlib. This lets resize/stop commands
        // safely use the dedicated display connection from Tauri command
        // threads.
        unsafe {
            XInitThreads();
        }
    }

    unsafe fn parent_of(display: *mut Display, window: Window) -> Result<Window, String> {
        let mut root = 0;
        let mut parent = 0;
        let mut children = ptr::null_mut();
        let mut child_count = 0;
        let status = XQueryTree(
            display,
            window,
            &mut root,
            &mut parent,
            &mut children,
            &mut child_count,
        );
        if !children.is_null() {
            XFree(children.cast());
        }
        if status == 0 || parent == 0 {
            Err("Failed to resolve the Linux WebKit window hierarchy.".into())
        } else {
            Ok(parent)
        }
    }

    unsafe fn children_of(display: *mut Display, window: Window) -> Vec<Window> {
        let mut root = 0;
        let mut parent = 0;
        let mut children = ptr::null_mut();
        let mut child_count = 0;
        if XQueryTree(
            display,
            window,
            &mut root,
            &mut parent,
            &mut children,
            &mut child_count,
        ) == 0
            || children.is_null()
        {
            return Vec::new();
        }
        let result = std::slice::from_raw_parts(children, child_count as usize).to_vec();
        XFree(children.cast());
        result
    }

    unsafe fn window_area(display: *mut Display, window: Window) -> u64 {
        let mut root = 0;
        let mut x = 0;
        let mut y = 0;
        let mut width = 0;
        let mut height = 0;
        let mut border = 0;
        let mut depth = 0;
        if XGetGeometry(
            display,
            window,
            &mut root,
            &mut x,
            &mut y,
            &mut width,
            &mut height,
            &mut border,
            &mut depth,
        ) == 0
        {
            0
        } else {
            width as u64 * height as u64
        }
    }

    /// Tauri exposes the GTK top-level XID. Walk through full-size GTK wrapper
    /// windows to find WebKit's drawing layer, which must remain directly above
    /// the native video surface for transparent React controls to work.
    unsafe fn webview_layer(
        display: *mut Display,
        host: Window,
        excluded: Window,
    ) -> Option<(Window, Window)> {
        let host_area = window_area(display, host);
        if host_area == 0 {
            return None;
        }

        let mut parent = host;
        let mut layer = host;
        for _ in 0..8 {
            let next = children_of(display, layer)
                .into_iter()
                .filter(|child| *child != excluded)
                .map(|child| (child, window_area(display, child)))
                // Skip titlebar and input-only helper windows.
                .filter(|(_, area)| area.saturating_mul(2) >= host_area)
                .max_by_key(|(_, area)| *area)
                .map(|(child, _)| child);
            let Some(next) = next else {
                break;
            };
            parent = layer;
            layer = next;
        }

        (layer != host).then_some((layer, parent))
    }

    unsafe fn coordinates_in_parent(
        display: *mut Display,
        webview: Window,
        parent: Window,
        x: i32,
        y: i32,
    ) -> (i32, i32) {
        let mut translated_x = x;
        let mut translated_y = y;
        let mut child = 0;
        XTranslateCoordinates(
            display,
            webview,
            parent,
            x,
            y,
            &mut translated_x,
            &mut translated_y,
            &mut child,
        );
        (translated_x, translated_y)
    }

    unsafe fn stack_below_webview(display: *mut Display, video: Window, webview: Window) {
        let mut changes = XWindowChanges {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            border_width: 0,
            sibling: webview,
            stack_mode: BELOW,
        };
        XConfigureWindow(
            display,
            video,
            CW_SIBLING | CW_STACK_MODE,
            &mut changes,
        );
        // KWin/XWayland can ignore the ConfigureWindow sibling hint for an
        // override-redirect video surface after mpv maps its first frame.
        // Restack the pair explicitly (first entry is topmost), then force the
        // request through before returning to the compositor.
        let mut windows = [webview, video];
        XLowerWindow(display, video);
        XRaiseWindow(display, webview);
        XRestackWindows(display, windows.as_mut_ptr(), windows.len() as c_int);
        XSync(display, 0);
    }

    pub(crate) fn set_fullscreen(webview: isize, fullscreen: bool) -> Result<(), String> {
        if webview == 0 {
            return Err("Cannot change Linux fullscreen state without an X11 window.".into());
        }
        let mut slot = display_slot().lock().map_err(|e| e.to_string())?;
        let opened_here = *slot == 0;
        let display = if opened_here {
            unsafe { XOpenDisplay(ptr::null()) }
        } else {
            *slot as *mut Display
        };
        if display.is_null() {
            return Err("Cannot send the Linux fullscreen request: X11 is unavailable.".into());
        }

        let state_name = b"_NET_WM_STATE\0";
        let fullscreen_name = b"_NET_WM_STATE_FULLSCREEN\0";
        let state_atom =
            unsafe { XInternAtom(display, state_name.as_ptr().cast(), 0) };
        let fullscreen_atom =
            unsafe { XInternAtom(display, fullscreen_name.as_ptr().cast(), 0) };
        let mut event = XEvent {
            client_message: XClientMessageEvent {
                event_type: CLIENT_MESSAGE,
                serial: 0,
                send_event: 1,
                display,
                window: webview as Window,
                message_type: state_atom,
                format: 32,
                data: ClientMessageData {
                    longs: [
                        if fullscreen {
                            NET_WM_STATE_ADD
                        } else {
                            NET_WM_STATE_REMOVE
                        },
                        fullscreen_atom as c_long,
                        0,
                        1,
                        0,
                    ],
                },
            },
        };
        let sent = unsafe {
            XSendEvent(
                display,
                XDefaultRootWindow(display),
                0,
                SUBSTRUCTURE_NOTIFY_MASK | SUBSTRUCTURE_REDIRECT_MASK,
                &mut event,
            )
        };
        unsafe {
            XFlush(display);
            if opened_here {
                XCloseDisplay(display);
            }
        }
        if sent == 0 {
            Err("KWin rejected the Linux fullscreen request.".into())
        } else {
            if !opened_here {
                *slot = display as usize;
            }
            Ok(())
        }
    }

    pub(crate) fn create(
        host: isize,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<isize, String> {
        if host == 0 {
            return Err("Cannot create mpv video surface: X11 host window is missing".into());
        }

        let mut slot = display_slot().lock().map_err(|e| e.to_string())?;
        if *slot != 0 {
            unsafe {
                XCloseDisplay(*slot as *mut Display);
            }
            *slot = 0;
        }

        let display = unsafe { XOpenDisplay(ptr::null()) };
        if display.is_null() {
            return Err(
                "Embedded mpv requires X11/XWayland, but no X11 display is available.".into(),
            );
        }

        // Prefer a sibling beneath WebKit when GTK exposes a drawing-layer
        // XID. On Wayland/XWayland that layer often does not exist. In that
        // case a detached root sibling cannot remain below the composited
        // WebKit surface reliably (and visibly lags while the window moves),
        // so embed mpv as a real child of the Aurales window instead. mpv's
        // own OSC is enabled for that path because X11 children necessarily
        // paint above their parent.
        let (webview, parent, native_surface_controls) =
            match unsafe { webview_layer(display, host as Window, 0) } {
                Some((webview, parent)) => (webview, parent, false),
                None => (0, host as Window, true),
            };
        NATIVE_SURFACE_CONTROLS.store(native_surface_controls, Ordering::SeqCst);
        crate::commands::player_debug_log(format!(
            "[LINUX SURFACE] host={} webview={} parent={} native_controls={}",
            host, webview, parent, native_surface_controls
        ));
        let (parent_x, parent_y) = if native_surface_controls {
            (x, y)
        } else {
            unsafe { coordinates_in_parent(display, host as Window, parent, x, y) }
        };
        let window = unsafe {
            XCreateSimpleWindow(
                display,
                parent,
                parent_x,
                parent_y,
                width.max(1) as c_uint,
                height.max(1) as c_uint,
                0,
                0,
                0,
            )
        };
        if window == 0 {
            unsafe {
                XCloseDisplay(display);
            }
            return Err("Failed to create the Linux mpv X11 surface.".into());
        }

        unsafe {
            XMapWindow(display, window);
            if webview != 0 {
                stack_below_webview(display, window, webview);
            }
            XFlush(display);
        }
        *slot = display as usize;
        Ok(window as isize)
    }

    pub(crate) fn resize(host: isize, window: isize, x: i32, y: i32, width: i32, height: i32) {
        if host == 0 || window == 0 {
            return;
        }
        let Ok(slot) = display_slot().lock() else {
            return;
        };
        if *slot == 0 {
            return;
        }
        unsafe {
            let display = *slot as *mut Display;
            let Ok(parent) = parent_of(display, window as Window) else {
                return;
            };
            let (parent_x, parent_y) = coordinates_in_parent(display, host as Window, parent, x, y);
            XMoveResizeWindow(
                display,
                window as Window,
                parent_x,
                parent_y,
                width.max(1) as c_uint,
                height.max(1) as c_uint,
            );
            // A direct child is intentionally the visible/input surface and
            // uses mpv's OSC. Only sibling mode needs explicit restacking.
            if parent != host as Window {
                if let Some((stack_target, _)) =
                    webview_layer(display, host as Window, window as Window)
                        .filter(|(_, layer_parent)| *layer_parent == parent)
                {
                    stack_below_webview(display, window as Window, stack_target);
                }
            }
            XFlush(display);
        }
    }

    pub(crate) fn destroy(window: isize) {
        let Ok(mut slot) = display_slot().lock() else {
            return;
        };
        if *slot == 0 {
            return;
        }
        unsafe {
            if window != 0 {
                XDestroyWindow(*slot as *mut Display, window as Window);
                XFlush(*slot as *mut Display);
            }
            XCloseDisplay(*slot as *mut Display);
        }
        *slot = 0;
        NATIVE_SURFACE_CONTROLS.store(false, Ordering::SeqCst);
    }

    pub(crate) fn uses_native_surface_controls() -> bool {
        NATIVE_SURFACE_CONTROLS.load(Ordering::SeqCst)
    }
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn initialize_linux_x11() {
    linux_x11::initialize();
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn set_linux_window_fullscreen(
    parent_window: isize,
    fullscreen: bool,
) -> Result<(), String> {
    linux_x11::set_fullscreen(parent_window, fullscreen)
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn create_video_child(
    parent_window: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<isize, String> {
    linux_x11::create(parent_window, x, y, width, height)
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn resize_video_child(
    parent_window: isize,
    video_window: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    linux_x11::resize(parent_window, video_window, x, y, width, height);
}

#[cfg(target_os = "linux")]
pub(crate) fn destroy_video_child(video_window: isize) {
    linux_x11::destroy(video_window);
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub(crate) fn linux_video_uses_native_controls() -> bool {
    linux_x11::uses_native_surface_controls()
}
