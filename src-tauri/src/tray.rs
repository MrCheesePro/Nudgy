use anyhow::{anyhow, Result};
use std::sync::atomic::Ordering;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::state::AppState;
use crate::watcher::flush;

pub const MENU_OPEN: &str = "open_dashboard";
pub const MENU_PAUSE: &str = "pause_tracking";
pub const MENU_QUIT: &str = "quit";

/// Kept in managed state so `set_paused` from the dashboard can tick the tray checkbox,
/// and the tray can be updated without rebuilding the menu.
pub struct TrayHandles {
    pub pause: CheckMenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Dashboard", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        MENU_PAUSE,
        "Pause Tracking",
        true,
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit Nudgy", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &pause, &separator, &quit_item])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| anyhow!("no default window icon to use for the tray"))?;

    TrayIconBuilder::with_id("nudgy-tray")
        .icon(icon)
        .tooltip("Nudgy")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_dashboard(app),
            MENU_PAUSE => {
                let state = app.state::<AppState>();
                let next = !state.paused.load(Ordering::Relaxed);
                if let Err(error) = apply_paused(app, next) {
                    log::error!("toggling pause failed: {error}");
                }
            }
            MENU_QUIT => quit(app),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayHandles { pause });
    Ok(())
}

pub fn show_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Single place that changes the pause flag, so the tray checkbox and the dashboard
/// toggle can never disagree.
pub fn apply_paused(app: &AppHandle, paused: bool) -> Result<()> {
    let state = app.state::<AppState>();
    state.paused.store(paused, Ordering::Relaxed);

    if let Some(handles) = app.try_state::<TrayHandles>() {
        handles.pause.set_checked(paused)?;
    }

    // Pausing is a natural flush point: whatever was tracked up to now should be on disk
    // before the watcher goes quiet.
    if paused {
        if let Err(error) = flush::flush_now(app) {
            log::error!("flush on pause failed: {error}");
        }
    }
    Ok(())
}

/// Ordered shutdown: get the buffered samples on disk, then exit.
pub fn quit(app: &AppHandle) {
    if let Err(error) = flush::flush_now(app) {
        log::error!("final flush failed: {error}");
    }
    app.exit(0);
}
