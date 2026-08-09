//! GTK-native libmpv video composition for Linux.
//!
//! The WebKit view remains the top child of a GtkOverlay while libmpv renders
//! into a GtkGLArea underneath it. This avoids foreign X11 child windows, so
//! the same React controls work on native Wayland and X11.

use crate::libmpv_player::LibMpvPlayer;
use gtk::glib;
use gtk::glib::translate::IntoGlib;
use gtk::prelude::*;
use std::cell::{Cell, RefCell};
use std::ffi::{c_char, c_int, c_uchar, c_void};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use webkit2gtk::WebViewExt;

const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

#[link(name = "GL")]
extern "C" {
    fn glGetIntegerv(name: u32, value: *mut c_int);
    fn glXGetProcAddressARB(name: *const c_uchar) -> *mut c_void;
}

unsafe extern "C" fn resolve_gl_symbol(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    if name.is_null() {
        return std::ptr::null_mut();
    }
    let symbol = libc::dlsym(libc::RTLD_DEFAULT, name);
    if !symbol.is_null() {
        symbol
    } else {
        glXGetProcAddressARB(name.cast())
    }
}

struct RenderLayer {
    overlay: gtk::Overlay,
    fixed: gtk::Fixed,
    area: gtk::GLArea,
    fill_window: Rc<Cell<bool>>,
}

thread_local! {
    static RENDER_LAYER: RefCell<Option<RenderLayer>> = const { RefCell::new(None) };
    static CURRENT_PLAYER: RefCell<Option<Arc<LibMpvPlayer>>> = const { RefCell::new(None) };
}

fn disconnect_tauri_resize_handlers(webview: &webkit2gtk::WebView) {
    // tauri-runtime-wry's Linux resize callbacks assume the WebView always has
    // the original `WebView -> GtkBox -> GtkWindow` ancestry and unwrap that
    // assumption on every pointer/touch press. The render overlay necessarily
    // inserts a GtkOverlay into that chain. Remove those two toolkit-level
    // callbacks before reparenting; normal WebKit pointer handling is the
    // widget's class handler and is not removed here.
    for signal_name in ["button-press-event", "touch-event"] {
        let Some(signal_id) = glib::subclass::SignalId::lookup(signal_name, webview.type_()) else {
            continue;
        };
        let disconnected = unsafe {
            glib::gobject_ffi::g_signal_handlers_disconnect_matched(
                webview.as_ptr() as *mut glib::gobject_ffi::GObject,
                glib::gobject_ffi::G_SIGNAL_MATCH_ID,
                signal_id.into_glib(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        crate::commands::player_debug_log(format!(
            "[LINUX RENDER] disconnected {disconnected} incompatible Tauri {signal_name} handler(s)"
        ));
    }
}

fn install_overlay_resize_handler(webview: &webkit2gtk::WebView) {
    webview.connect_button_press_event(|webview, event| {
        if event.button() != 1 {
            return glib::Propagation::Proceed;
        }
        let Some(toplevel) = webview.toplevel() else {
            return glib::Propagation::Proceed;
        };
        let Ok(window) = toplevel.dynamic_cast::<gtk::Window>() else {
            return glib::Propagation::Proceed;
        };
        if window.is_decorated() || !window.is_resizable() || window.is_maximized() {
            return glib::Propagation::Proceed;
        }
        let Some(surface) = window.window() else {
            return glib::Propagation::Proceed;
        };
        let (root_x, root_y) = event.root();
        let (window_x, window_y) = surface.position();
        let x = root_x - f64::from(window_x);
        let y = root_y - f64::from(window_y);
        let width = f64::from(surface.width());
        let height = f64::from(surface.height());
        let border = f64::from(surface.scale_factor() * 5);
        let left = x >= 0.0 && x < border;
        let right = x <= width && x > width - border;
        let top = y >= 0.0 && y < border;
        let bottom = y <= height && y > height - border;
        let edge = match (left, right, top, bottom) {
            (true, _, true, _) => Some(gtk::gdk::WindowEdge::NorthWest),
            (_, true, true, _) => Some(gtk::gdk::WindowEdge::NorthEast),
            (true, _, _, true) => Some(gtk::gdk::WindowEdge::SouthWest),
            (_, true, _, true) => Some(gtk::gdk::WindowEdge::SouthEast),
            (true, _, _, _) => Some(gtk::gdk::WindowEdge::West),
            (_, true, _, _) => Some(gtk::gdk::WindowEdge::East),
            (_, _, true, _) => Some(gtk::gdk::WindowEdge::North),
            (_, _, _, true) => Some(gtk::gdk::WindowEdge::South),
            _ => None,
        };
        if let Some(edge) = edge {
            surface.begin_resize_drag(edge, 1, root_x as i32, root_y as i32, event.time());
        }
        glib::Propagation::Proceed
    });
}

fn render_frame(area: &gtk::GLArea) -> glib::Propagation {
    if area.error().is_some() {
        return glib::Propagation::Stop;
    }
    CURRENT_PLAYER.with(|slot| {
        let player = slot.borrow().clone();
        let Some(player) = player else {
            return;
        };
        let mut framebuffer = 0;
        unsafe {
            glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut framebuffer);
        }
        let scale = area.scale_factor().max(1);
        let width = area.allocated_width().max(1) * scale;
        let height = area.allocated_height().max(1) * scale;
        if let Err(error) = unsafe { player.render_opengl_frame(framebuffer, width, height) } {
            crate::commands::player_debug_log(format!("[LINUX RENDER] frame failed: {error}"));
        }
    });
    glib::Propagation::Stop
}

fn install_layer(webview: &webkit2gtk::WebView) -> Result<(), String> {
    let already_installed = RENDER_LAYER.with(|slot| slot.borrow().is_some());
    if already_installed {
        return Ok(());
    }

    // libmpv is composed inside this GTK window, so only the WebKit widget
    // needs alpha. Keeping the top-level Linux window transparent makes
    // WebKitGTK's fallback renderer accumulate stale control frames and can
    // leave the GLArea completely black in packaged builds. The Linux Tauri
    // config therefore uses an opaque top-level; make the WebView itself
    // transparent explicitly so CSS transparency still reveals the video.
    webview.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));

    let parent_widget = webview
        .parent()
        .ok_or_else(|| "Linux WebKit view has no GTK parent".to_string())?;
    let parent = parent_widget
        .dynamic_cast::<gtk::Container>()
        .map_err(|_| "Linux WebKit parent is not a GTK container".to_string())?;

    let overlay = gtk::Overlay::new();
    overlay.set_hexpand(true);
    overlay.set_vexpand(true);
    let fixed = gtk::Fixed::new();
    fixed.set_hexpand(true);
    fixed.set_vexpand(true);
    let area = gtk::GLArea::new();
    area.set_has_alpha(false);
    area.set_auto_render(true);
    area.set_required_version(3, 2);
    area.connect_render(|area, _| render_frame(area));
    let frame_area = area.clone();
    glib::timeout_add_local(Duration::from_millis(16), move || {
        if frame_area.is_visible() {
            frame_area.queue_render();
        }
        glib::ControlFlow::Continue
    });

    let fill_window = Rc::new(Cell::new(true));
    let resize_area = area.clone();
    let resize_fill = Rc::clone(&fill_window);
    overlay.connect_size_allocate(move |_, allocation| {
        if resize_fill.get() {
            resize_area.set_size_request(allocation.width().max(1), allocation.height().max(1));
        }
    });

    disconnect_tauri_resize_handlers(webview);
    parent.remove(webview);
    fixed.put(&area, 0, 0);
    overlay.add(&fixed);
    overlay.add_overlay(webview);
    overlay.set_overlay_pass_through(webview, false);
    parent.add(&overlay);
    install_overlay_resize_handler(webview);
    overlay.show_all();
    area.hide();

    RENDER_LAYER.with(|slot| {
        *slot.borrow_mut() = Some(RenderLayer {
            overlay,
            fixed,
            area,
            fill_window,
        });
    });
    Ok(())
}

fn apply_viewport(layer: &RenderLayer, x: i32, y: i32, width: i32, height: i32) {
    let scale = layer.overlay.scale_factor().max(1);
    let overlay_width = layer.overlay.allocated_width().max(1);
    let overlay_height = layer.overlay.allocated_height().max(1);
    let requested_fill = width <= 0
        || height <= 0
        || (x == 0
            && y == 0
            && (width / scale - overlay_width).abs() <= 2
            && (height / scale - overlay_height).abs() <= 2);
    layer.fill_window.set(requested_fill);

    let (logical_x, logical_y, logical_width, logical_height) = if requested_fill {
        (0, 0, overlay_width, overlay_height)
    } else {
        (
            x / scale,
            y / scale,
            (width / scale).max(1),
            (height / scale).max(1),
        )
    };
    layer.fixed.move_(&layer.area, logical_x, logical_y);
    layer
        .area
        .set_size_request(logical_width.max(1), logical_height.max(1));
    layer.area.queue_resize();
    layer.area.queue_render();
}

fn attach_on_main_thread(
    webview: webkit2gtk::WebView,
    player: Arc<LibMpvPlayer>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    install_layer(&webview)?;
    RENDER_LAYER.with(|slot| -> Result<(), String> {
        let slot = slot.borrow();
        let layer = slot
            .as_ref()
            .ok_or_else(|| "Linux render layer was not installed".to_string())?;
        layer.area.show();
        layer.area.make_current();
        if let Some(error) = layer.area.error() {
            return Err(format!("Failed to create GTK OpenGL context: {error}"));
        }
        unsafe {
            player.create_opengl_render_context(resolve_gl_symbol)?;
        }
        CURRENT_PLAYER.with(|current| {
            if let Some(previous) = current.replace(Some(Arc::clone(&player))) {
                if !Arc::ptr_eq(&previous, &player) {
                    unsafe {
                        previous.free_opengl_render_context();
                    }
                }
            }
        });
        apply_viewport(layer, x, y, width, height);
        Ok(())
    })
}

pub(crate) fn attach(
    app: &tauri::AppHandle,
    player: Arc<LibMpvPlayer>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main Aurales window was not found".to_string())?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            let result = attach_on_main_thread(platform.inner(), player, x, y, width, height);
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to access Linux WebKit view: {error}"))?;
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| "Timed out while attaching the Linux video renderer".to_string())?
}

pub(crate) fn resize(
    app: &tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main Aurales window was not found".to_string())?;
    window
        .with_webview(move |_| {
            RENDER_LAYER.with(|slot| {
                if let Some(layer) = slot.borrow().as_ref() {
                    apply_viewport(layer, x, y, width, height);
                }
            });
        })
        .map_err(|error| format!("Failed to resize Linux video renderer: {error}"))
}

pub(crate) fn detach(player: &Arc<LibMpvPlayer>) {
    let player = Arc::clone(player);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    glib::MainContext::default().invoke(move || {
        RENDER_LAYER.with(|slot| {
            if let Some(layer) = slot.borrow().as_ref() {
                layer.area.make_current();
                CURRENT_PLAYER.with(|current| {
                    let is_current = current
                        .borrow()
                        .as_ref()
                        .map(|active| Arc::ptr_eq(active, &player))
                        .unwrap_or(false);
                    if is_current {
                        unsafe {
                            player.free_opengl_render_context();
                        }
                        current.borrow_mut().take();
                        layer.area.hide();
                    }
                });
            }
        });
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_secs(3));
}
