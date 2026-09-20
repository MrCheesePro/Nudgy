/** Mirrors the serde structs in `src-tauri/src/models.rs`. Keep the two in step. */

export type Category =
  | "Development"
  | "Productivity"
  | "Gaming"
  | "Creative"
  | "Social"
  | "Neutral"
  | "Idle";

export const CATEGORIES: Category[] = [
  "Development",
  "Productivity",
  "Gaming",
  "Creative",
  "Social",
  "Neutral",
  "Idle",
];

/** Tuned for the blush light theme: saturated enough to separate, warm enough to belong. */
export const CATEGORY_COLORS: Record<Category, string> = {
  Development: "#8b7bd8",
  Productivity: "#4fa88c",
  Creative: "#e0a05e",
  Social: "#e0818f",
  Gaming: "#b07bd4",
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
}

export interface CalendarEvent {
  summary: string;
  startTs: number;
  endTs: number;
  allDay: boolean;
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
export const SECRET_LLM_API_KEY = "llm_api_key";

export const SETTING_CANVAS_BASE_URL = "canvas_base_url";

export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  /** False on platforms where these permissions do not exist. */
  applicable: boolean;
}
