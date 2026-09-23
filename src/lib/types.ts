/** Mirrors the serde structs in `src-tauri/src/models.rs`. Keep the two in step. */

/**
 * A category name. Open, not a union: the vocabulary lives in the `categories` table so
 * someone can add one without a rebuild. Read the live list with `useCategories()` and a
 * colour with `categoryColor()`, both from `lib/categories`.
 */
export type Category = string;

export const CATEGORY_NEUTRAL = "Neutral";
export const CATEGORY_IDLE = "Idle";

/** One row of the vocabulary, as `get_categories` returns it. */
export interface CategoryDef {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  /** Built-ins cannot be deleted — Neutral catches everything unmatched, Idle is absence. */
  isBuiltin: boolean;
}

/**
 * Only used before the table has loaded, and for a name the table no longer has. Tuned
 * for the blush light theme: saturated enough to separate, warm enough to belong.
 */
export const FALLBACK_COLORS: Record<string, string> = {
  Development: "#8b7bd8",
  Productivity: "#4fa88c",
  Creative: "#e0a05e",
  Social: "#e0818f",
  Gaming: "#b07bd4",
  "Free Time": "#7fb2e5",
  Neutral: "#bda3a7",
  Idle: "#e7d2d5",
};

export interface LiveStatus {
  processName: string;
  appName: string;
  windowTitle: string | null;
  category: Category;
  source: "passive" | "rpc";
  isIdle: boolean;
  idleSeconds: number;
  sessionStartedAt: number;
  sessionSeconds: number;
  paused: boolean;
}

export interface CategoryTotal {
  category: Category;
  seconds: number;
}

export interface UsageBreakdown {
  categories: CategoryTotal[];
  totalSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
}

export interface AppTotal {
  processName: string;
  appName: string;
  /** Short site label inside the app — "YouTube" under Google Chrome. */
  context: string | null;
  category: Category;
  seconds: number;
}

/** One category's total on one local day, as `get_daily_totals` returns it. */
export interface DailyTotal {
  day: string;
  category: Category;
  seconds: number;
}

/** What a good day looks like for one category. */
export interface CategoryTarget {
  category: Category;
  /** `at_least` is a floor to reach, `at_most` a ceiling not to pass. */
  direction: "at_least" | "at_most";
  secondsPerDay: number;
  createdAt: number;
}

export interface UnmappedProcess {
  processName: string;
  appName: string;
  seconds: number;
  lastSeen: number;
}

export interface AppRule {
  id: number;
  matchType: "exe" | "title_regex";
  pattern: string;
  displayName: string;
  category: Category;
  isUserDefined: boolean;
  /** Higher wins when two title rules match one window. School 200, media 100, yours 300. */
  priority: number;
}

/** What `suggest_category` came back with. `category` is null when nothing could tell. */
export interface CategorySuggestion {
  category: Category | null;
  source: "heuristic" | "llm" | "none";
}

export interface RedactionRule {
  id: number;
  matchType: "exe" | "title_regex";
  pattern: string;
  isUserDefined: boolean;
}

export interface LmsTask {
  id: number;
  provider: string;
  externalId: string;
  courseCode: string | null;
  title: string;
  dueAt: number | null;
  htmlUrl: string | null;
  /** When it was set aside, or null while it is still coursework you mean to do. */
  dismissedAt: number | null;
  completed: boolean;
  /** When it was ticked off here. Canvas does not report this; it is local. */
  completedAt: number | null;
}

export interface SyncResult {
  fetched: number;
  stored: number;
}

export interface ScheduleBlock {
  id: number;
  day: string;
  startTs: number;
  endTs: number;
  label: string;
  category: Category;
  targetProcess: string | null;
  targetSeconds: number | null;
  verifiedState: "pending" | "met" | "missed";
  source: "llm" | "manual";
  planId: number | null;
  /** Seconds of warning before this block. Null defers to the global default. */
  reminderLeadSeconds?: number | null;
}

/** How a hand-added event repeats. */
export type Repeat = "none" | "daily" | "weekly" | "monthly";

/**
 * An event you added yourself — a class, a shift, a train.
 *
 * Stored as a rule, not as occurrences: a class three times a week for a term is one row.
 * `events.rs` expands it, and the result is indistinguishable from a feed event, which is
 * the point — the planner refuses to schedule over either.
 */
export interface LocalEvent {
  id: number;
  title: string;
  kind: string | null;
  location: string | null;
  startTs: number;
  endTs: number;
  repeat: Repeat;
  /** For a weekly rule; 0 is Sunday. Empty means the day the first one falls on. */
  weekdays: number[];
  /** Inclusive last day, or null for a rule with no end. */
  untilTs: number | null;
}

export interface CalendarEvent {
  summary: string;
  startTs: number;
  endTs: number;
  allDay: boolean;
  /** The feed's own LOCATION, verbatim — a room, a building, whatever was typed. */
  location: string | null;
  /** Only when the feed carries one. Google's iCal export does not. */
  color: string | null;
}

/**
 * Google Calendar's own event palette. Google's iCal feed does not say which colour an
 * event uses, so a colour is derived from the title — the same event series always gets
 * the same colour, and it looks like a Google calendar even if the assignment differs.
 */
export const GOOGLE_EVENT_COLORS = [
  "#D50000", // Tomato
  "#E67C73", // Flamingo
  "#F4511E", // Tangerine
  "#F6BF26", // Banana
  "#33B679", // Sage
  "#0B8043", // Basil
  "#039BE5", // Peacock
  "#3F51B5", // Blueberry
  "#7986CB", // Lavender
  "#8E24AA", // Grape
  "#616161", // Graphite
];

export function eventColor(event: { summary: string; color: string | null }): string {
  if (event.color) return event.color;
  // FNV-1a over the title: stable across reloads and across machines.
  let hash = 2166136261;
  for (let index = 0; index < event.summary.length; index += 1) {
    hash ^= event.summary.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return GOOGLE_EVENT_COLORS[Math.abs(hash) % GOOGLE_EVENT_COLORS.length];
}

/** An intention the user typed, stored as JSON in the settings table. */
export interface Goal {
  label: string;
  targetSeconds: number;
  targetProcess?: string | null;
  category?: string;
  /** When it is due, in epoch seconds. Null means no deadline, which is the default. */
  dueAt?: number | null;
}

export interface Plan {
  id: number;
  taskId: number | null;
  title: string;
  estimateSeconds: number;
  mode: "continuous" | "pomodoro";
  pomodoroStyle: "classic" | "flowmodoro" | "custom";
  focusSeconds: number;
  breakSeconds: number;
  status: "active" | "done";
  nextCheckinSeconds: number | null;
  checkinCount: number;
  dueAt: number | null;
  /** When the user said it was finished. Null while it is still active. */
  completedAt: number | null;
}

export interface PlanProgress {
  plan: Plan;
  workedSeconds: number;
  remainingSeconds: number;
  percent: number;
  /** A check-in is on screen waiting to be answered. */
  checkinDue: boolean;
}

export interface CheckinResponse {
  planId: number;
  action: "on_track" | "extend" | "done";
  extraSeconds: number;
}

export const SECRET_CALENDAR_ICS_URL = "calendar_ics_url";

export interface VerificationResult {
  blockId: number;
  accumulatedSeconds: number;
  targetSeconds: number;
  met: boolean;
  state: "pending" | "met" | "missed";
}

export const SETTING_GOALS = "goals";
export const SETTING_DAY_END_HOUR = "day_end_hour";
/** Everything finished before this is hidden from the Completed section, not deleted. */
export const SETTING_COMPLETED_CLEARED_AT = "completed_cleared_at";

/** Keys accepted by the keychain commands. The values never cross this boundary. */
export const SECRET_CANVAS_TOKEN = "canvas_token";

export const SETTING_CANVAS_BASE_URL = "canvas_base_url";

/** Which LMS the coursework feed belongs to. */
export const SETTING_LMS_PROVIDER = "lms_provider";

/** Notifications master switch. Absent means on — a missing row must not silence it. */
export const SETTING_NOTIFICATIONS = "notifications_enabled";
/** Default minutes of warning before a block, when the block has no opinion. */
export const SETTING_REMINDER_LEAD = "reminder_lead_seconds";
export const SETTING_CHIME = "notification_chime";
/** The coursework feed URL. A credential, so it lives in the keychain. */
export const SECRET_LMS_FEED_URL = "lms_feed_url";

export type LmsProvider = "canvas" | "moodle" | "brightspace" | "blackboard" | "classroom";

/** Display name and where to find the feed, per LMS. */
export const LMS_LABELS: Record<LmsProvider, { name: string; where: string }> = {
  canvas: {
    name: "Canvas",
    where: "Calendar → Calendar Feed, at the bottom of the right-hand panel.",
  },
  moodle: {
    name: "Moodle",
    where: "Calendar → Export calendar → Get calendar URL.",
  },
  brightspace: {
    name: "Brightspace",
    where: "Calendar → Subscribe, then copy the link it offers.",
  },
  blackboard: {
    name: "Blackboard",
    where: "Calendar → Calendar Settings → Share Calendar.",
  },
  classroom: {
    name: "Google Classroom",
    where: "Classwork → the class calendar, then copy its secret iCal address.",
  },
};

/** Set once the first launch has decided about starting at login. */
export const SETTING_AUTOSTART_ASKED = "autostart_initialised";


export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  /** False on platforms where these permissions do not exist. */
  applicable: boolean;
}
