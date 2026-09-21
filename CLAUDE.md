# Nudgy — project memory

Nudgy is a Tauri v2 desktop app (macOS + Windows) that runs continuously in the
background and answers one question: *where did my day actually go, and did I do the
things I said I would?* It samples the foreground app and the OS idle timer, accepts
explicit "Rich Presence" activity over a local IPC socket, pulls deadlines from Canvas,
and schedules the day with a deterministic slot finder plus an LLM — then checks its own
tracking database to verify whether a scheduled block actually happened.

## Context Budget & Token Guardrails

To prevent context bloat and preserve prompt caching, the agent must adhere to these limits:

1. **Never perform recursive workspace dumps.** Do not glob or inspect directory trees broadly.
2. **Strictly banned paths:** Never read, search across, or open:
   - `node_modules/`, `dist/`, `build/`
   - `src-tauri/target/` (Rust build artifacts)
   - Lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`
   - `.git/` logs, diffs, or commit histories
3. **Single-feature file scope:** Read and modify only the exact files required for the current prompt. Do not inspect unrelated modules "just to explore."
4. **Targeted lookups over full-file reads:** Use targeted string or ripgrep searches for exact function/type names rather than dumping entire multi-hundred-line files into context.
5. **No sub-agent sprawl:** Run sequentially in a single context; do not spawn parallel exploratory sub-agents to map the repository.
6. **Concise diffs only:** Output only the specific functions, interfaces, or blocks being modified. Never reprint complete, unchanged files.

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
| `src-tauri/src/nudge.rs` | Five-minute worker that announces a passed ceiling, once a day |
| `src-tauri/src/reminder.rs` | Minute worker that warns before a block; owns the notifications switch |
| `src-tauri/src/integrations/lms.rs` | Coursework from any LMS's iCal feed — no API key |
| `src-tauri/src/categorize.rs` | Offline keyword guess for an unclassified app. No model, no key |
| `src-tauri/src/scheduler.rs` | Schedule storage and the goal verifier |
| `src-tauri/src/secrets.rs` | Keychain wrapper; the only place a token is read |
| `src-tauri/src/tray.rs` | Tray menu, pause plumbing, ordered shutdown |
| `src-tauri/src/commands.rs` | Every `#[tauri::command]` |
| `src/services/` | `slotFinder.ts` (free-gap arithmetic), `workPlanner.ts` (splits an estimate into blocks), `dayPlanner.ts` (what to ask about next, and why nothing fits), `progress.ts` (streaks, averages, direction-aware trend) |
| `src/components/ProgressPage.tsx` | Day-by-day history, targets, and whether it is getting better |
| `src/lib/ipc.ts` | One typed wrapper per command; components never call `invoke` directly |
| `src/lib/types.ts` | Mirror of `models.rs` — keep the two in step |
| `src/hooks/` | `useLiveActivity`, `useUsageStats`, `usePermissions`, `useTasks`, `useSchedule`, `useCalendar`, `usePlans`, `useCurrentWork` (which block, and which class, is running now) |
| `src/components/shell/` | `IconRail` (view switcher) and `TopBar` (breadcrumb, search, tracking pill) |
| `src/components/TimelinePlanner.tsx` | Shell: Add task, month chip, category filter, Generate plan |
| `src/components/timeline/PlanTimeline.tsx` | The chart: day strip, vertical hour axis, Calendar and Plan columns for the selected day |
| `src/components/AddTaskDialog.tsx` | The only way to add a task by hand: title, time, activity type |
| `src/components/GeneratePlanDialog.tsx` | Walks the unplanned queue, proposes one real gap at a time, writes only what is accepted |
| `src/components/CanvasSyncSidebar.tsx` | Right panel: Canvas link, in-progress plans, coursework, user goals, focus-block picker |
| `src/components/AppRegistry.tsx` | The App registry tab: unrecognised apps, every known app, the category list |
| `src/lib/categories.ts` | The category vocabulary as a live store — `useCategories`, `categoryColor` |
| `src/lib/appearance.ts` | Text size, typeface and background, written onto `:root` |
| `src/components/SessionTimer.tsx` | The block's countdown. Reads the clock, writes nothing |
| `src/lib/layout.ts` | Today's panel order, split and hidden list, repaired on every read |
| `src/components/PanelLayout.tsx` | Renders those panels; in edit mode, the handles and the divider |

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
   Nothing reaches SQLite without an explicit yes, and skipping is always free. **There is
   no model anywhere in Nudgy** — `llm/`, `generate_agenda` and the LLM settings were
   removed once nothing called them. Category suggestions are a keyword table; scheduling
   is arithmetic. Adding an LLM back means re-earning its place, not restoring a file.
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
19. **The category vocabulary is data, not a constant.** `categories` is a table, so
    "is this a real category?" is asked of the loaded `Registry` (`has_category`), never
    of a compiled list — including on the RPC path. `Neutral` and `Idle` are built in and
    cannot be deleted; deleting any other moves its rules and its recorded time to
    `Neutral` rather than destroying either.
20. **A correction rewrites the past.** Changing an app's category runs
    `recategorize_samples`, so the time it already recorded moves with it — a fix that
    only applied going forward would leave every chart showing the answer you just
    corrected. An `exe` rule owns only its rows with no site label: re-filing Chrome must
    not drag an hour of YouTube along. Idle rows are never touched.
21. **Title rules are ranked, not alphabetical.** `priority` decides which rule claims a
    window — coursework (200) over media (100), and anything hand-written (300) over both.
    This is what makes "Chrome is Neutral *unless* it is school work" deterministic
    instead of a side effect of pattern ordering.
22. **A number moving is not news until you know which way the target points.** `trend`
    in `services/progress.ts` is direction-aware: less Gaming is `better`, less Development
    is `worse`. It also **excludes today**, because a partial morning measured against
    whole-day averages reads as a collapse every day before lunch — the easiest way for a
    progress page to lie.
23. **A streak is Duolingo-shaped.** It goes out at midnight and you relight it. A floor
    counts the moment it is met; a ceiling can never bank today, because staying under a
    limit is not finished until the day is, though going over ends the run there and then.
    An unobserved day breaks it — a ceiling on something you never do is satisfied by
    absence, so without that rule a new target would show a week-long streak instantly.
24. **Coursework needs no API key.** Every LMS publishes a per-user iCal feed, and
    `calendar.rs` already parses iCal — so `lms.rs` is only the reading between a VEVENT
    and an `LmsTask`. `external_id` is the feed's own UID, because `tasks` is
    `UNIQUE(provider, external_id)` and anything generated would duplicate the whole list
    on every sync. A Canvas token is the *upgrade*, not the way in: it is the only path
    that knows what has been submitted, and the UI says so rather than pretending a feed
    can.
25. **A reminder matches a window, never an instant.** The worker ticks once a minute and
    fires when `start - lead <= now < start - lead + 90`. Equality would miss every tick
    that landed a second late and every moment slept through. Late is useful; never is
    the failure worth designing against.
26. **One switch silences everything.** `notifications_enabled` is checked by `checkin`,
    `nudge` and `reminder` alike — a notification that still fired with the bell off
    would make the toggle a lie. Absent means on: a missing row must not silence the app.
27. **Only a ceiling interrupts.** `nudge.rs` fires on `at_most` targets and never on
    `at_least` ones: being told at 3pm that you are behind on reading helps nobody, while
    being told you have hit your limit is the whole point. Once per category per day,
    recorded in `settings` as `nudged:<category>`.
28. **A target may reorder the undated tail, never the deadlines.** `planQueue` takes the
    set of categories short of a floor and uses it only to break ties among goals with no
    due date. Something due tomorrow outranks being behind on a habit.
29. **Pausing holds the session, it does not discard it.** `AppState.session_freeze`
    keeps the seconds shown when pause was pressed; resuming shifts `session_started_at`
    back by that much so the counter carries on. Reporting zero made a pause look like a
    lost sitting.
30. **Type sizes are `rem`, never pixels, and the two size sliders are different
    mechanisms.** Every size in the `@theme` block multiplies `--text-scale`, so **Text**
    moves the words and leaves the layout alone; a hardcoded `text-[11px]` would sit still
    while everything around it grew. **Everything** is `zoom` on `#root`, which takes
    icons, rings and fixed pixel widths with it. A root `font-size` would have been
    neither — Tailwind's spacing is `rem` too, so it moved padding with type and left the
    second slider with nothing of its own to do. A control that *sets* either one is
    written in pixels and portalled out of `#root`, or it scales itself as you drag it.
31. **The timer is a view, not a source.** `SessionTimer` derives its phase from the
    block's start and the plan's own lengths, so it is right whenever you look —
    including after an hour with the app closed, which a counter would have to guess at.
    It writes nothing: what counts as work done stays what the watcher measured, so a
    countdown running against an app you are not using advances nothing.
32. **A calendar event keeps its `LOCATION`, and that is all.** The feed's own text is
    parsed and displayed verbatim. Routing between places was built and then removed:
    timing a trip needs a paid service, and `git log` has it if it is ever wanted back.
33. **The layout is furniture, and it is repaired on read.** Today's split and hidden list
    live in `localStorage` (`src/lib/layout.ts`) — per-viewer, never in SQLite, never in
    Rust. The split is a *ratio*, so it survives a resized window and a different monitor,
    which a stored pixel width gets wrong the moment you unplug. **The order is fixed**:
    panels resize and hide, they do not move, because reading left to right is the one
    thing about this page that should be the same on every machine. A stored layout
    outlives the code that wrote it, so `normalise()` runs on every read and every write:
    ids nothing knows about are dropped, a nonsense ratio falls back, and hiding the last
    panel is refused — a blank page with no way back is not a layout anybody chose. Edit
    mode is Today only. Anything foldable leaves a visible way back: the sync column's
    collapse leaves a tab against the right edge.
34. **One Nudgy, and one row per second per app.** A second copy is not a duplicate
    window: both tick, both write a sample for every second they are awake, and the day
    adds up past twenty-four hours while still looking like data.
    `tauri-plugin-single-instance` is registered *first*, before anything opens the
    database, and raises the window that is already tracking. Behind it, a unique index on
    `activity_samples(ts, process_name)` and `INSERT OR IGNORE` make the double count
    unreachable from SQL — a replayed flush after a crash is dropped rather than added,
    and `insert_samples` returns what landed, not what it was handed. Two *different* apps
    may share a timestamp; the same app twice in one second is the bug.

## Secrets

The Canvas token and the secret iCal URL live in the OS keychain via the `keyring` crate,
wrapped by `src-tauri/src/secrets.rs` (M3). Never in the `settings` table, never in a log
line, never returned to the frontend — the frontend may ask *whether* a secret is set, not
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