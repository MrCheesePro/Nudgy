import { useState } from "react";
import { CalendarDays, CalendarPlus, FileText, RefreshCw, Eye, EyeOff, Plus, SlidersHorizontal } from "lucide-react";

import { PlanTimeline } from "./timeline/PlanTimeline";
import { weekDaysAt, weekStart } from "../hooks/useSchedule";
import { useAssignableCategories } from "../lib/categories";
import type { Category } from "../lib/types";
import type {
  CalendarEvent,
  LiveStatus,
  LmsTask,
  PlanProgress,
  ScheduleBlock,
  VerificationResult,
} from "../lib/types";

interface Props {
  /** Every block in the current week. */
  weekBlocks: ScheduleBlock[];
  weekEvents: CalendarEvent[];
  plans: PlanProgress[];
  /** Only to name the class a block's plan belongs to. */
  tasks: LmsTask[];
  live: LiveStatus | null;
  verifications: Record<number, VerificationResult>;
  weekOffset: number;
  onWeekOffset: (offset: number) => void;
  note: string | null;
  error: string | null;
  onAddTask: () => void;
  /** Opens the event dialog — a commitment the planner will not schedule over. */
  onAddEvent: () => void;
  /** Reads class times out of a syllabus, proposing them for confirmation. */
  onImportSyllabus: () => void;
  /** Fetches the calendar feed again, now. */
  onRefreshCalendar: () => void;
  calendarLoading: boolean;
  /** When the feed was last fetched, in epoch milliseconds. */
  calendarCheckedAt: number | null;
}

export function TimelinePlanner({
  weekBlocks,
  weekEvents,
  plans,
  tasks,
  live,
  verifications,
  weekOffset,
  onWeekOffset,
  note,
  error,
  onAddTask,
  onAddEvent,
  onImportSyllabus,
  onRefreshCalendar,
  calendarLoading,
  calendarCheckedAt,
}: Props) {
  const [filter, setFilter] = useState<Category | "All">("All");
  const categories = useAssignableCategories();
  const [hideCompleted, setHideCompleted] = useState(false);

  // One place decides what the chart draws. Finished plans are shown by default: the day
  // is a record of what happened, not only of what is left.
  const donePlanIds = new Set(
    plans.filter((entry) => entry.plan.status === "done").map((entry) => entry.plan.id),
  );
  const visibleBlocks = weekBlocks.filter((block) => {
    if (filter !== "All" && block.category !== filter) return false;
    if (hideCompleted && block.planId !== null && donePlanIds.has(block.planId)) return false;
    return true;
  });

  // Follows the week being viewed, not today, so stepping into next month says so.
  const monthLabel = weekDaysAt(weekOffset)[3].toLocaleDateString([], { month: "long" });

  /** Jump to whichever week contains the picked date. */
  const jumpToDate = (value: string) => {
    if (!value) return;
    const [year, month, day] = value.split("-").map(Number);
    const target = weekStart(new Date(year, month - 1, day));
    const current = weekStart(new Date());
    const weeks = Math.round(
      (target.getTime() - current.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    onWeekOffset(weeks);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-edge bg-surface p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold text-ink">Planner</h2>
        <button
          type="button"
          onClick={onAddTask}
          className="flex items-center gap-1.5 rounded-full bg-rose-wash px-3.5 py-1.5 text-sm font-medium text-rose-deep transition hover:bg-edge-strong"
        >
          <Plus size={14} />
          Add task
        </button>
        {/* Beside Add task, because they are the two halves of the same question: what
            you have to do, and what you have already promised. */}
        <button
          type="button"
          onClick={onAddEvent}
          className="flex items-center gap-1.5 rounded-full border border-edge px-3.5 py-1.5 text-sm font-medium text-ink-soft transition hover:border-edge-strong hover:text-ink"
        >
          <CalendarPlus size={14} />
          Add event
        </button>
        {/* A term's worth of the same thing, read out of the document you were handed. */}
        <button
          type="button"
          onClick={onImportSyllabus}
          className="flex items-center gap-1.5 rounded-full border border-edge px-3.5 py-1.5 text-sm font-medium text-ink-soft transition hover:border-edge-strong hover:text-ink"
        >
          <FileText size={14} />
          Read a syllabus
        </button>

        {/* Because a calendar you cannot make look again is one you stop trusting. The
            label says when it last actually fetched, not when the page rendered. */}
        <button
          type="button"
          onClick={onRefreshCalendar}
          disabled={calendarLoading}
          title="Check the calendar feed now"
          className="flex items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 text-mini text-ink-mute transition hover:border-edge-strong hover:text-ink-soft disabled:opacity-50"
        >
          <RefreshCw size={12} className={calendarLoading ? "animate-spin" : undefined} />
          {checkedLabel(calendarCheckedAt)}
        </button>
      </div>

      {/* Filter chips, in the spirit of the reference layout but wired to real state. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="relative flex cursor-pointer items-center gap-2 rounded-full bg-rose-wash px-4 py-2 text-xs font-semibold text-rose-deep transition hover:bg-edge-strong">
          <CalendarDays size={13} />
          {monthLabel}
          {/* The native picker sits invisibly on top, so the pill itself opens it. */}
          <input
            type="date"
            aria-label="Jump to date"
            onChange={(event) => jumpToDate(event.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>

        <label className="flex items-center gap-2 rounded-full bg-rose-wash px-4 py-2 text-xs font-semibold text-rose-deep">
          <SlidersHorizontal size={13} />
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Category | "All")}
            className="cursor-pointer appearance-none bg-transparent pr-0 text-xs font-semibold text-rose-deep outline-none"
          >
            <option value="All">Filter</option>
            {categories.map((entry) => (
              <option key={entry.id} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => setHideCompleted((hidden) => !hidden)}
          aria-pressed={hideCompleted}
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
            hideCompleted
              ? "bg-rose text-white hover:bg-rose-deep"
              : "bg-rose-wash text-rose-deep hover:bg-edge-strong"
          }`}
        >
          {hideCompleted ? <EyeOff size={13} /> : <Eye size={13} />}
          {hideCompleted ? "Completed hidden" : "Hide completed"}
        </button>


      </div>

      {error && <p className="mt-3 text-xs text-bad">{error}</p>}
      {!error && note && <p className="mt-3 text-xs text-ink-mute">{note}</p>}

      <PlanTimeline
        blocks={visibleBlocks}
        events={weekEvents}
        plans={plans}
        tasks={tasks}
        live={live}
        verifications={verifications}
        weekOffset={weekOffset}
        onWeekOffset={onWeekOffset}
      />
    </section>
  );
}

/** "Checked just now" / "Checked 4m ago" — a fetch, not a render. */
function checkedLabel(at: number | null): string {
  if (at === null) return "Check now";
  const seconds = Math.floor((Date.now() - at) / 1000);
  if (seconds < 60) return "Checked just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Checked ${minutes}m ago`;
  return `Checked ${Math.floor(minutes / 60)}h ago`;
}
