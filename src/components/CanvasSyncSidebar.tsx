import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheckBig,
  Link2,
  RefreshCw,
  X,
} from "lucide-react";

import { formatDuration } from "../lib/time";
import {
  CATEGORY_COLORS,
  type Category,
  type Goal,
  type LmsTask,
  type PlanProgress,
} from "../lib/types";

/** What a row is doing right now, in one word. */
type RowState = "Active" | "Inactive" | "Done";

interface CompletedEntry {
  key: string;
  title: string;
  subtitle: string | null;
  finishedAt: number | null;
  /** Ticking a completed assignment puts it back; a finished goal has nothing to undo. */
  onUndo: (() => void) | null;
}

interface Props {
  tasks: LmsTask[];
  completedTasks: LmsTask[];
  goals: Goal[];
  plans: PlanProgress[];
  canvasLinked: boolean;
  syncing: boolean;
  lastSync: string | null;
  syncError: string | null;
  /** Anything finished before this is hidden — cleared, never deleted. */
  clearedAt: number;
  onSync: () => void;
  onOpenSettings: () => void;
  onToggleTask: (task: LmsTask) => void;
  onPlanTask: (task: LmsTask) => void;
  onPlanGoal: (goal: Goal) => void;
  onDeletePlan: (id: number) => void;
  onRemoveGoal: (index: number) => void;
  onClearCompleted: () => void;
}

/**
 * Everything with a deadline or an intention behind it: work synced from Canvas, work
 * already in progress, and goals the user typed themselves. Measured-time panels live on
 * the Overview, so nothing here duplicates them.
 *
 * A row is the schedule button — clicking anywhere on it opens the planner. The two things
 * that must not do that, completing and deleting, are explicit controls that stop the
 * click from reaching the row.
 */
export function CanvasSyncSidebar({
  tasks,
  completedTasks,
  goals,
  plans,
  canvasLinked,
  syncing,
  lastSync,
  syncError,
  clearedAt,
  onSync,
  onOpenSettings,
  onToggleTask,
  onPlanTask,
  onPlanGoal,
  onDeletePlan,
  onRemoveGoal,
  onClearCompleted,
}: Props) {
  const [completedOpen, setCompletedOpen] = useState(false);

  const activePlans = plans.filter((entry) => entry.plan.status === "active");

  // Both sources of "finished", in one list, newest first — so done means one thing.
  const completed: CompletedEntry[] = [
    ...completedTasks.map((task) => ({
      key: `task-${task.id}`,
      title: task.title,
      subtitle: task.courseCode,
      finishedAt: task.completedAt,
      onUndo: () => onToggleTask(task),
    })),
    ...plans
      .filter((entry) => entry.plan.status === "done" && entry.plan.taskId === null)
      .map((entry) => ({
        key: `plan-${entry.plan.id}`,
        title: entry.plan.title,
        subtitle: formatDuration(entry.workedSeconds),
        finishedAt: entry.plan.completedAt,
        onUndo: null,
      })),
  ]
    .filter((entry) => (entry.finishedAt ?? 0) > clearedAt)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));

  return (
    <aside className="flex w-90 shrink-0 flex-col border-l border-edge bg-surface">
      <div className="px-5 pt-5">
        <h2 className="text-sm font-semibold text-ink">Academic &amp; Project Sync</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-3 rounded-xl bg-rose-wash p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-rose-deep">
            <Link2 size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink">
              {canvasLinked ? "Canvas LMS linked" : "Canvas not connected"}
            </div>
            <div className="truncate text-[11px] text-ink-soft">
              {canvasLinked
                ? (lastSync ?? `${tasks.length} assignments tracked`)
                : "Add your Canvas URL and token"}
            </div>
          </div>
          <button
            type="button"
            onClick={canvasLinked ? onSync : onOpenSettings}
            disabled={syncing}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-surface px-2.5 py-1.5 text-[11px] font-medium text-rose-deep transition hover:bg-edge disabled:opacity-50"
          >
            <RefreshCw size={11} className={syncing ? "animate-spin" : undefined} />
            {canvasLinked ? "Sync now" : "Connect"}
          </button>
        </div>

        {syncError && (
          <p className="rounded-lg bg-bad/10 px-3 py-2 text-[11px] text-bad">{syncError}</p>
        )}

        {activePlans.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold tracking-wider text-ink-soft uppercase">
              In progress
            </h3>
            <ul className="mt-2 space-y-2">
              {activePlans.map((entry) => (
                <li key={entry.plan.id} className="rounded-xl border border-edge p-3">
                  <div className="flex items-center gap-2">
                    <StateChip state="Active" />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                      {entry.plan.title}
                    </span>
                    <button
                      type="button"
                      aria-label={`Drop plan for ${entry.plan.title}`}
                      onClick={() => onDeletePlan(entry.plan.id)}
                      className="shrink-0 rounded p-0.5 text-ink-mute transition hover:bg-canvas hover:text-bad"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full bg-rose transition-[width] duration-500"
                      style={{ width: `${Math.min(100, entry.percent)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-mute">
                    <span className="font-mono">
                      {formatDuration(entry.workedSeconds)} /{" "}
                      {formatDuration(entry.plan.estimateSeconds)}
                    </span>
                    <span>
                      {entry.plan.mode === "pomodoro" ? "sessions" : "one sitting"}
                      {entry.plan.checkinCount > 0 && ` · revised ${entry.plan.checkinCount}×`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold tracking-wider text-ink-soft uppercase">
              Canvas coursework
            </h3>
            <span className="text-[11px] text-ink-mute">{tasks.length} upcoming</span>
          </div>

          {tasks.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-mute">
              {canvasLinked
                ? "Nothing due. Sync to refresh."
                : "Connect Canvas to pull your assignments in."}
            </p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {tasks.map((task) => (
                <RowShell
                  key={task.id}
                  label={`Schedule ${task.title}`}
                  onOpen={() => onPlanTask(task)}
                >
                  <div className="flex items-center gap-2">
                    <StateChip state={stateForTask(plans, task)} />
                    <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-soft">
                      {task.courseCode ?? "COURSE"}
                    </span>
                    <span className="ml-auto" />
                  </div>

                  <div className="mt-2 flex items-start gap-2">
                    {/* The row schedules, so completing needs a control of its own —
                        clicking the title used to be the only way, and nothing said so. */}
                    <button
                      type="button"
                      aria-label={`Mark ${task.title} complete`}
                      title="Mark complete"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleTask(task);
                      }}
                      className="mt-0.5 shrink-0 text-ink-mute transition hover:text-ok"
                    >
                      <Circle size={13} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-ink">{task.title}</div>
                      <div className="mt-0.5 text-[11px] text-ink-mute">
                        {dueLine(task.dueAt)}
                        {estimateFor(plans, task.id)}
                      </div>
                    </div>
                  </div>
                </RowShell>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold tracking-wider text-ink-soft uppercase">
              Your goals
            </h3>
            <span className="text-[11px] text-ink-mute">{goals.length}</span>
          </div>

          {goals.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-mute">
              Nothing added yet. Type a goal below — “draw for 30m”, “read chapter 4”.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {goals.map((goal, index) => {
                const category = (goal.category as Category) ?? "Neutral";
                const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Neutral;
                return (
                  <RowShell
                    key={`${goal.label}-${index}`}
                    label={`Schedule ${goal.label}`}
                    onOpen={() => onPlanGoal(goal)}
                  >
                    <div className="flex items-center gap-2">
                      <StateChip state={stateForGoal(plans, goal)} />
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase"
                        style={{ background: `${color}22`, color }}
                      >
                        {category}
                      </span>
                      <RowClose
                        label={`Remove ${goal.label}`}
                        onClick={() => onRemoveGoal(index)}
                      />
                    </div>

                    <div className="mt-2 truncate text-xs font-semibold text-ink">
                      {goal.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-mute">
                      {goal.targetSeconds > 0
                        ? `${Math.round(goal.targetSeconds / 60)} min est.`
                        : "No estimate yet"}
                    </div>
                  </RowShell>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setCompletedOpen((open) => !open)}
              className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-ink-soft uppercase transition hover:text-ink"
            >
              {completedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Completed
              <span className="font-normal normal-case text-ink-mute">({completed.length})</span>
            </button>
            {completedOpen && completed.length > 0 && (
              <button
                type="button"
                onClick={onClearCompleted}
                className="text-[11px] text-ink-mute transition hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>

          {completedOpen &&
            (completed.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-mute">
                Nothing finished yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {completed.map((entry) => (
                  <li
                    key={entry.key}
                    className="flex items-center gap-2 rounded-lg border border-edge bg-canvas px-2.5 py-2"
                  >
                    <button
                      type="button"
                      aria-label={entry.onUndo ? `Reopen ${entry.title}` : entry.title}
                      title={entry.onUndo ? "Put it back" : undefined}
                      onClick={() => entry.onUndo?.()}
                      disabled={entry.onUndo === null}
                      className="shrink-0 text-ok transition hover:text-ink-soft disabled:hover:text-ok"
                    >
                      <CircleCheckBig size={13} />
                    </button>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mute line-through">
                      {entry.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-mute">
                      {entry.subtitle}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      </div>
    </aside>
  );
}

/** A row that is itself the schedule button, keyboard included. */
function RowShell({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer rounded-xl border border-edge bg-surface p-3 transition hover:border-edge-strong hover:bg-canvas"
    >
      {children}
    </li>
  );
}

/** The X on a row. Stops the click, or deleting would also open the planner. */
function RowClose({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="ml-auto shrink-0 rounded p-0.5 text-ink-mute transition hover:bg-surface-sunken hover:text-bad"
    >
      <X size={14} />
    </button>
  );
}

function StateChip({ state }: { state: RowState }) {
  const style =
    state === "Active"
      ? "bg-ok/10 text-ok"
      : state === "Done"
        ? "bg-surface-sunken text-ink-mute"
        : "border border-edge text-ink-mute";

  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${style}`}>
      {state}
    </span>
  );
}

/** One definition of the three states, so assignments and goals cannot drift apart. */
function stateForTask(plans: PlanProgress[], task: LmsTask): RowState {
  if (task.completed) return "Done";
  return stateOf(plans.filter((entry) => entry.plan.taskId === task.id));
}

function stateForGoal(plans: PlanProgress[], goal: Goal): RowState {
  // Goals have no id of their own; the title is the key, as it is everywhere else.
  return stateOf(plans.filter((entry) => entry.plan.title === goal.label));
}

function stateOf(matches: PlanProgress[]): RowState {
  if (matches.some((entry) => entry.plan.status === "active")) return "Active";
  if (matches.length > 0) return "Done";
  return "Inactive";
}

/** " · 3 hrs est." once a plan exists for this assignment. */
function estimateFor(plans: PlanProgress[], taskId: number): string {
  const plan = plans.find((entry) => entry.plan.taskId === taskId);
  if (!plan) return "";
  const hours = plan.plan.estimateSeconds / 3600;
  return hours >= 1
    ? ` · ${Number(hours.toFixed(1))} hrs est.`
    : ` · ${Math.round(plan.plan.estimateSeconds / 60)} min est.`;
}

function dueLine(dueAt: number | null): string {
  if (dueAt === null) return "No due date";
  const delta = dueAt - Math.floor(Date.now() / 1000);
  if (delta < 0) return "Overdue";
  const hours = Math.round(delta / 3600);
  if (hours < 24) return `Due in ${Math.max(1, hours)}h`;
  return `Due ${new Date(dueAt * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })} · ${Math.round(hours / 24)}d`;
}
