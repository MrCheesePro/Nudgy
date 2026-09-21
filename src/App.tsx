import { useCallback, useEffect, useMemo, useState } from "react";

import { AddTaskDialog } from "./components/AddTaskDialog";
import { CanvasSyncSidebar } from "./components/CanvasSyncSidebar";
import { CheckinPrompt } from "./components/CheckinPrompt";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { GeneratePlanDialog } from "./components/GeneratePlanDialog";
import { LiveStatusHeader } from "./components/LiveStatusHeader";
import { PermissionBanner } from "./components/PermissionBanner";
import {
  PlanAssignmentDialog,
  type Plannable,
} from "./components/PlanAssignmentDialog";
import { AppRegistry } from "./components/AppRegistry";
import { ProgressPage } from "./components/ProgressPage";
import { SessionTimer } from "./components/SessionTimer";
import { TextScalePreview } from "./components/TextScalePreview";
import { SettingsDialog } from "./components/SettingsDialog";
import { TimelinePlanner } from "./components/TimelinePlanner";
import { TopApps } from "./components/TopApps";
import { UsageBreakdown } from "./components/UsageBreakdown";
import { IconRail, type View } from "./components/shell/IconRail";
import { TopBar } from "./components/shell/TopBar";
import { useCalendar } from "./hooks/useCalendar";
import { useCurrentWork, useNextWork } from "./hooks/useCurrentWork";
import { useLiveActivity } from "./hooks/useLiveActivity";
import { usePermissions } from "./hooks/usePermissions";
import { usePlans } from "./hooks/usePlans";
import { useSchedule } from "./hooks/useSchedule";
import { useTasks } from "./hooks/useTasks";
import { useUsageStats } from "./hooks/useUsageStats";
import {
  createPlan,
  deletePlan,
  getPaused,
  getSettings,
  hasSecret,
  setPaused as setPausedCommand,
  setSetting,
} from "./lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { refreshCategories } from "./lib/categories";
import { hydrateAppearance } from "./lib/appearance";
import { playChime, type ChimeId } from "./lib/chime";
import { PanelRightOpen } from "lucide-react";

import { readPref, usePref } from "./lib/prefs";
import { applyTheme, DEFAULT_THEME, SETTING_THEME } from "./lib/theme";
import {
  enable as enableAutostart,
  isEnabled as autostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { useProgress } from "./hooks/useProgress";
import { behindCategories, streakOf } from "./services/progress";
import { DAY_END_HOUR, DAY_START_HOUR } from "./lib/time";
import {
  SECRET_CALENDAR_ICS_URL,
  SECRET_CANVAS_TOKEN,
  SECRET_LMS_FEED_URL,
  SETTING_AUTOSTART_ASKED,
  SETTING_COMPLETED_CLEARED_AT,
  SETTING_NOTIFICATIONS,
  type Category,
  type Goal,
  type LmsTask,
} from "./lib/types";
import { planQueue, type QueueItem } from "./services/dayPlanner";
import type {
  PlacedBlock,
  PlanMode,
  PomodoroStyle,
} from "./services/workPlanner";

/** A destructive action waiting for a yes, and what to run if it gets one. */
interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => void;
  /** The gentler of two outcomes, when the question is a choice rather than a warning. */
  secondaryLabel?: string;
  onSecondary?: () => void;
}

export default function App() {
  const { status, sessionSeconds } = useLiveActivity();
  const { breakdown, apps, error } = useUsageStats();
  const { status: permissions, refresh: refreshPermissions } = usePermissions();
  const calendar = useCalendar();
  const tasks = useTasks();
  const schedule = useSchedule(calendar.commitmentsIn);
  const plans = usePlans();
  const currentWork = useCurrentWork(schedule.horizonBlocks, plans.plans, tasks.tasks, status);
  /** The block after this one, when the gap before it is the break the plan asked for. */
  const nextWork = useNextWork(schedule.horizonBlocks, plans.plans, tasks.tasks);
  // Targets steer which goal gets offered first when planning. The Progress page owns
  // this data; the planner only reads which floors are short today.
  const progress = useProgress(7);
  /** Streak state by category, so Today can show one beside each share without its own
   *  fetch. `lit` is what makes an unmet day look different from a broken run. */
  const streaks = useMemo(
    () =>
      Object.fromEntries(
        // `full`, not `series`: the chart shows a week, but a streak is however long it
        // is, and counting it over seven days would silently cap it at seven.
        progress.targets.map((target) => [target.category, streakOf(progress.full, target)]),
      ),
    [progress.targets, progress.full],
  );

  const [view, setView] = useState<View>("overview");
  const [paused, setPausedState] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planning, setPlanning] = useState<Plannable | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [canvasLinked, setCanvasLinked] = useState(false);
  const [calendarLinked, setCalendarLinked] = useState(false);
  /** Set by "Clear": everything finished before it stops showing, nothing is deleted. */
  const [clearedAt, setClearedAt] = useState(0);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /** Absent in settings means on — a missing row must not silence the app. */
  const [notifications, setNotifications] = useState(true);
  /** Settings steps aside so text size can be judged against the real page. */
  const [scalingText, setScalingText] = useState(false);
  // Remembered, because a column you fold away should stay folded away.
  const [sidebarHidden, setSidebarHidden] = usePref("sidebar.hidden", false);

  useEffect(() => {
    // The OS notification carries the words; this carries the sound, because the app
    // knows which chime was chosen and the notification plugin does not.
    const unlisten = Promise.all(
      ["nudgy://reminder", "nudgy://target-passed"].map((name) =>
        listen(name, () => {
          if (!notifications) return;
          playChime(readPref<ChimeId>("chime", "soft"));
        }),
      ),
    );
    return () => {
      unlisten.then((disposers) => disposers.forEach((dispose) => dispose())).catch(
        () => undefined,
      );
    };
  }, [notifications]);

  useEffect(() => {
    // The category vocabulary is a table now, and half the app asks it for a colour while
    // rendering. Load it once, up front, so nothing draws against an empty map.
    void refreshCategories().catch(() => undefined);

    getPaused()
      .then(setPausedState)
      .catch(() => undefined);

    getSettings()
      .then((entries) => {
        const settings = new Map(entries);
        applyTheme(settings.get(SETTING_THEME) ?? DEFAULT_THEME);
        hydrateAppearance(settings);

        // Launch at login is on unless the user turns it off. A streak that dies because
        // the laptop rebooted and nobody reopened the app is a streak the app lost, not
        // one you did — and a tracker that only runs when remembered measures memory.
        // Done exactly once, so an explicit "off" is never quietly undone.
        if (settings.get(SETTING_AUTOSTART_ASKED) !== "1") {
          void (async () => {
            try {
              if (!(await autostartEnabled())) await enableAutostart();
            } catch {
              // Sandboxed or refused by the OS: the checkbox still works by hand.
            }
            await setSetting(SETTING_AUTOSTART_ASKED, "1").catch(() => undefined);
          })();
        }
        setNotifications(settings.get(SETTING_NOTIFICATIONS) !== "0");
        const raw = settings.get(SETTING_COMPLETED_CLEARED_AT);
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) setClearedAt(value);
      })
      .catch(() => undefined);
  }, []);

  // Re-checked when the dialog closes, since that is when credentials may have changed.
  useEffect(() => {
    if (settingsOpen) return;
    // Linked means "there is a coursework source", which is now either a token or a
    // feed — a feed-only user is fully set up and must not be told to connect.
    void Promise.all([
      hasSecret(SECRET_CANVAS_TOKEN).catch(() => false),
      hasSecret(SECRET_LMS_FEED_URL).catch(() => false),
    ]).then(([token, feed]) => setCanvasLinked(token || feed));
    hasSecret(SECRET_CALENDAR_ICS_URL)
      .then((linked) => {
        setCalendarLinked(linked);
        if (linked) void calendar.refresh();
      })
      .catch(() => undefined);
    // `calendar.refresh` is stable; re-running on it would refetch the feed constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  // The tray can pause tracking too, so the tick payload is the source of truth rather
  // than local button state.
  useEffect(() => {
    if (status) setPausedState(status.paused);
  }, [status]);

  const togglePause = useCallback(async () => {
    const next = !paused;
    setPausedState(next);
    try {
      await setPausedCommand(next);
    } catch {
      setPausedState(!next);
    }
  }, [paused]);

  /**
   * Blocks already on the timeline count as busy, alongside the calendar — on every day
   * in the horizon, not just today. Filtering today's blocks made every other day look
   * empty, which is how tomorrow got double-booked.
   */
  const commitmentsForDay = useCallback(
    (dayKey: string, startTs: number, endTs: number) => [
      ...calendar.commitmentsIn(startTs, endTs),
      ...schedule.horizonBlocks
        .filter((block) => block.day === dayKey)
        .map((block) => ({
          startTs: block.startTs,
          endTs: block.endTs,
          label: block.label,
        })),
    ],
    [calendar, schedule.horizonBlocks],
  );

  const planTask = useCallback(
    (task: LmsTask) => {
      // Re-planning something already planned edits it; it must not stack a second plan.
      // Only an active plan counts — a finished one is history, and editing it would
      // delete the blocks that record work already done.
      const existing = plans.plans.find(
        (entry) => entry.plan.taskId === task.id && entry.plan.status === "active",
      );
      setPlanning({
        taskId: task.id,
        title: task.courseCode ? `${task.courseCode}: ${task.title}` : task.title,
        subtitle: task.courseCode,
        dueAt: task.dueAt,
        category: "Productivity",
        targetProcess: null,
        targetAppName: null,
        defaultMinutes: existing
          ? Math.round(existing.plan.estimateSeconds / 60)
          : 60,
        planId: existing?.plan.id ?? null,
        defaultMode: existing?.plan.mode ?? "pomodoro",
        defaultStyle: existing?.plan.pomodoroStyle ?? "classic",
        defaultFocusMinutes: existing
          ? Math.round(existing.plan.focusSeconds / 60)
          : 45,
        defaultBreakMinutes: existing
          ? Math.round(existing.plan.breakSeconds / 60)
          : 5,
      });
    },
    [plans.plans],
  );

  /** A typed goal is planned exactly like an assignment — same estimate, same modes,
   *  same check-in loop. The only difference is where the title came from. */
  const planGoal = useCallback(
    (goal: Goal) => {
      const existing = plans.plans.find(
        (entry) => entry.plan.title === goal.label && entry.plan.status === "active",
      );
      setPlanning({
        taskId: null,
        title: goal.label,
        subtitle: goal.category ?? null,
        dueAt: null,
        category: (goal.category as Category) ?? "Productivity",
        targetProcess: goal.targetProcess ?? null,
        targetAppName: goal.targetProcess ?? null,
        defaultMinutes: existing
          ? Math.round(existing.plan.estimateSeconds / 60)
          : goal.targetSeconds > 0
            ? Math.round(goal.targetSeconds / 60)
            : 60,
        planId: existing?.plan.id ?? null,
        defaultMode: existing?.plan.mode ?? "pomodoro",
        defaultStyle: existing?.plan.pomodoroStyle ?? "classic",
        defaultFocusMinutes: existing
          ? Math.round(existing.plan.focusSeconds / 60)
          : 45,
        defaultBreakMinutes: existing
          ? Math.round(existing.plan.breakSeconds / 60)
          : 5,
      });
    },
    [plans.plans],
  );

  /** Removing a goal takes its plan and its blocks off the timeline with it. */
  /**
   * Drops a plan and everything it owns, then reloads the timeline.
   *
   * The reload is the point. Rust deletes the plan's blocks in the same statement, but
   * `usePlans.remove` only refreshes the plans list — so the timeline kept drawing bars
   * for blocks that no longer existed until something else happened to reload it.
   */
  const dropPlan = useCallback(
    async (id: number) => {
      await plans.remove(id);
      await schedule.refresh();
    },
    [plans, schedule],
  );

  const removeGoal = useCallback(
    async (index: number) => {
      const goal = schedule.goals[index];
      const existing = plans.plans.find((entry) => entry.plan.title === goal?.label);
      if (existing) await plans.remove(existing.plan.id);
      await schedule.saveGoals(schedule.goals.filter((_, at) => at !== index));
      await schedule.refresh();
    },
    [plans, schedule],
  );

  /**
   * Destructive actions state what they will take with them before they take it. Deleting
   * a goal silently dropped its plan and every block on the timeline that plan owned,
   * which is not something to learn about afterwards.
   */
  const askRemoveGoal = useCallback(
    (index: number) => {
      const goal = schedule.goals[index];
      if (!goal) return;
      const plan = plans.plans.find((entry) => entry.plan.title === goal.label);
      const blocks = plan
        ? schedule.horizonBlocks.filter((block) => block.planId === plan.plan.id).length
        : 0;

      setConfirm({
        title: `Remove “${goal.label}”?`,
        body: blocks > 0
          ? `This also deletes its plan and ${blocks} scheduled ${
              blocks === 1 ? "block" : "blocks"
            } from the timeline. The time already tracked stays in your history, but nothing will explain it.`
          : "This removes the goal. Nothing is scheduled for it yet, so nothing else changes.",
        confirmLabel: "Remove goal",
        run: () => void removeGoal(index),
      });
    },
    [plans.plans, removeGoal, schedule.goals, schedule.horizonBlocks],
  );

  const askDropPlan = useCallback(
    (id: number) => {
      const plan = plans.plans.find((entry) => entry.plan.id === id);
      if (!plan) return;
      const blocks = schedule.horizonBlocks.filter((block) => block.planId === id).length;
      const goalIndex = schedule.goals.findIndex(
        (goal) => goal.label === plan.plan.title,
      );
      const scheduled = `${blocks} scheduled ${blocks === 1 ? "block" : "blocks"}`;

      setConfirm({
        title: `“${plan.plan.title}”`,
        body:
          goalIndex >= 0
            ? `Make it inactive to clear ${scheduled} from the timeline and keep the goal for another day. Removing it deletes the goal as well. Either way, time already tracked stays in your history.`
            : `This clears ${scheduled} from the timeline. The assignment itself stays, and you can schedule it again.`,
        // Only a goal can be removed outright; an assignment belongs to Canvas.
        confirmLabel: goalIndex >= 0 ? "Remove it entirely" : "Clear the schedule",
        run:
          goalIndex >= 0
            ? () => void removeGoal(goalIndex)
            : () => void dropPlan(id),
        secondaryLabel: goalIndex >= 0 ? "Make inactive" : undefined,
        onSecondary: goalIndex >= 0 ? () => void dropPlan(id) : undefined,
      });
    },
    [plans, schedule.horizonBlocks, schedule.goals, removeGoal, dropPlan],
  );

  /** Clearing empties the list. It deletes nothing — the rows stay, they just stop showing. */
  const askClearCompleted = useCallback(() => {
    setConfirm({
      title: "Clear completed?",
      body: "Everything finished so far stops showing in this list. Nothing is deleted — the assignments, the plans and every minute tracked against them stay exactly as they are.",
      confirmLabel: "Clear the list",
      run: () => {
        const now = Math.floor(Date.now() / 1000);
        setClearedAt(now);
        void setSetting(SETTING_COMPLETED_CLEARED_AT, String(now)).catch(() => undefined);
      },
    });
  }, []);

  const confirmPlan = useCallback(
    async (input: {
      item: Plannable;
      estimateSeconds: number;
      mode: PlanMode;
      style: PomodoroStyle;
      focusSeconds: number;
      breakSeconds: number;
      blocks: PlacedBlock[];
      reminderLeadSeconds: number | null;
    }) => {
      const label = input.item.title;

      try {
        // Editing replaces: drop the old plan and its blocks, then lay down the new ones.
        if (input.item.planId !== null) await deletePlan(input.item.planId);

        await createPlan(
          {
            taskId: input.item.taskId,
            title: label,
            estimateSeconds: input.estimateSeconds,
            mode: input.mode,
            pomodoroStyle: input.style,
            focusSeconds: input.focusSeconds,
            breakSeconds: input.breakSeconds,
            dueAt: input.item.dueAt,
          },
          schedule.day,
          input.blocks.map((block, index) => ({
            day: block.day,
            startTs: block.startTs,
            endTs: block.endTs,
            label:
              input.blocks.length > 1
                ? `${label} (${index + 1}/${input.blocks.length})`
                : label,
            // The activity type colours the bar on the timeline.
            category: input.item.category,
            targetProcess: input.item.targetProcess,
            targetSeconds: block.endTs - block.startTs,
            verifiedState: "pending" as const,
            source: "manual" as const,
            reminderLeadSeconds: input.reminderLeadSeconds,
          })),
        );
        setPlanning(null);
        await Promise.all([schedule.refresh(), plans.refresh()]);
        setView("timeline");
      } catch (cause) {
        console.error(cause);
      }
    },
    [plans, schedule],
  );

  /** What the planner has left to ask about: anything real with no plan behind it yet. */
  const queue = useMemo(
    () =>
      planQueue(
        schedule.goals,
        tasks.tasks,
        plans.plans,
        behindCategories(progress.series, progress.targets),
      ),
    [
      schedule.goals,
      tasks.tasks,
      plans.plans,
      progress.series,
      progress.targets,
    ],
  );

  /**
   * One accepted proposal becomes one plan, through the same path as the sidebar's
   * Schedule button — so the check-in loop and the verifier treat both the same.
   */
  const acceptProposal = useCallback(
    async (item: QueueItem, blocks: PlacedBlock[]) => {
      await createPlan(
        {
          taskId: item.taskId,
          title: item.title,
          estimateSeconds: item.estimateSeconds,
          mode: "pomodoro",
          pomodoroStyle: "custom",
          focusSeconds: 45 * 60,
          breakSeconds: 5 * 60,
          dueAt: item.dueAt,
        },
        schedule.day,
        blocks.map((block, index) => ({
          day: block.day,
          startTs: block.startTs,
          endTs: block.endTs,
          label:
            blocks.length > 1 ? `${item.title} (${index + 1}/${blocks.length})` : item.title,
          category: item.category as Category,
          targetProcess: item.targetProcess,
          targetSeconds: block.endTs - block.startTs,
          verifiedState: "pending" as const,
          source: "manual" as const,
        })),
      );
      await Promise.all([schedule.refresh(), plans.refresh()]);
    },
    [plans, schedule],
  );

  const alerts = permissions?.applicable && !permissions.screenRecording ? 1 : 0;

  /** Flipped optimistically so the bell responds at once; reverted if the write fails. */
  const toggleNotifications = useCallback(async () => {
    const next = !notifications;
    setNotifications(next);
    try {
      await setSetting(SETTING_NOTIFICATIONS, next ? "1" : "0");
    } catch {
      setNotifications(!next);
    }
  }, [notifications]);

  return (
    /* The bar runs the full width of the window and the rail hangs below it, so the
       breadcrumb sits beside the window buttons rather than under them. */
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar
        view={view}
        paused={paused}
        onTogglePause={() => void togglePause()}
        alerts={alerts}
        notifications={notifications}
        onToggleNotifications={() => void toggleNotifications()}
        onOpenSettings={() => setSettingsOpen(true)}
        trackingLabel={currentWork?.courseCode ?? null}
      />

      <div className="flex min-h-0 flex-1">
        <IconRail view={view} onChange={setView} onOpenSettings={() => setSettingsOpen(true)} />

        {/* Everything from here in is content, and can be made translucent. The top bar
            above and the rail beside it are the app's frame and stay solid — a chrome you
            can see through is a chrome you have to find. */}
        <div className="panels-see-through flex min-w-0 flex-1">
          {/* The timeline manages its own scrolling, so the page itself must not add a
              second scrollbar behind it. */}
          <main
            className={`relative flex min-w-0 flex-1 flex-col gap-5 px-7 py-6 ${
              // Today is a dashboard you read at a glance, so it fits the viewport and
              // does not scroll — the breakdown gives up its labels as it shrinks rather
              // than pushing the page past the bottom of the window. The timeline manages
              // its own scrolling and must not get a second scrollbar behind it.
              view === "timeline" || view === "overview" ? "overflow-hidden" : "scroll-area"
            }`}
          >
            {/* The flash. Keyed like the page itself, so it is a fresh element on every
                switch and the animation runs again; `pointer-events-none` because it is
                lying over the thing you just clicked towards. */}
            <div
              key={`flash-${view}`}
              aria-hidden
              className="page-flash pointer-events-none absolute inset-0 z-10"
            />

            <PermissionBanner status={permissions} onRefresh={refreshPermissions} />

            {error && (
              <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-sm text-bad">
                {error}
              </p>
            )}

            {/* `key={view}` is what makes this an animation rather than a class that
                only ever runs once: React tears the old view down and mounts the new
                one, so the keyframe starts again on every switch. The banner and the
                error stay outside — they are about the app, not about the page, and
                should not flicker when you move between views. */}
            <div
              key={view}
              // `min-h-0 flex-1` for every view, because this stands where the views
              // used to sit as direct children of `main`. A view whose panels claim the
              // viewport with `flex-1` — the progress graph does — collapses to its
              // minimum height if anything between it and `main` is content-sized.
              className="page-enter flex min-h-0 flex-1 flex-col gap-5"
            >
            {view === "overview" && (
              <>
                {/* The timer is always here. Driven by the block when one is running,
                    and a plain pomodoro you start by hand when none is — wanting to work
                    in twenty-five minute stretches does not depend on having planned. */}
                <div className="flex shrink-0 items-stretch gap-5">
                  <div className="min-w-0 flex-1">
                    <LiveStatusHeader
                      status={status}
                      sessionSeconds={sessionSeconds}
                      paused={paused}
                      work={currentWork}
                    />
                  </div>
                  <SessionTimer
                    work={currentWork}
                    next={nextWork}
                    category={status?.category ?? "Neutral"}
                  />
                </div>
                {/* Fills what is left of the viewport rather than growing past it, so
                    Today is a dashboard you read at a glance instead of a page you
                    scroll. `min-h-0` is what lets the children shrink inside it. */}
                {/* The grid takes whatever the header and the targets leave, and
                    "Where the time went" is the only thing inside it allowed to scroll —
                    it is the one panel whose length depends on how many apps you used. */}
                <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[1.25fr_1fr]">
                  <UsageBreakdown breakdown={breakdown} />
                  <TopApps apps={apps} streaks={streaks} />
                </div>
              </>
            )}

            {view === "timeline" && (
              <>
                {!calendarLinked && (
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    className="w-full rounded-xl border border-edge bg-surface px-4 py-3 text-left text-xs text-ink-soft transition hover:border-edge-strong"
                  >
                    No calendar connected — Nudgy is planning around an empty day. Add your
                    Google Calendar iCal URL in Settings so classes and meetings block time.
                  </button>
                )}
                <TimelinePlanner
                  weekBlocks={schedule.weekBlocks}
                  weekEvents={calendar.events}
                  plans={plans.plans}
                  tasks={tasks.tasks}
                  live={status}
                  verifications={schedule.verifications}
                  weekOffset={schedule.weekOffset}
                  onWeekOffset={schedule.setWeekOffset}
                  note={schedule.note}
                  error={schedule.error}
                  onAddTask={() => setAddTaskOpen(true)}
                />
              </>
            )}

            {view === "progress" && <ProgressPage />}

            {view === "apps" && <AppRegistry />}
            </div>
          </main>

          {/* Folded away, it leaves a tab against the right edge. A collapse with no
              visible way back is a feature people press once and then look for a
              setting. */}
          {(view === "overview" || view === "timeline") && sidebarHidden && (
            <button
              type="button"
              onClick={() => setSidebarHidden(false)}
              title="Show Academic & Project Sync"
              className="fade-in flex shrink-0 items-center border-l border-edge bg-surface px-1.5 text-ink-mute transition hover:bg-surface-sunken hover:text-ink"
            >
              <PanelRightOpen size={15} />
            </button>
          )}

          {/* The column stays mounted and the width is what moves, so the panel slides
              out of view instead of blinking out of existence. `overflow-hidden` on the
              track with a fixed-width child is what keeps the contents from reflowing on
              the way: they keep their real width and are clipped, rather than being
              squeezed through every intermediate size at 60fps. */}
          {(view === "overview" || view === "timeline") && (
            <div
              // Still in the tree while folded, so `inert` is what stops the keyboard
              // tabbing into a column nobody can see.
              inert={sidebarHidden}
              className={`flex shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
                sidebarHidden ? "w-0" : "w-90"
              }`}
            >
            <CanvasSyncSidebar
              onCollapse={() => setSidebarHidden(true)}
              tasks={tasks.tasks}
              completedTasks={tasks.completedTasks}
              clearedAt={clearedAt}
              canvasLinked={canvasLinked}
              syncing={tasks.syncing}
              lastSync={tasks.lastSync}
              syncError={tasks.error}
              goals={schedule.goals}
              plans={plans.plans}
              onSync={() => void tasks.sync()}
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleTask={(task) => void tasks.toggle(task)}
              onPlanTask={planTask}
              onPlanGoal={planGoal}
              onDeletePlan={askDropPlan}
              onRemoveGoal={askRemoveGoal}
              onClearCompleted={askClearCompleted}
            />
            </div>
          )}
        </div>
      </div>

      <AddTaskDialog
        open={addTaskOpen}
        onClose={() => setAddTaskOpen(false)}
        onAdd={(task) =>
          void schedule.saveGoals([
            ...schedule.goals,
            {
              label: task.title,
              // No estimate yet — how long it takes is decided when it is scheduled.
              targetSeconds: 0,
              targetProcess: task.targetProcess,
              category: task.category,
              dueAt: task.dueAt,
            },
          ])
        }
      />

      <GeneratePlanDialog
        open={schedule.planning}
        queue={queue}
        daysFor={schedule.plannerDays}
        onClose={schedule.closePlanner}
        onAccept={acceptProposal}
      />

      <PlanAssignmentDialog
        item={planning}
        dayStartHour={DAY_START_HOUR}
        dayEndHour={DAY_END_HOUR}
        commitmentsFor={commitmentsForDay}
        onClose={() => setPlanning(null)}
        onConfirm={(input) => void confirmPlan(input)}
      />

      {/* Answering changes what the timeline should draw, so both have to reload — the
          blocks would otherwise keep their old look for up to a minute. */}
      <CheckinPrompt
        checkin={plans.checkin}
        onAnswer={(response) => {
          void plans.answer(response).then(() => schedule.refresh());
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "Delete"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
        secondaryLabel={confirm?.secondaryLabel}
        onSecondary={
          confirm?.onSecondary
            ? () => {
                confirm.onSecondary?.();
                setConfirm(null);
              }
            : undefined
        }
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onPreviewTextSize={() => {
          setSettingsOpen(false);
          setScalingText(true);
        }}
      />

      <TextScalePreview open={scalingText} onClose={() => setScalingText(false)} />
    </div>
  );
}
