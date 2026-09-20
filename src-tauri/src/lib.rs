mod checkin;
mod commands;
mod db;
mod error;
mod integrations;
mod llm;
mod models;
mod plans;
mod rpc;
mod scheduler;
mod secrets;
mod state;
mod tray;
mod watcher;

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use state::AppState;
use watcher::registry::{self, Registry};

pub const DATABASE_FILE: &str = "nudgy.db";

/// The one place the database location is decided.
pub fn database_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("resolving application data directory")?;
    Ok(dir.join(DATABASE_FILE))
}

/// Locates the bundled registry seed. In a packaged app it lives in the resource
/// directory; in `tauri dev` we fall back to the source tree so a fresh checkout still
/// categorizes apps on first run.
fn seed_file_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = app
        .path()
        .resolve("resources/known_apps.json", BaseDirectory::Resource)
    {
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(debug_assertions)]
    {
        let fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/known_apps.json");
        if fallback.exists() {
            return Some(fallback);
        }
    }

    None
}

fn setup(app: &AppHandle) -> Result<()> {
    let path = database_path(app)?;
    let connection = db::open(&path)?;
    log::info!("database ready at {}", path.display());

    match seed_file_path(app) {
        Some(seed) => {
            let count = registry::seed_from_file(&connection, &seed)?;
            log::info!("registry seeded from {} ({count} rules)", seed.display());
        }
        // Not fatal: everything falls back to Neutral until the user maps apps by hand.
        None => log::warn!("registry seed file not found; starting with an empty registry"),
    }

    let compiled = Registry::load(&connection)?;
    app.manage(AppState::new(connection, compiled));

    tray::build(app)?;
    watcher::spawn(app.clone());
    watcher::flush::spawn(app.clone());
    rpc::spawn(app.clone());
    checkin::spawn(app.clone());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("nudgy".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            setup(app.handle()).map_err(|error| -> Box<dyn std::error::Error> {
                Box::new(std::io::Error::other(error.to_string()))
            })
        })
        // Closing the window hides it instead of ending the process — continuous
        // tracking is the whole product, so the window is a view, not the app.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_live_status,
            commands::get_usage_breakdown,
            commands::get_app_totals,
            commands::get_window_totals,
            commands::list_unmapped_processes,
            commands::get_app_rules,
            commands::register_app,
            commands::delete_app_rule,
            commands::resolve_app_for_text,
            commands::get_redaction_rules,
            commands::add_redaction_rule,
            commands::delete_redaction_rule,
            commands::get_settings,
            commands::set_setting,
            commands::has_secret,
            commands::set_secret,
            commands::clear_secret,
            commands::get_tasks,
            commands::set_task_completed,
            commands::sync_canvas,
            commands::get_calendar_events,
            commands::get_schedule,
            commands::get_schedule_range,
            commands::save_schedule,
            commands::verify_schedule,
            commands::verify_goal,
            commands::generate_agenda,
            commands::create_plan,
            commands::get_plans,
            commands::respond_checkin,
            commands::delete_plan,
            commands::get_paused,
            commands::set_paused,
            commands::check_macos_permissions,
            commands::request_screen_recording_access,
            commands::flush_samples,
            commands::get_database_path,
            commands::open_privacy_settings,
        ])
        .build(tauri::generate_context!())
        .map_err(|error| anyhow!("building Nudgy: {error}"))
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // Both arms fire on a normal quit; flushing twice is harmless (the second drain
        // finds an empty buffer) and guarantees the last samples reach disk.
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Err(error) = watcher::flush::flush_now(app) {
                log::error!("flush during shutdown failed: {error}");
            }
        }
        _ => {}
    });
}
