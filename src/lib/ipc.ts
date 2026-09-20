import { invoke } from "@tauri-apps/api/core";

import type {
  AppRule,
  AppTotal,
  CalendarEvent,
  CategoryDef,
  CategoryTarget,
  DailyTotal,
  CategorySuggestion,
  CheckinResponse,
  LiveStatus,
  LmsTask,
  Plan,
  PlanProgress,
  PermissionStatus,
  AddressEstimate,
  DetectedLocation,
  Place,
  TravelEstimate,
  TravelRow,
  RedactionRule,
  ScheduleBlock,
  SyncResult,
  UnmappedProcess,
  UsageBreakdown,
  VerificationResult,
} from "./types";

/**
 * One typed wrapper per Rust command. Components never call `invoke` directly, so a
 * renamed command breaks the build here instead of at runtime in four places.
 */

export const getLiveStatus = () => invoke<LiveStatus | null>("get_live_status");

export const getUsageBreakdown = (startTs: number, endTs: number) =>
  invoke<UsageBreakdown>("get_usage_breakdown", { startTs, endTs });

export const getAppTotals = (startTs: number, endTs: number, limit = 40) =>
  invoke<AppTotal[]>("get_app_totals", { startTs, endTs, limit });

export const listUnmappedProcesses = (sinceTs?: number) =>
  invoke<UnmappedProcess[]>("list_unmapped_processes", { sinceTs: sinceTs ?? null });

export const getAppRules = () => invoke<AppRule[]>("get_app_rules");

export const registerApp = (input: {
  matchType: string;
  pattern: string;
  displayName: string;
  category: string;
}) => invoke<void>("register_app", input);

export const deleteAppRule = (id: number) => invoke<void>("delete_app_rule", { id });

/** Moves a rule to another category and moves the time it already recorded with it.
 *  Resolves with the number of samples that were re-filed. */
export const setAppCategory = (id: number, category: string) =>
  invoke<number>("set_app_category", { id, category });

export const getCategories = () => invoke<CategoryDef[]>("get_categories");

/** Per-day, per-category totals over a range — what the Progress chart is built from. */
export const getDailyTotals = (startTs: number, endTs: number) =>
  invoke<DailyTotal[]>("get_daily_totals", { startTs, endTs });

export const getCategoryTargets = () => invoke<CategoryTarget[]>("get_category_targets");

export const setCategoryTarget = (
  category: string,
  direction: "at_least" | "at_most",
  secondsPerDay: number,
) => invoke<void>("set_category_target", { category, direction, secondsPerDay });

export const clearCategoryTarget = (category: string) =>
  invoke<void>("clear_category_target", { category });

export const addCategory = (name: string, color: string) =>
  invoke<void>("add_category", { name, color });

export const deleteCategory = (id: number) => invoke<void>("delete_category", { id });

/** `[rules, seconds]` that would fall back to Neutral if this category were deleted. */
export const getCategoryUsage = (name: string) =>
  invoke<[number, number]>("category_usage", { name });

/** Offline keyword guess first; the model only when that has no opinion. */
export const suggestCategory = (processName: string, appName?: string | null) =>
  invoke<CategorySuggestion>("suggest_category", { processName, appName: appName ?? null });

export const getPlaces = () => invoke<Place[]>("get_places");

/** Works out where you are and makes it the base. Pass coordinates when the browser
 *  will give them; without them the provider infers a rougher position from the network. */
export const detectCurrentLocation = (latitude?: number, longitude?: number) =>
  invoke<DetectedLocation>("detect_current_location", {
    latitude: latitude ?? null,
    longitude: longitude ?? null,
  });

/** Turns a typed address into a place and times the trip from where you are. */
export const estimateAddress = (address: string, name?: string, mode?: string) =>
  invoke<AddressEstimate>("estimate_address", {
    address,
    name: name ?? null,
    mode: mode ?? null,
  });

export const addPlace = (name: string, address: string) =>
  invoke<number>("add_place", { name, address });

export const updatePlace = (id: number, name: string, address: string) =>
  invoke<void>("update_place", { id, name, address });

export const deletePlace = (id: number) => invoke<void>("delete_place", { id });

export const setBasePlace = (id: number) => invoke<void>("set_base_place", { id });

/** Every travel time already known locally — one call pads a whole week. */
export const getTravelTimes = () => invoke<TravelRow[]>("get_travel_times");

/** Records a travel time by hand, in minutes — how travel works without a maps key. */
export const setTravelTime = (
  originId: number,
  destinationId: number,
  minutes: number,
  mode?: string,
) =>
  invoke<void>("set_travel_time", {
    originId,
    destinationId,
    minutes,
    mode: mode ?? null,
  });

/** Cache first. `refresh` forces a fresh lookup when a commute has actually changed. */
export const lookupTravel = (
  originId: number,
  destinationId: number,
  mode?: string,
  refresh?: boolean,
) =>
  invoke<TravelEstimate>("lookup_travel", {
    originId,
    destinationId,
    mode: mode ?? null,
    refresh: refresh ?? null,
  });

/** Deletes every recorded sample. Plans, schedule, tasks and rules are untouched. */
export const clearActivityData = () => invoke<number>("clear_activity_data");

/** Guesses which app a goal is about from its wording; null when it cannot tell. */
export const resolveAppForText = (text: string) =>
  invoke<AppRule | null>("resolve_app_for_text", { text });

export const getRedactionRules = () => invoke<RedactionRule[]>("get_redaction_rules");

export const addRedactionRule = (matchType: string, pattern: string) =>
  invoke<void>("add_redaction_rule", { matchType, pattern });

export const deleteRedactionRule = (id: number) =>
  invoke<void>("delete_redaction_rule", { id });

export const getSettings = () => invoke<[string, string][]>("get_settings");

export const setSetting = (key: string, value: string) =>
  invoke<void>("set_setting", { key, value });

/** Reports only whether a secret exists — there is no command that returns its value. */
export const hasSecret = (key: string) => invoke<boolean>("has_secret", { key });

export const setSecret = (key: string, value: string) =>
  invoke<void>("set_secret", { key, value });

export const clearSecret = (key: string) => invoke<void>("clear_secret", { key });

export const getTasks = (includeCompleted = false) =>
  invoke<LmsTask[]>("get_tasks", { includeCompleted });

export const setTaskCompleted = (id: number, completed: boolean) =>
  invoke<void>("set_task_completed", { id, completed });

export const syncCanvas = () => invoke<SyncResult>("sync_canvas");

export const getSchedule = (day: string) =>
  invoke<ScheduleBlock[]>("get_schedule", { day });

export const getScheduleRange = (startDay: string, endDay: string) =>
  invoke<ScheduleBlock[]>("get_schedule_range", { startDay, endDay });

export const saveSchedule = (day: string, blocks: Partial<ScheduleBlock>[]) =>
  invoke<number>("save_schedule", { day, blocks });

export const verifySchedule = (day: string) =>
  invoke<VerificationResult[]>("verify_schedule", { day });

export const verifyGoal = (
  processName: string,
  startTs: number,
  endTs: number,
  targetSeconds: number,
) => invoke<VerificationResult>("verify_goal", { processName, startTs, endTs, targetSeconds });

/**
 * Returns the model's raw JSON. The caller validates it before anything is stored.
 *
 * No caller today: planning is deterministic and asks the user instead. Kept as the wire
 * for a future "ask the model" button, alongside `generate_agenda` in Rust.
 */
export const generateAgenda = (payload: unknown, schema: unknown) =>
  invoke<unknown>("generate_agenda", { payload, schema });

export const getCalendarEvents = (startTs: number, endTs: number) =>
  invoke<CalendarEvent[]>("get_calendar_events", { startTs, endTs });

export const createPlan = (
  plan: Omit<Plan, "id" | "status" | "nextCheckinSeconds" | "checkinCount" | "completedAt">,
  day: string,
  blocks: Partial<ScheduleBlock>[],
) => invoke<number>("create_plan", { plan, day, blocks });

export const getPlans = () => invoke<PlanProgress[]>("get_plans");

export const respondCheckin = (response: CheckinResponse) =>
  invoke<PlanProgress>("respond_checkin", { response });

export const deletePlan = (id: number) => invoke<void>("delete_plan", { id });

export const getPaused = () => invoke<boolean>("get_paused");

export const setPaused = (paused: boolean) => invoke<void>("set_paused", { paused });

export const checkMacosPermissions = () =>
  invoke<PermissionStatus>("check_macos_permissions");

export const requestScreenRecordingAccess = () =>
  invoke<boolean>("request_screen_recording_access");

export const flushSamples = () => invoke<number>("flush_samples");

export const getDatabasePath = () => invoke<string>("get_database_path");

export const openPrivacySettings = (pane: "accessibility" | "screen_recording") =>
  invoke<void>("open_privacy_settings", { pane });
