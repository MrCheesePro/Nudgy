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
| `src-tauri/src/watcher/browser.rs` | Asks the browser for the front tab's **host**, and keeps nothing else |
| `src-tauri/src/watcher/flush.rs` | 45-second batch writer |
| `src-tauri/src/watcher/windows.rs` | Win32 probes — **only compiled in CI**, never here |
| `src-tauri/src/rpc/mod.rs` | Rich Presence listener, presence map, payload validation |
| `src-tauri/src/integrations/` | `LmsProvider` trait, the Canvas client, and `calendar.rs` (iCal feed + RRULE expansion) |
| `src-tauri/src/plans.rs` | Work plans: estimate, measured progress, the check-in loop |
| `src-tauri/src/checkin.rs` | Once-a-minute worker that fires the halfway check-in |
| `src-tauri/src/nudge.rs` | Five-minute worker that announces a passed ceiling, once a day |
| `src-tauri/src/reminder.rs` | Minute worker that warns before a block; owns the notifications switch |
| `src-tauri/src/integrations/lms.rs` | Coursework from any LMS's iCal feed — no API key |
| `src-tauri/src/events.rs` | Hand-added events and their repeat rules, expanded per window |
| `src-tauri/src/habits.rs` | Habits and their ticks. Storage only — the streaks are in TS |
| `src-tauri/src/syllabus.rs` | Reads meeting patterns out of a syllabus. Proposes; writes nothing |
| `src/services/habits.ts` | `habitStreak`, `dueOn` — pure and tested |
| `src/services/commitments.ts` | Targets and habits read as one list: `stateOn`, `streakFor`, `perfectStreak` |
| `src-tauri/src/categorize.rs` | Offline keyword guess for an unclassified app. No model, no key |
| `src-tauri/src/scheduler.rs` | Schedule storage and the goal verifier |
| `src-tauri/src/secrets.rs` | Keychain wrapper; the only place a token is read |
| `src/lib/chime.ts` | Synthesised tones, an imported sound, and the volume both play at |
| `src-tauri/src/tray.rs` | Tray menu, pause plumbing, ordered shutdown |
| `src-tauri/src/commands.rs` | Every `#[tauri::command]` |
| `src/services/` | `slotFinder.ts` (free-gap arithmetic), `workPlanner.ts` (splits an estimate into blocks), `dayPlanner.ts` (what to ask about next, and why nothing fits), `progress.ts` (streaks, averages, direction-aware trend) |
| `src/components/ProgressPage.tsx` | Day-by-day history, commitments, and whether it is getting better |
| `src/components/CommitmentGrid.tsx` | Every commitment against every day — kept, missed, open, not due, unwatched |
| `src/components/CommitmentStrip.tsx` | What you owe today: habit chips you tick, target chips the watcher fills |
| `src/components/CommitmentsDialog.tsx` | Adding and editing both kinds, behind one toggle |
| `src/lib/ipc.ts` | One typed wrapper per command; components never call `invoke` directly |
| `src/lib/types.ts` | Mirror of `models.rs` — keep the two in step |
| `src/hooks/` | `useLiveActivity`, `useUsageStats`, `usePermissions`, `useTasks`, `useSchedule`, `useCalendar`, `usePlans`, `useCurrentWork` (which block, and which class, is running now) |
| `src/components/shell/` | `IconRail` (view switcher) and `TopBar` (breadcrumb, tracking pill, window chrome) |
| `src/lib/platform.ts` | `IS_MAC` and the traffic-light width — the only place the chrome differs |
| `src/components/TimelinePlanner.tsx` | Shell: Add task, month chip, category filter, Generate plan |
| `src/components/timeline/PlanTimeline.tsx` | The chart: day strip, vertical hour axis, Calendar and Plan columns for the selected day |
| `src/components/AddTaskDialog.tsx` | The only way to add a task by hand: title, time, activity type |
| `src/components/TimeField.tsx` | The clock you type straight through; rules in `lib/clockInput.ts` |
| `src/components/DateField.tsx` | The same for a date; rules in `lib/dateInput.ts` |
| `src/components/GeneratePlanDialog.tsx` | Walks the unplanned queue, proposes one real gap at a time, writes only what is accepted |
| `src/components/CanvasSyncSidebar.tsx` | Right panel: Canvas link, in-progress plans, coursework, user goals, focus-block picker |
| `src/components/AppRegistry.tsx` | The App registry tab: unrecognised apps, every known app, the category list |
| `src/lib/categories.ts` | The category vocabulary as a live store — `useCategories`, `categoryColor` |
| `src/lib/appearance.ts` | Text size, typeface and background, written onto `:root` |
| `src/lib/theme.ts` | The presets, and a whole theme derived from one picked colour |
| `src/components/SessionTimer.tsx` | The block's countdown. Reads the clock, writes nothing |
| `src/components/Tour.tsx` | First-launch guided tour: spotlights `data-tour` elements, replayed from the rail's ? |

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
   Only the OS idle counter, the foreground app, and — from a browser that will answer —
   **the host of the page in front. Never the URL.** `watcher/browser.rs` asks over an
   Apple event on macOS and off the address bar through UI Automation on Windows, and
   `host_of` throws the path and query away in the same expression that produced them:
   `elearn.ucr.edu` survives, `/courses/237131/files/26333889` does not, and a page's path
   says far more about somebody than its title ever did. A `file://` or `chrome://` address
   yields nothing at all, because one is a path on this machine and the other is not a
   site. The address bar is an **input** as well as a display, so without a scheme the bar
   is higher: whitespace, a lone colon, or a last label that is not a plausible TLD all
   mean somebody is typing rather than somewhere they are. Redaction runs *before* the
   sample is constructed, so a private title is never in memory, never flushed, never
   recoverable — and a redacted window is **not asked** what site it is on, because a
   private tab's address is exactly as private as its title. A browser that refuses is
   remembered as refused and never asked again; site labels fall back to titles. Windows
   caches its answer against the **window title**, which changes on navigation — so the
   automation tree is walked once per page rather than once every three seconds.
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
    deletes.** The one exception is a plan finished early: sittings that have not started
    are dropped and the one underway is cut to the moment you said you were done. Those
    are not a record of anything — the time is free now, a block nothing will work on is a
    lie the calendar keeps telling, and a plan you have finished should not still be
    counting down on Today. Everything worked stays inside a window that still covers it,
    the remaining labels are renumbered so four sittings do not read as `(4/6)`, and
    `tidy_finished` runs at startup so plans finished under an older build are brought
    into line too. A done plan keeps its blocks and is still returned by `all_progress`, so
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
    three-day horizon. **The day itself is not a bound either**: `DAY_START_HOUR` is 0 and
    `DAY_END_HOUR` is 24. An 08:00–23:00 window told an early riser a day was full when
    six of its hours had merely been declared not to exist, and `explainNoSlots` could not
    name the real reason because it did not know one. The app has no opinion about the
    hours somebody keeps.
17. **A block says what the time is for; the live flags say whether it is happening.**
    `useCurrentWork` decides membership by the clock alone, so alt-tabbing to Finder
    changes a dot from green to amber and never erases the course label. Verification
    still uses the process match — that is a different question, asked in `plans.rs`.
18. **Calendar events are immovable, whoever added them.** Anything from the iCal feed
    becomes a commitment the planner refuses to schedule over, and an event added by hand
    expands into exactly the same `CalendarEvent` — merged in `get_calendar_events`, so
    nothing downstream can tell them apart or treat them differently. All-day events are
    ignored on purpose: they mark a day rather than occupy it. The feed is re-fetched every
    three minutes, **whenever the window regains focus** — switching back from the browser
    is the moment most likely to follow a change — and on demand from the planner, which
    says when it last actually fetched rather than implying it is current. The request
    carries `Cache-Control: no-cache`, which defeats every cache between here and Google
    but **not Google's own**: its iCal export can serve a stale copy for hours, and nothing
    on this side reaches that. **A repeat is a rule, not
    rows**: a class three times a week for a term is one row expanded per window, so
    moving the time moves every occurrence, and "every Tuesday, forever" is expressible at
    all. Each occurrence keeps the first one's *wall-clock* time, so a nine o'clock class
    is still at nine after the clocks change.
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
21. **The host is fact; the title is a claim — and one list answers both.** Inside a
    browser the rules are run against the **host first**, and a host match beats every
    title rule whatever the priorities say: `elearn.ucr.edu` is Canvas even when the tab is
    named after a PDF, and a video called "canvas painting tutorial" on `youtube.com` is
    not coursework. The same `title_rules` list does both jobs, so a site is written down
    once and cannot disagree with itself — `\bpollev\b` recognises the word in a title and
    the host `pollev.com` alike. Below that, `priority` decides which rule claims a window:
    coursework (200) over media (100), anything hand-written (300) over both, and 250 for
    the handful that must outrank the catch-all `[a-z0-9-]+\.edu`. That last number is not
    cosmetic — rules load `ORDER BY priority DESC, pattern`, so inside one tier the pattern
    *string* breaks the tie, and `[` sorts ahead of every `\b`-anchored pattern. A rule that
    needs to win needs a higher number, not a luckier spelling.
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
24. **Coursework needs no API key, and both sources are read.** Every LMS publishes a per-user iCal feed, and
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
30. **Type sizes are `rem`, never pixels.** Every size in the `@theme` block multiplies
    `--text-scale`, so the text slider moves the words and leaves the layout alone; a
    hardcoded `text-[11px]` would sit still while everything around it grew. A root
    `font-size` would have moved padding and gaps with the type, which is the same as
    zooming. `AppearanceBar` sets this and the other visual settings over the real page,
    and **every dimension in it is in pixels and portalled out of the app** — a control
    written in the unit it changes grows under the cursor as you drag it. Nothing in it
    is conditionally rendered either: the bar is centred with a transform, so anything
    that changes its width moves it sideways mid-drag.
31. **The timer is a view, not a source.** `SessionTimer` derives its phase from a start
    time and a pair of lengths, so it is right whenever you look — including after an hour
    with the app closed, which a counter would have to guess at. It writes nothing: what
    counts as work done stays what the watcher measured, so a countdown running against an
    app you are not using advances nothing. It is **always on Today** and it has **no
    start button**: a block is a focus session, the gap before the next block of the same
    plan is the break that plan asked for, and both are countdowns to a time the schedule
    already decided. `useNextWork` is what finds the second one, and it refuses a gap
    longer than the plan's own break — beyond that the gap is the rest of the day, not a
    break. With nothing scheduled the card says so rather than offering a timer of its
    own, which would be a second opinion about the same hour. Both halves of the cycle
    are shown at once: finding out the break is five minutes rather than fifteen should
    not require arriving at it.
32. **A calendar event keeps its `LOCATION`, and that is all.** The feed's own text is
    parsed and displayed verbatim. Routing between places was built and then removed:
    timing a trip needs a paid service, and `git log` has it if it is ever wanted back.
33. **One Nudgy, and one row per second per app.** A second copy is not a duplicate
    window: both tick, both write a sample for every second they are awake, and the day
    adds up past twenty-four hours while still looking like data.
    `tauri-plugin-single-instance` is registered *first*, before anything opens the
    database, and raises the window that is already tracking. Behind it, a unique index on
    `activity_samples(ts, process_name)` and `INSERT OR IGNORE` make the double count
    unreachable from SQL — a replayed flush after a crash is dropped rather than added,
    and `insert_samples` returns what landed, not what it was handed. Two *different* apps
    may share a timestamp; the same app twice in one second is the bug.
34. **The ring is a shape, and the words are a list.** The breakdown draws no labels on
    the chart: leader lines from six wedges converge on the same few pixels and name
    nothing, and a 1% sliver can never carry a legible one. Every category gets an equal
    row in the legend under the ring — swatch, name, percentage — and the ring is sized
    in pixels from a box the component measures itself with a callback ref. Percentages
    inside a `ResponsiveContainer` made its existence depend on a height resolving
    before first paint, and when it did not the panel drew an empty card rather than a
    small one. The radius has a floor, so there is no state in which the circle is
    absent.

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
35. **The title bar is the top bar, on macOS only.** `titleBarStyle: "Overlay"` lets the
    page run the full height of the window and macOS draws its three buttons *over* the
    top-left of it — over whatever is there, without pushing anything aside. So `TopBar`
    spans the window, `IconRail` hangs below it, and the bar reserves
    `TRAFFIC_LIGHTS_WIDTH` on the left when `IS_MAC`. `data-tauri-drag-region` puts back
    the only thing the native bar did that nothing else does, and it goes on the header
    and the breadcrumb but never on a control — a drag region swallows the click.
    Windows and Linux ignore `titleBarStyle` and keep their own title bar above the page,
    which is why the padding is conditional rather than a constant: there, that corner is
    the app's to use.
36. **A time is typed straight through.** `TimeField` is three segments — hour, minute,
    AM/PM — and the caret moves the moment a segment cannot take another digit: one digit
    is enough for 3, but 1 waits because it might still become 12. `<input type="time">`
    did this on some platforms and waited to be clicked into each segment on others, and
    typing a time is the most common thing the app asks anybody to do. The rules live in
    `lib/clockInput.ts` because "when is this segment finished?" is arithmetic and belongs
    in a test, not in a control. It reports 24-hour `HH:MM` so nothing downstream knows,
    and **"" until all three segments are set** — a half-typed hour that resolved to a real
    time would have the planner acting on 1:00 while somebody was still typing 1:45.
    `DateField` is the same control for a date, and refuses a day its month does not have:
    a `Date` rolls 31 February into March, and a deadline that silently moves a month is
    worse than one that will not be typed. Both settle from a ref rather than from state —
    advancing the caret fires the old segment's `onBlur` in the same turn as the
    `onChange` that filled it, and reading the render before it empties what was typed.
37. **Freshness is `FLUSH_SECONDS`, granularity is `TICK_SECONDS`.** Everything measured —
    plan progress, the day's totals, goal verification — is read back out of
    `activity_samples`, so nothing can be newer than the last flush (5s) and nothing moves
    in steps smaller than a tick (3s). The live session counter is the exception: it is
    derived from the wall clock in `useLiveActivity` and updates every second, because it
    is arithmetic on a start time rather than a measurement. Anything that reads worked
    time listens for `nudgy://flushed` — a poll alone leaves the number a minute behind the
    work it describes. Shortening the flush costs transactions, not rows; shortening the
    tick costs rows, which is why the two are tuned separately.
38. **The window fills the screen, and stops at 1280x800.** No maximum and no locked
    aspect ratio: a cap is what stopped a 27" display reaching its corners, and a fixed
    ratio is what stopped any display reaching them — a screen is 16:10 or 16:9 and the
    layout is not. Both were tried and both failed the same test. What is left is a
    minimum, low enough that a 13" display can be filled and high enough that the rail,
    the two Today panels and the sync column all still have room to be themselves. The
    layout does not rearrange inside that range — no `flex-wrap` on the Today row or in
    the status card, because a card that reflows when the window loses ten pixels makes a
    drag feel like a redesign. Things truncate; they do not move.
39. **The frame stays solid; the content can float.** Panel opacity mixes
    `--color-surface` down by `--panel-opacity` and assigns it on `.panels-see-through`,
    which wraps `main` and the sync column — so every `bg-surface` inside inherits it and
    no component knows the setting exists. The top bar, the icon rail and every dialog sit
    outside that element and stay opaque: a chrome you can see through is a chrome you
    have to find, and a dialog you can read the dashboard through is a dialog you cannot
    read. The mix is a *second* property computed at `:root` rather than a redefinition of
    `--color-surface`, because a custom property that refers to itself is a cycle and
    drops out entirely. The floor is 40%: below that the chart colours stop meaning what
    the legend says they mean.
40. **A picked colour is a theme, not a tint.** One hex derives all twelve tokens with
    `color-mix`, in the proportions Blush already uses — canvas a tenth of the accent over
    white, edge a fifth, ink a third of it over black. Every surface is mixed toward white
    and every ink toward black, which is the whole legibility argument: there is no hue
    that can produce grey text on a grey card. It is stored beside the theme rather than
    inside `THEMES` because it is a modifier — clearing it has to put back whatever the
    preset said — and choosing a preset clears it, since otherwise the preset you just
    picked would have no visible effect. Category colours are still untouched: they live
    in the database and mean something specific.
41. **The session clock re-renders the whole app once a second.** `useLiveActivity` bumps
    a counter every second so the counter counts, and everything `App` renders goes with
    it. Anything expensive to *draw* — the charts especially, which are hundreds of SVG
    elements — is wrapped in `memo`, so it redraws when its data changes rather than when
    the clock does. And `useProgress` keeps **one** module-level copy of the history for
    every caller — `App` holds one for the streaks on Today, the progress page and its
    targets panel mount two more, and all three want the same two months of the same
    table. An instance mounting into a warm cache renders with data on its first pass,
    which is the difference between opening a page and waiting for one.
42. **Coursework you are not doing is set aside, never deleted.** The feed is the source
    and still lists it, so a delete would be undone by the next sync and read as the app
    forgetting. `tasks.dismissed_at` records when you said so; `load_tasks` excludes those
    rows, which is what keeps them out of the planner queue as well as the list — work you
    have declined should not be offered an evening. Coursework is grouped by course code,
    the groups ordered by nearest deadline, because a term's feed is several courses and a
    flat list sorted by date makes you read thirty rows to find today's two.
43. **A habit is declared; a category is measured.** No watcher can tell whether you went
    to the gym, so habits are ticked by hand and live in their own tables — `habits` and
    `habit_days`, keyed `(habit_id, day)` on a local `YYYY-MM-DD` so a tick belongs to the
    day you were in and two clicks cannot make two rows. The streak rules are invariant
    23's, restated in `services/habits.ts` rather than bent out of `streakOf`: **a day the
    habit was not due is skipped**, not missed — that is the whole point of choosing
    weekdays — and **today unticked holds the run without lighting it**. Two things the
    arithmetic must not do: reach back before a habit existed, or let a habit added this
    morning spoil a day that was perfect at the time. **Archiving keeps the history and
    deleting destroys it**, which is why they are separate buttons and only one of them
    asks. Habits live on **Progress**, not Today: the tick is a small act but "am I keeping
    this up" is a progress question, and the grid is the answer — a third chart mode drawing
    every commitment against every day.
44. **A syllabus is read, never trusted.** `syllabus.rs` understands one grammar — a day
    token, a time range, an optional room — and nothing else, because there is still no
    model in Nudgy. It will miss unusual layouts and will happily offer your own office
    hours, and both are survivable for one reason: **it writes nothing**. Every candidate
    is confirmed and then laid down through the existing `create_event`, so imported
    classes are ordinary weekly events and inherit invariant 18 rather than becoming a
    third kind of thing. Days are read **word by word** — `MWF` is a run of day letters and
    `and` is a word that merely starts with one — and `R` is Thursday. A meridiem on one
    half of a range applies to both, so `8–8:50 AM` is fifty minutes. And a scanned PDF is
    reported as having no text rather than as having no classes: one is fixed by pasting,
    the other by checking the format, and saying the wrong one sends people the wrong way.
45. **One list, two sources of truth.** A target and a habit are the same shape — something
    owed most days, a run of days you kept it, a flame that goes out at midnight — so they
    are read as one list of `Commitment`s and drawn in one grid, one strip and one dialog.
    What is *not* merged is the store: merging them would mean writing declared ticks into
    `activity_samples` or invented seconds into `habit_days`, and the rest of the app
    believes both tables. So `commitments.ts` dispatches to `streakOf` and `habitStreak`
    rather than replacing either, and the only place the split stays visible is the one
    place it must be — the kind toggle on the add form, and the fact that a measured chip
    **cannot be ticked**. A commitment you could click your way past would not be measuring
    anything, so clicking one opens it for editing instead.
    A day has **five** states, not the grid's three. `not-due` is a rest day. `unobserved`
    is a day the watcher wrote nothing: it still ends a streak — invariant 23, absence must
    not bank itself — but it is drawn like a rest day, because a fortnight away from the
    machine is not a fortnight of failures. `open` is today, dashed: a day with hours left
    in it has not been missed yet.
    **A ceiling is judged in the past only.** Staying under a limit is never finished before
    midnight, so requiring every ceiling to *pass* would mean a perfect-day flame that is
    never lit while anybody is looking at it. Today lights when every habit is ticked and
    every floor is met; going *over* a ceiling still takes the run away there and then.
