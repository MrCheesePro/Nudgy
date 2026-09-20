import { Link2, RefreshCw, Trash2 } from "lucide-react";

import { formatDuration } from "../lib/time";
import {
  CATEGORY_COLORS,
  type Category,
  type Goal,
  type LmsTask,
  type PlanProgress,
} from "../lib/types";

interface Props {
  tasks: LmsTask[];
  goals: Goal[];
  plans: PlanProgress[];
  canvasLinked: boolean;
  syncing: boolean;
  lastSync: string | null;
  syncError: string | null;
  onSync: () => void;
  onOpenSettings: () => void;
  onToggleTask: (task: LmsTask) => void;
  onPlanTask: (task: LmsTask) => void;
  onPlanGoal: (goal: Goal) => void;
  onDeletePlan: (id: number) => void;
  onRemoveGoal: (index: number) => void;
}


/**
 * Everything with a deadline or an intention behind it: work synced from Canvas, work
 * already in progress, and goals the user typed themselves. Measured-time panels live on
 * the Overview, so nothing here duplicates them.
 */
export function CanvasSyncSidebar({
  tasks,
  goals,
  plans,
  canvasLinked,
  syncing,
  lastSync,
  syncError,
  onSync,
  onOpenSettings,
  onToggleTask,
  onPlanTask,
  onPlanGoal,
  onDeletePlan,
  onRemoveGoal,
}: Props) {
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

        {plans.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold tracking-wider text-ink-soft uppercase">
              In progress
            </h3>
            <ul className="mt-2 space-y-2">
              {plans.map((entry) => (
                <li key={entry.plan.id} className="group rounded-xl border border-edge p-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                      {entry.plan.title}
                    </span>
                    <button
                      type="button"
                      aria-label="Drop plan"
                      onClick={() => onDeletePlan(entry.plan.id)}
                      className="shrink-0 text-ink-mute opacity-0 transition group-hover:opacity-100 hover:text-bad"
                    >
                      <Trash2 size={12} />
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
              {tasks.map((task) => {
                const planned = plans.some((entry) => entry.plan.taskId === task.id);
                return (
                  <li key={task.id} className="rounded-xl border border-edge bg-surface p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-soft">
                        {task.courseCode ?? "COURSE"}
                      </span>
                      <button
                        type="button"
                        onClick={() => onPlanTask(task)}
                        className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-medium transition ${
                          planned
                            ? "bg-rose text-white"
                            : "bg-surface-sunken text-ink-soft hover:bg-edge"
                        }`}
                      >
                        {planned ? "Planned" : "+ Schedule"}
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => onToggleTask(task)}
                      title="Mark complete"
                      className="mt-2 block w-full truncate text-left text-xs font-semibold text-ink transition hover:text-rose-deep"
                    >
                      {task.title}
                    </button>

                    <div className="mt-0.5 text-[11px] text-ink-mute">
                      {dueLine(task.dueAt)}
                      {estimateFor(plans, task.id)}
                    </div>
                  </li>
                );
              })}
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
                const planned = plans.some((entry) => entry.plan.title === goal.label);
                return (
                  <li
                    key={`${goal.label}-${index}`}
                    className="group rounded-xl border border-edge bg-surface p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase"
                        style={{ background: `${color}22`, color }}
                      >
                        {category}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${goal.label}`}
                        onClick={() => onRemoveGoal(index)}
                        className="ml-auto text-ink-mute opacity-0 transition group-hover:opacity-100 hover:text-bad"
                      >
                        <Trash2 size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onPlanGoal(goal)}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition ${
                          planned
                            ? "bg-rose text-white"
                            : "bg-surface-sunken text-ink-soft hover:bg-edge"
                        }`}
                      >
                        {planned ? "Planned" : "+ Schedule"}
                      </button>
                    </div>

                    <div className="mt-2 truncate text-xs font-semibold text-ink">
                      {goal.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-mute">
                      {goal.targetSeconds > 0
                        ? `${Math.round(goal.targetSeconds / 60)} min est.`
                        : "No estimate yet"}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

    </aside>
  );
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
