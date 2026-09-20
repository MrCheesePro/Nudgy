import { useSyncExternalStore } from "react";

import { getCategories } from "./ipc";
import { CATEGORY_NEUTRAL, FALLBACK_COLORS, type CategoryDef } from "./types";

/**
 * The category vocabulary, once, for the whole app.
 *
 * Categories used to be a constant, so any component could read one synchronously. They
 * are rows now, and a dozen call sites want a colour in the middle of a render — passing a
 * hook down through all of them would turn a one-line lookup into a prop drill. So the
 * list lives in one tiny store: components that need to *react* subscribe, and the ones
 * that only need a colour call a plain function against the current snapshot.
 */

let snapshot: CategoryDef[] = [];
let colors = new Map<string, string>();
const listeners = new Set<() => void>();

function publish(next: CategoryDef[]) {
  snapshot = next;
  colors = new Map(next.map((category) => [category.name, category.color]));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reloads from the database. Called on mount and after anything changes a category. */
export async function refreshCategories(): Promise<CategoryDef[]> {
  const next = await getCategories();
  publish(next);
  return next;
}

/** The live vocabulary. Re-renders the caller when a category is added or removed. */
export function useCategories(): CategoryDef[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * Everything a person can *assign* to. `Idle` is how absence is recorded, not a choice
 * anybody makes, so it never appears in a dropdown.
 */
export function useAssignableCategories(): CategoryDef[] {
  return useCategories().filter((category) => category.name !== "Idle");
}

/**
 * The colour for a category name. Falls back to the shipped palette and then to Neutral's
 * grey, so a chart drawn before the table loads — or one holding a name that has since
 * been deleted — still renders something sensible instead of `undefined`.
 */
export function categoryColor(name: string | null | undefined): string {
  if (!name) return FALLBACK_COLORS[CATEGORY_NEUTRAL];
  return colors.get(name) ?? FALLBACK_COLORS[name] ?? FALLBACK_COLORS[CATEGORY_NEUTRAL];
}
