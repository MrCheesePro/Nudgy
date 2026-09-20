# Nudgy

A desktop productivity daemon for macOS and Windows. Nudgy watches which app is in the
foreground and whether you are actually at the keyboard, accepts explicit activity from
editors and extensions over a local socket, syncs your Canvas deadlines, and plans your
day — then checks its own records to tell you whether the plan happened.

Built with Tauri v2 (Rust backend, React + TypeScript frontend) and SQLite.

## What it tracks

- The frontmost application, sampled every 5 seconds.
- The system idle timer. After 180 seconds without input, time is recorded as **Idle**
  rather than credited to whatever window happens to be open.
- Window titles, when the OS allows it — matched against a Discord-style registry that
  maps executables and title patterns to human names and categories.

## What it never touches

No keystrokes. No mouse coordinates. No screenshots. No clipboard. The only input signal
read is the OS-level "seconds since last event" counter, which is a single number.

Window titles matching the redaction list (password managers, private browsing) are
stored as `[Private]` — the redaction happens before the sample is built, so the real
title is never held in memory or written to disk.

Everything stays on your machine. The only outbound network calls are the ones you
configure yourself: your Canvas instance and, if you enable the scheduler, your chosen
LLM endpoint.

## Requirements

- Rust (stable) and Node 20+
- macOS 11+ or Windows 10+
- On macOS: Screen Recording permission is optional. Without it Nudgy still tracks which
  app is in focus; window titles stay blank.

## Running it

```bash
npm install
npm run tauri dev
```

Closing the window hides Nudgy to the system tray and tracking continues. Use the tray
menu to open the dashboard, pause tracking, or quit.

## Local Rich Presence socket

Nudgy listens on `\\.\pipe\nudgy-rpc` (Windows) or `/tmp/nudgy-rpc.sock` (macOS) for
newline-delimited JSON:

```json
{ "client_id": "vscode-extension", "activity": "Writing Lab Report", "category": "Productivity", "started_at": 1715000000 }
```

Explicit presence outranks the guessed window title and expires 60 seconds after the
client's last message.

**Security note:** like Discord's, this socket is unauthenticated — any process running
as your user can write to it and claim activity. The socket file is created mode `0600`,
payloads are capped and schema-validated, and RPC can be switched off in Settings. It is
a convenience channel for tools you already run, not a trust boundary.

## Data

SQLite, in your platform's app data directory:

- macOS: `~/Library/Application Support/com.nudgy.app/nudgy.db`
- Windows: `%APPDATA%\com.nudgy.app\nudgy.db`

It is a plain database file. Query it, back it up, or delete it — deleting it erases your
history and Nudgy starts a fresh one on next launch.
