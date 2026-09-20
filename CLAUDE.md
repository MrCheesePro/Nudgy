# Nudgy — project memory

Nudgy is a Tauri v2 desktop app (macOS + Windows) that runs continuously in the
background and answers one question: *where did my day actually go, and did I do the
things I said I would?* It samples the foreground app and the OS idle timer, accepts
explicit "Rich Presence" activity over a local IPC socket, pulls deadlines from Canvas,
and schedules the day with a deterministic slot finder plus an LLM — then checks its own
tracking database to verify whether a scheduled block actually happened.

## Naming

| Thing | Value |
|---|---|
| Product name | Nudgy |
| Repo directory | `Nudge` |
| Rust crate / binary | `nudgy` (lib `nudgy_lib`) |
| Bundle identifier | `com.nudgy.app` |
| Database file | `nudgy.db` in the app data dir |
| Windows pipe | `\\.\pipe\nudgy-rpc` |
| macOS socket | `/tmp/nudgy-rpc.sock` |
| Frontend events | `nudgy://tick`, `nudgy://flushed`, `nudgy://sync-complete` |

## Architecture map

| Path | Owns |
|---|---|
| `src-tauri/src/lib.rs` | Builder, plugins, setup, window/run events, command registry |
| `src-tauri/src/state.rs` | `AppState`: db connection, sample buffer, pause flag, registry, live status |
| `src-tauri/src/models.rs` | Every serde type crossing the IPC boundary, plus tuning constants |
| `src-tauri/src/db/` | `open()` + pragmas, `migrations.rs` (forward-only), `queries.rs` (all SQL) |
| `src-tauri/src/watcher/mod.rs` | The 5-second tick loop and source arbitration |
| `src-tauri/src/watcher/platform.rs` | The only place `#[cfg(target_os)]` appears in the watcher |
| `src-tauri/src/watcher/macos.rs` | NSWorkspace + CoreGraphics probes |
| `src-tauri/src/watcher/registry.rs` | Categorizer, redaction, seed loader |
| `src-tauri/src/watcher/flush.rs` | 45-second batch writer |
| `src-tauri/src/watcher/windows.rs` | Win32 probes — **only compiled in CI**, never here |
| `src-tauri/src/rpc/mod.rs` | Rich Presence listener, presence map, payload validation |
| `src-tauri/src/integrations/` | `LmsProvider` trait, the Canvas client, and `calendar.rs` (iCal feed + RRULE expansion) |
| `src-tauri/src/plans.rs` | Work plans: estimate, measured progress, the check-in loop |
| `src-tauri/src/checkin.rs` | Once-a-minute worker that fires the halfway check-in |
| `src-tauri/src/llm/mod.rs` | OpenAI-compatible JSON completion, used only by the scheduler |
| `src-tauri/src/scheduler.rs` | Schedule storage and the goal verifier |
| `src-tauri/src/secrets.rs` | Keychain wrapper; the only place a token is read |
| `src-tauri/src/tray.rs` | Tray menu, pause plumbing, ordered shutdown |
| `src-tauri/src/commands.rs` | Every `#[tauri::command]` |
| `src/services/` | `slotFinder.ts` (free-gap arithmetic), `workPlanner.ts` (splits an estimate into blocks), `dayPlanner.ts` (what to ask about next, and why nothing fits) |
| `src/lib/ipc.ts` | One typed wrapper per command; components never call `invoke` directly |
| `src/lib/types.ts` | Mirror of `models.rs` — keep the two in step |
| `src/hooks/` | `useLiveActivity`, `useUsageStats`, `usePermissions`, `useTasks`, `useSchedule`, `useCalendar`, `usePlans`, `useCurrentWork` (which block, and which class, is running now) |
| `src/components/shell/` | `IconRail` (view switcher) and `TopBar` (breadcrumb, search, tracking pill) |
| `src/components/TimelinePlanner.tsx` | Shell: Add task, month chip, category filter, Generate plan |
| `src/components/timeline/PlanTimeline.tsx` | The chart: day strip, vertical hour axis, Calendar and Plan columns for the selected day |
| `src/components/AddTaskDialog.tsx` | The only way to add a task by hand: title, time, activity type |
| `src/components/GeneratePlanDialog.tsx` | Walks the unplanned queue, proposes one real gap at a time, writes only what is accepted |
| `src/components/CanvasSyncSidebar.tsx` | Right panel: Canvas link, in-progress plans, coursework, user goals, focus-block picker |

The tick loop contains no `cfg` blocks. Platform differences are resolved in
`watcher/platform.rs`, which re-exports `foreground`, `idle_seconds`,
`permission_status` and `request_screen_recording` from the right module. Adding a
platform means adding a module, not editing the loop.

## Invariants

These are load-bearing. Breaking one does not fail loudly — it produces plausible,
wrong data.

1. **Never hold a lock across an `.await`.** `AppState` uses `std` locks on purpose:
   their guards are `!Send`, so this is a compile error rather than a production
   deadlock.
2. **Rust owns every SQLite write.** One writer connection, one migration runner. The
   frontend reads through commands only — no `tauri-plugin-sql`, no second pool.
3. **Idle time is never attributed to the foreground app.** Over
   `IDLE_THRESHOLD_SECONDS` (180) the tick records the `__idle__` sentinel in category
   `Idle`. Goal verification filters on `is_idle = 0` for the same reason.
4. **The arithmetic proposes, the user disposes.** `Generate plan` reads the calendar and
   the timeline, places work with `placeWork`, and asks about one slot at a time.
   Nothing reaches SQLite without an explicit yes, and skipping is always free. No model
   is involved: `generate_agenda` and `llm/` are still wired but have no caller.
5. **Explicit RPC presence outranks a guessed window title**, and expires 60 s after the
   client's last message.
6. **No keystrokes, no mouse coordinates, no screenshots, no assignment descriptions.**
   Only the OS idle counter and the foreground app. Redaction runs *before* the sample
   is constructed, so a private title is never in memory, never flushed, never
   recoverable.
7. **Migrations are append-only.** Add an entry to `MIGRATIONS`; never edit a shipped
   one. `PRAGMA user_version` tracks progress.
8. **Only apps a person could click get tracked.** macOS filters on
   `NSApplicationActivationPolicy::Regular`, which excludes `loginwindow`,
   `SecurityAgent`, `coreautha` and every other background agent without a blocklist.
   Windows names its shell surfaces explicitly in `is_system_shell`. A filtered tick
   records nothing rather than guessing.
9. **Nobody types an executable name.** `Registry::resolve_from_text` infers the app from
   a goal's wording ("draw in Clip Studio" → `jp.co.celsys.ClipStudioPaint`) by matching
   normalized display names, longest match wins. No match is a valid outcome: the goal is
   then verified against any non-idle time inside its blocks. Reading the *currently*
   focused app at goal-creation time would be wrong — that app is always Nudgy.
10. **A plan is a conversation, not a prediction.** `plans.rs` measures real worked time
   inside a plan's blocks and asks the user at the halfway mark whether the estimate
   still holds. "Needs longer" grows the estimate and reschedules the next question;
   only "done" ends the loop. Progress is never self-reported — it is tracked time.
11. **Blocks measure time, not text.** The day runs top to bottom at 72px per hour, so a
    block's height is its real duration. Height is cheap and vertical scrolling is
    natural, which is why the axis is vertical: nothing has to scroll sideways and
    nothing gets squeezed. Secondary labels drop out when a block is too short to hold
    them rather than the block stretching to fit its own caption.
12. **Deleting a plan deletes its blocks**, and deleting a goal deletes its plan. Blocks
    that outlive their plan are work nothing owns and nothing can verify. Deleting is the
    only thing that removes anything: **finishing hides, and clearing hides — neither
    deletes.** A done plan keeps its blocks and is still returned by `all_progress`, so
    the timeline can draw it as finished rather than as never-started; `load_active` stays
    narrow because the check-in loop must not ask about it again. Clearing the Completed
    list writes a timestamp and filters against it.
13. **Re-planning edits, never duplicates.** A `Plannable` carries the `planId` it is
    editing; confirming drops that plan and its blocks before laying down new ones. Only
    an *active* plan is a candidate — editing a finished one would delete the record of
    work already done.
14. **Anything irreversible says what it will take with it.** `ConfirmDialog` names the
    consequences that the button does not show: removing a goal takes its plan and every
    block that plan owns.
15. **A bar belongs to exactly one day.** The timeline is a single day at hour
    resolution, with a day strip to move between days. A plan split across Tuesday and
    Thursday draws a session on each rather than one bar spanning the gap — the gap is
    not work. Blocks inside a plan show the plan's overall percentage; standalone blocks
    show their own.
16. **The planning window rolls forward, and a refusal names its cause.** The planner
    looks `HORIZON_DAYS` (7) ahead from now, so a full evening means tomorrow morning, not
    "no free time left today". When nothing fits, `explainNoSlots` says what is in the way
    — the commitment, the deadline, or the size of the biggest gap. A deadline already in
    the past is not a bound: overdue work is placed as soon as possible, inside a soft
    three-day horizon.
17. **A block says what the time is for; the live flags say whether it is happening.**
    `useCurrentWork` decides membership by the clock alone, so alt-tabbing to Finder
    changes a dot from green to amber and never erases the course label. Verification
    still uses the process match — that is a different question, asked in `plans.rs`.
18. **Calendar events are immovable.** Anything from the iCal feed becomes a commitment
    the planner refuses to schedule over. All-day events are ignored on purpose: they
    mark a day rather than occupy it.

## Secrets

Canvas tokens and LLM API keys live in the OS keychain via the `keyring` crate, wrapped
by `src-tauri/src/secrets.rs` (M3). Never in the `settings` table, never in a log line,
never returned to the frontend — the frontend may ask *whether* a secret is set, not
what it is.

## Adding a command

Four edits, or it is half-wired:

1. handler in `src-tauri/src/commands.rs`
2. register it in the `generate_handler!` list in `src-tauri/src/lib.rs`
3. typed wrapper in `src/lib/ipc.ts`
4. types in `src/lib/types.ts` (must match the serde `rename_all = "camelCase"` output)

Command arguments are declared `snake_case` in Rust and called `camelCase` from TS;
Tauri converts. Plugin permissions go in `src-tauri/capabilities/default.json` — commands
defined by this app do not need an entry there.

## Build & verify

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # rustup installed without modifying the profile

npm run tauri dev                      # app + HMR
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit

# what actually landed on disk
sqlite3 ~/Library/Application\ Support/com.nudgy.app/nudgy.db \
  "SELECT category, SUM(duration_seconds)/60 AS mins FROM activity_samples
   WHERE ts > strftime('%s','now','-1 day') GROUP BY category ORDER BY mins DESC;"
```

The idle path is the one worth testing by hand: leave the machine untouched for over
180 seconds and confirm samples flip to `is_idle = 1` / `category = 'Idle'` instead of
continuing to credit the foreground app.

## Milestone status

- [x] **M0** — toolchain, scaffold, Tailwind v4, naming, this file
- [x] **M1** — tracking core: schema + migrations, macOS probe, registry + redaction,
      batch flush, tray + close interception, permissions pre-flight, live dashboard
- [x] **M2** — Rich Presence listener + `scripts/rpc-test-client.mjs`; verified end to end
      (a claim decorates the focused app, `source = 'rpc'`)
- [x] **M3** — Canvas client (pagination, 429 backoff, sanitation), keychain secrets,
      Task Hub, Settings dialog. **Not verified against a live Canvas instance** — needs a
      real base URL and token.
- [x] **M4** — slot finder, work planner and day planner (Vitest), goal verifier (4 Rust
      cases), Schedule Panel. The LLM agenda path is **retired**: planning is deterministic
      and confirmed slot by slot in `GeneratePlanDialog`. `agendaSchema.ts` and
      `promptFormatter.ts` are gone; the Rust LLM client stays, uncalled.
- [x] **M5** — `watcher/windows.rs` + `.github/workflows/build.yml`. **Never compiled** —
      the `windows-latest` job is where it is first proven.

## Known deviations from the original spec

- **`rusqlite` instead of `tauri-plugin-sql`.** The hot write path is a Rust background
  task; routing it through the JS layer would be backwards, and two pools on one file
  invite `SQLITE_BUSY` under WAL.
- **Tailwind v4** (CSS-first, `@import "tailwindcss"` + `@theme` in `src/index.css`), so
  there is no `tailwind.config.js`.
- **Three views, not four.** The rail is Overview / Timeline Planner / App Registry. The
  separate Coursework view was folded into the right sidebar, which is now the single
  home for anything with a deadline or an intention: Canvas assignments plus
  user-entered goals. Measured-time panels (donut, top apps) live only on Overview, so
  nothing is shown twice.
- **Light blush theme, no dark mode.** Tokens live in `@theme` in `src/index.css`:
  `canvas` / `surface` / `surface-sunken` for planes, `edge` / `edge-strong` for borders,
  `ink` / `ink-soft` / `ink-mute` for text, `rose` / `rose-deep` / `rose-wash` for accent,
  `ok` / `warn` / `bad` for status. Components use these names, never raw hex — changing
  the palette is a one-file edit.
- **Windows code is unverified on this machine** — no Windows toolchain here. M5 adds a
  CI matrix so the first real Windows compile is visible rather than silent.
