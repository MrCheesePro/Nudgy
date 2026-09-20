import { useCallback, useEffect, useMemo, useState } from "react";

import { AddTaskDialog } from "./components/AddTaskDialog";
import { CanvasSyncSidebar } from "./components/CanvasSyncSidebar";
import { CheckinPrompt } from "./components/CheckinPrompt";
import { GeneratePlanDialog } from "./components/GeneratePlanDialog";
import { LiveStatusHeader } from "./components/LiveStatusHeader";
import { PermissionBanner } from "./components/PermissionBanner";
import {
  PlanAssignmentDialog,
  type Plannable,
} from "./components/PlanAssignmentDialog";
import { RegisterAppPanel } from "./components/RegisterAppPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { TimelinePlanner } from "./components/TimelinePlanner";
import { TopApps } from "./components/TopApps";
import { UsageBreakdown } from "./components/UsageBreakdown";
import { IconRail, type View } from "./components/shell/IconRail";
import { TopBar } from "./components/shell/TopBar";
import { useCalendar } from "./hooks/useCalendar";
import { useCurrentWork } from "./hooks/useCurrentWork";
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
  hasSecret,
  setPaused as setPausedCommand,
} from "./lib/ipc";
import { DAY_END_HOUR, DAY_START_HOUR } from "./lib/time";
import {
  SECRET_CALENDAR_ICS_URL,
  SECRET_CANVAS_TOKEN,
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

export default function App() {
  const { status, sessionSeconds } = useLiveActivity();
  const { breakdown, apps, unmapped, error, refresh } = useUsageStats();
  const { status: permissions, refresh: refreshPermissions } = usePermissions();
  const calendar = useCalendar();
  const tasks = useTasks();
  const schedule = useSchedule(calendar.commitmentsIn);
  const plans = usePlans();
  const currentWork = useCurrentWork(schedule.horizonBlocks, plans.plans, tasks.tasks, status);

  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [paused, setPausedState] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planning, setPlanning] = useState<Plannable | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [canvasLinked, setCanvasLinked] = useState(false);
  const [calendarLinked, setCalendarLinked] = useState(false);

  useEffect(() => {
    getPaused()
      .then(setPausedState)
      .catch(() => undefined);
  }, []);

  // Re-checked when the dialog closes, since that is when credentials may have changed.
  useEffect(() => {
    if (settingsOpen) return;
    hasSecret(SECRET_CANVAS_TOKEN)
      .then(setCanvasLinked)
      .catch(() => undefined);
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

  const needle = query.trim().toLowerCase();
  const filteredTasks = useMemo(
    () =>
      needle
        ? tasks.tasks.filter((task) =>
            `${task.title} ${task.courseCode ?? ""}`.toLowerCase().includes(needle),
          )
        : tasks.tasks,
    [needle, tasks.tasks],
  );
  const filteredApps = useMemo(
    () =>
      needle
        ? apps.filter((app) =>
            `${app.appName} ${app.processName}`.toLowerCase().includes(needle),
          )
        : apps,
    [apps, needle],
  );

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
      const existing = plans.plans.find((entry) => entry.plan.taskId === task.id);
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
      const existing = plans.plans.find((entry) => entry.plan.title === goal.label);
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

  const confirmPlan = useCallback(
    async (input: {
      item: Plannable;
      estimateSeconds: number;
      mode: PlanMode;
      style: PomodoroStyle;
      focusSeconds: number;
      breakSeconds: number;
      blocks: PlacedBlock[];
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
    () => planQueue(schedule.goals, tasks.tasks, plans.plans),
    [schedule.goals, tasks.tasks, plans.plans],
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

  return (
    <div className="flex h-full overflow-hidden">
      <IconRail view={view} onChange={setView} onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          view={view}
          query={query}
          onQuery={setQuery}
          paused={paused}
          onTogglePause={() => void togglePause()}
          alerts={alerts}
          onAlerts={() => setView("overview")}
          onOpenSettings={() => setSettingsOpen(true)}
          trackingLabel={currentWork?.courseCode ?? null}
        />

        <div className="flex min-h-0 flex-1">
          {/* The timeline manages its own scrolling, so the page itself must not add a
              second scrollbar behind it. */}
          <main
            className={`flex min-w-0 flex-1 flex-col gap-5 px-7 py-6 ${
              view === "timeline" ? "overflow-hidden" : "overflow-y-auto"
            }`}
          >
            <PermissionBanner status={permissions} onRefresh={refreshPermissions} />

            {error && (
              <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-sm text-bad">
                {error}
              </p>
            )}

            {view === "overview" && (
              <>
                <LiveStatusHeader
                  status={status}
                  sessionSeconds={sessionSeconds}
                  paused={paused}
                  work={currentWork}
                />
                <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
                  <UsageBreakdown breakdown={breakdown} />
                  <TopApps apps={filteredApps} />
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
                  busy={schedule.busy}
                  note={schedule.note}
                  error={schedule.error}
                  onGenerate={schedule.generate}
                  onAddTask={() => setAddTaskOpen(true)}
                />
              </>
            )}

            {view === "apps" && (
              <>
                <RegisterAppPanel unmapped={unmapped} onRegistered={() => void refresh()} />
                <TopApps apps={filteredApps} />
              </>
            )}

          </main>

          <CanvasSyncSidebar
            tasks={filteredTasks}
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
            onDeletePlan={(id) => void plans.remove(id)}
            onRemoveGoal={(index) => void removeGoal(index)}
          />
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

      <CheckinPrompt checkin={plans.checkin} onAnswer={(response) => void plans.answer(response)} />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
