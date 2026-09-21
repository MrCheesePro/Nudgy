import { useMemo, useState } from "react";
import { Loader2, Plus, Search, Sparkles, Trash2, X } from "lucide-react";

import { useAppRegistry } from "../hooks/useAppRegistry";
import { categoryColor, refreshCategories, useAssignableCategories } from "../lib/categories";
import {
  addCategory,
  deleteAppRule,
  deleteCategory,
  getCategoryUsage,
  registerApp,
  setAppCategory,
  suggestCategory,
} from "../lib/ipc";
import { formatDuration } from "../lib/time";
import type { AppRule, CategoryDef, UnmappedProcess } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * One app, however many patterns name it.
 *
 * The registry matches on patterns because that is what the OS reports, but a person
 * thinks in apps — so this is the unit the list is built from.
 */
interface AppGroup {
  key: string;
  name: string;
  rules: AppRule[];
  seconds: number;
  category: string;
  /** Its patterns disagree about the category. Shown rather than silently resolved. */
  mixed: boolean;
}

/** Roughly how long ago, for a list whose whole point is "is this still relevant". */
function sinceLabel(epochSeconds: number): string {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - epochSeconds) / 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Everything Nudgy knows about an app, in one place.
 *
 * Three questions, in the order they get asked: what is already recorded and where did it
 * land, what turned up that nothing recognises, and what buckets exist at all. The first
 * one leads because "where did my time go" is only answerable if you can see — and fix —
 * how each app was filed.
 *
 * Changing a category here rewrites the time that app has already recorded, not just the
 * time it records next. A correction that only applies to the future leaves every chart
 * showing the answer you just told it was wrong.
 */
export function AppRegistry() {
  const { rules, totals, unmapped, error, loading, refresh } = useAppRegistry();
  const categories = useAssignableCategories();

  // The filter lives here now rather than in the top bar: this is the only list long
  // enough to need one, and a global search box that filtered three unrelated things was
  // never clear about what it was searching.
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "app"; group: AppGroup }
    | { kind: "category"; category: CategoryDef; body: string }
    | null
  >(null);

  const needle = query.trim().toLowerCase();

  /** Seconds recorded today per rule, so a row can show what it is actually worth. */
  const secondsByRule = useMemo(() => {
    const byProcess = new Map<string, number>();
    const byContext = new Map<string, number>();
    for (const total of totals) {
      const process = total.processName.toLowerCase();
      byProcess.set(process, (byProcess.get(process) ?? 0) + total.seconds);
      if (total.context) {
        byContext.set(total.context, (byContext.get(total.context) ?? 0) + total.seconds);
      }
    }
    return (rule: AppRule) =>
      rule.matchType === "exe"
        ? byProcess.get(rule.pattern.toLowerCase()) ?? 0
        : byContext.get(rule.displayName) ?? 0;
  }, [totals]);

  const grouped = useMemo(() => {
    const visible = rules.filter(
      (rule) =>
        !needle ||
        rule.displayName.toLowerCase().includes(needle) ||
        rule.pattern.toLowerCase().includes(needle) ||
        rule.category.toLowerCase().includes(needle),
    );

    // One app, one row. `Cursor.exe` and `com.todesktop.…` are the same program wearing
    // two platforms' names, and showing them as two entries makes the list look like a
    // dump of the seed file rather than a list of what you use. The patterns still exist
    // underneath — they are what the categorizer matches on — but the person reading this
    // is thinking about Cursor, not about executables.
    const byApp = new Map<string, AppGroup>();
    for (const rule of visible) {
      const label = rule.displayName.trim() || rule.pattern;
      const key = label.toLowerCase();
      const group = byApp.get(key) ?? {
        key,
        name: label,
        rules: [],
        seconds: 0,
        category: rule.category,
        mixed: false,
      };
      group.rules.push(rule);
      group.seconds += secondsByRule(rule);
      // Two patterns for one app can disagree — usually because one was corrected and
      // the other was not. Saying so is better than picking one and hiding the split.
      if (rule.category !== group.category) group.mixed = true;
      byApp.set(key, group);
    }

    const byCategory = new Map<string, { seconds: number; rows: AppGroup[] }>();
    for (const group of byApp.values()) {
      const bucket = byCategory.get(group.category) ?? { seconds: 0, rows: [] };
      bucket.seconds += group.seconds;
      bucket.rows.push(group);
      byCategory.set(group.category, bucket);
    }
    for (const bucket of byCategory.values()) {
      // Whatever earned time today leads; the rest fall back to alphabetical so the list
      // does not reshuffle itself every refresh.
      bucket.rows.sort(
        (left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name),
      );
    }
    return [...byCategory.entries()].sort(
      (left, right) => right[1].seconds - left[1].seconds || left[0].localeCompare(right[0]),
    );
  }, [rules, needle, secondsByRule]);

  /** Distinct apps per category, not rules — the number has to match the rows shown. */
  const ruleCounts = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    for (const rule of rules) {
      const label = (rule.displayName.trim() || rule.pattern).toLowerCase();
      const bucket = seen.get(rule.category) ?? new Set<string>();
      bucket.add(label);
      seen.set(rule.category, bucket);
    }
    return new Map([...seen].map(([category, names]) => [category, names.size]));
  }, [rules]);

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setFailure(null);
    try {
      const message = await action();
      setNote(message);
      await refresh();
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** Moves every pattern that names this app, so the row cannot end up half-corrected. */
  const move = (group: AppGroup, category: string) =>
    run(`app:${group.key}`, async () => {
      let moved = 0;
      for (const rule of group.rules) {
        moved += await setAppCategory(rule.id, category);
      }
      return moved > 0
        ? `${group.name} is now ${category} — ${moved} recorded sample${
            moved === 1 ? "" : "s"
          } moved with it.`
        : `${group.name} is now ${category}.`;
    });

  const askDeleteApp = (group: AppGroup) => setPendingDelete({ kind: "app", group });

  const askDeleteCategory = async (category: CategoryDef) => {
    try {
      const [ruleCount, seconds] = await getCategoryUsage(category.name);
      setPendingDelete({
        kind: "category",
        category,
        body:
          ruleCount === 0 && seconds === 0
            ? `Nothing is filed under ${category.name}, so nothing moves.`
            : `${ruleCount} rule${ruleCount === 1 ? "" : "s"} and ${formatDuration(
                seconds,
              )} of recorded time move to Neutral. The time is kept — only the label goes.`,
      });
    } catch (cause) {
      setFailure(String(cause));
    }
  };

  const confirmDelete = () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    if (target.kind === "app") {
      void run(`app:${target.group.key}`, async () => {
        // Only the rules the user wrote: a seeded pattern comes back on next launch, so
        // deleting it would look like the button did nothing.
        for (const rule of target.group.rules.filter((entry) => entry.isUserDefined)) {
          await deleteAppRule(rule.id);
        }
        return `${target.group.name} is no longer mapped.`;
      });
    } else {
      void run(`category:${target.category.id}`, async () => {
        await deleteCategory(target.category.id);
        await refreshCategories();
        return `${target.category.name} removed.`;
      });
    }
  };

  return (
    <>
      {failure && (
        <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-xs text-bad">
          {failure}
        </p>
      )}
      {note && (
        <p className="flex items-start justify-between gap-3 rounded-xl border border-edge bg-surface px-4 py-3 text-xs text-ink-soft">
          <span>{note}</span>
          <button type="button" onClick={() => setNote(null)} className="shrink-0 text-ink-mute">
            <X size={13} />
          </button>
        </p>
      )}
      {error && (
        <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-xs text-bad">
          {error}
        </p>
      )}

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-mute"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter apps by name, pattern or category…"
          className="w-full rounded-full border border-edge bg-surface py-2 pr-4 pl-9 text-sm text-ink outline-none transition select-text placeholder:text-ink-mute focus:border-edge-strong"
        />
      </div>

      <UnmappedSection
        unmapped={unmapped}
        categories={categories}
        busy={busy}
        onMapped={(entry, category) =>
          run(`unmapped:${entry.processName}`, async () => {
            await registerApp({
              matchType: "exe",
              pattern: entry.processName,
              displayName: entry.appName || entry.processName,
              category,
            });
            return `${entry.appName || entry.processName} is now ${category}.`;
          })
        }
      />

      <RecordedSection
        groups={grouped}
        loading={loading}
        filtered={needle.length > 0}
        categories={categories}
        busy={busy}
        onMove={move}
        onDelete={askDeleteApp}
      />

      <CategoriesSection
        categories={categories}
        counts={ruleCounts}
        busy={busy}
        onAdd={(name, color) =>
          run("category:new", async () => {
            await addCategory(name, color);
            await refreshCategories();
            return `${name} added.`;
          })
        }
        onDelete={askDeleteCategory}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === "category"
            ? `Remove ${pendingDelete.category.name}?`
            : `Unmap ${pendingDelete?.kind === "app" ? pendingDelete.group.name : ""}?`
        }
        body={
          pendingDelete?.kind === "category"
            ? pendingDelete.body
            : "The app keeps the time it has already recorded, but new time will be filed as Neutral until you map it again."
        }
        confirmLabel={pendingDelete?.kind === "category" ? "Remove it" : "Unmap it"}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ recorded */

interface RecordedProps {
  groups: [string, { seconds: number; rows: AppGroup[] }][];
  loading: boolean;
  filtered: boolean;
  categories: CategoryDef[];
  busy: string | null;
  onMove: (group: AppGroup, category: string) => void;
  onDelete: (group: AppGroup) => void;
}

function RecordedSection({
  groups,
  loading,
  filtered,
  categories,
  busy,
  onMove,
  onDelete,
}: RecordedProps) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const total = groups.reduce((sum, [, group]) => sum + group.rows.length, 0);

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
          Known apps
        </h2>
        <span className="font-mono text-xs tabular-nums text-ink-mute">{total}</span>
      </div>
      <p className="mt-1 text-xs text-ink-mute">
        Everything Nudgy recognises, and the bucket it files it under. Change one and the time
        it has already recorded moves with it.
      </p>

      {loading && groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">
          {filtered ? (
            <>
              <Search size={14} className="mr-1.5 inline" />
              Nothing matches that search.
            </>
          ) : (
            "No rules yet."
          )}
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {groups.map(([category, group]) => {
            // A category with a handful of rules shows them; one with forty does not bury
            // the rest of the page under itself.
            const expanded = open.has(category) || filtered || group.rows.length <= 6;
            const rows = expanded ? group.rows : group.rows.slice(0, 6);

            return (
              <li key={category}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: categoryColor(category) }}
                    />
                    {category}
                    <span className="text-xs font-normal text-ink-mute">
                      {group.rows.length}
                    </span>
                  </span>
                  {group.seconds > 0 && (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-ink-soft">
                      {formatDuration(group.seconds)} today
                    </span>
                  )}
                </div>

                <ul className="mt-2 space-y-1">
                  {rows.map((group) => {
                    const pending = busy === `app:${group.key}`;
                    const deletable = group.rules.some((rule) => rule.isUserDefined);
                    const allSites = group.rules.every(
                      (rule) => rule.matchType === "title_regex",
                    );
                    return (
                      <li
                        key={group.key}
                        className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-ink">
                            {group.name}
                            {allSites && (
                              <span className="ml-1.5 text-tiny tracking-wide text-ink-mute uppercase">
                                site
                              </span>
                            )}
                            {group.mixed && (
                              <span className="ml-1.5 rounded bg-warn/15 px-1 py-px text-micro font-medium text-warn uppercase">
                                split
                              </span>
                            )}
                          </div>
                          {/* The patterns are still what the categorizer matches on, so
                              they stay visible — just demoted to a count once there is
                              more than one, since nobody reads two bundle ids. */}
                          <div
                            className="truncate font-mono text-tiny text-ink-mute"
                            title={group.rules.map((rule) => rule.pattern).join("\n")}
                          >
                            {group.rules.length === 1
                              ? group.rules[0].pattern
                              : `${group.rules.length} patterns`}
                          </div>
                        </div>

                        <span className="shrink-0 font-mono text-mini tabular-nums text-ink-mute">
                          {group.seconds > 0 ? formatDuration(group.seconds) : "\u2014"}
                        </span>

                        <select
                          value={group.category}
                          disabled={pending}
                          onChange={(event) => onMove(group, event.target.value)}
                          className="rounded-lg border border-edge bg-surface px-2 py-1 text-mini text-ink-soft outline-none focus:border-edge-strong disabled:opacity-50"
                        >
                          {categories.map((entry) => (
                            <option key={entry.id} value={entry.name}>
                              {entry.name}
                            </option>
                          ))}
                          {/* A rule can hold a category the list no longer has; showing it
                              beats silently rewriting it to whatever sorts first. */}
                          {!categories.some((entry) => entry.name === group.category) && (
                            <option value={group.category}>{group.category}</option>
                          )}
                        </select>

                        {deletable ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => onDelete(group)}
                            className="shrink-0 rounded-lg p-1.5 text-ink-mute transition hover:text-bad disabled:opacity-50"
                            aria-label={`Unmap ${group.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : (
                          <span className="w-[26px]" />
                        )}
                      </li>
                    );
                  })}
                </ul>

                {!expanded && (
                  <button
                    type="button"
                    onClick={() => setOpen((previous) => new Set(previous).add(category))}
                    className="mt-1.5 text-mini text-ink-mute transition hover:text-ink-soft"
                  >
                    Show all {group.rows.length}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- unmapped */

interface UnmappedProps {
  unmapped: UnmappedProcess[];
  categories: CategoryDef[];
  busy: string | null;
  onMapped: (entry: UnmappedProcess, category: string) => void;
}

const VISIBLE_UNMAPPED = 8;

function UnmappedSection({ unmapped, categories, busy, onMapped }: UnmappedProps) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, string>>({});
  const [guessing, setGuessing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [manual, setManual] = useState({ pattern: "", name: "", category: "" });

  const fallback = categories[0]?.name ?? "Productivity";
  const rows = showAll ? unmapped : unmapped.slice(0, VISIBLE_UNMAPPED);

  const guess = async (entry: UnmappedProcess) => {
    setGuessing(entry.processName);
    try {
      const suggestion = await suggestCategory(entry.processName, entry.appName);
      setSources((previous) => ({ ...previous, [entry.processName]: suggestion.source }));
      if (suggestion.category) {
        setChoices((previous) => ({ ...previous, [entry.processName]: suggestion.category! }));
      }
    } catch {
      // A failed guess is not a failure of the screen — the dropdown still works.
      setSources((previous) => ({ ...previous, [entry.processName]: "none" }));
    } finally {
      setGuessing(null);
    }
  };

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
          Unrecognised
        </h2>
        <span className="text-mini text-ink-mute">last 48 hours</span>
      </div>
      <p className="mt-1 text-xs text-ink-mute">
        Tracked as Neutral because no rule matched. Give one a category and Nudgy will
        remember — including for the time it has already recorded.
      </p>

      {unmapped.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-mute">
          Nothing unrecognised in the last two days.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-2">
            {rows.map((entry) => {
              const choice = choices[entry.processName] ?? fallback;
              const source = sources[entry.processName];
              const pending = busy === `unmapped:${entry.processName}`;
              return (
                <li
                  key={entry.processName}
                  className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{entry.appName}</div>
                    <div className="truncate font-mono text-xs text-ink-mute">
                      {entry.processName}
                    </div>
                  </div>

                  <span className="shrink-0 text-right font-mono text-mini tabular-nums text-ink-mute">
                    {formatDuration(entry.seconds)}
                    <span className="block text-tiny">{sinceLabel(entry.lastSeen)}</span>
                  </span>

                  <button
                    type="button"
                    disabled={guessing === entry.processName || pending}
                    onClick={() => void guess(entry)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-mini text-ink-soft transition hover:border-edge-strong disabled:opacity-50"
                  >
                    {guessing === entry.processName ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    Suggest
                  </button>

                  {source && (
                    <span className="shrink-0 text-tiny tracking-wide text-ink-mute uppercase">
                      {source === "heuristic" ? "guess" : source === "llm" ? "AI" : "no idea"}
                    </span>
                  )}

                  <select
                    value={choice}
                    disabled={pending}
                    onChange={(event) =>
                      setChoices((previous) => ({
                        ...previous,
                        [entry.processName]: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong disabled:opacity-50"
                  >
                    {categories.map((category) => (
                      <option key={category.id} value={category.name}>
                        {category.name}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onMapped(entry, choice)}
                    className="flex items-center gap-1.5 rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong disabled:opacity-50"
                  >
                    <Plus size={13} />
                    Map
                  </button>
                </li>
              );
            })}
          </ul>

          {unmapped.length > VISIBLE_UNMAPPED && (
            <button
              type="button"
              onClick={() => setShowAll((shown) => !shown)}
              className="mt-2 text-mini text-ink-mute transition hover:text-ink-soft"
            >
              {showAll ? "Show fewer" : `Show all ${unmapped.length}`}
            </button>
          )}
        </>
      )}

      {/* Some apps never turn up in the feed above — a game you have not launched yet, a
          tool on the other machine. This is how they get a category anyway. */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
        <input
          value={manual.pattern}
          onChange={(event) => setManual({ ...manual, pattern: event.target.value })}
          placeholder="com.example.App or App.exe"
          className="min-w-[180px] flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 font-mono text-xs text-ink-soft outline-none focus:border-edge-strong"
        />
        <input
          value={manual.name}
          onChange={(event) => setManual({ ...manual, name: event.target.value })}
          placeholder="Display name"
          className="min-w-[140px] flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        />
        <select
          value={manual.category || fallback}
          onChange={(event) => setManual({ ...manual, category: event.target.value })}
          className="rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.name}>
              {category.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={manual.pattern.trim().length === 0}
          onClick={() => {
            onMapped(
              {
                processName: manual.pattern.trim(),
                appName: manual.name.trim() || manual.pattern.trim(),
                seconds: 0,
                lastSeen: 0,
              },
              manual.category || fallback,
            );
            setManual({ pattern: "", name: "", category: "" });
          }}
          className="rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-soft transition hover:border-edge-strong disabled:opacity-40"
        >
          Add by hand
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- categories */

interface CategoriesProps {
  categories: CategoryDef[];
  counts: Map<string, number>;
  busy: string | null;
  onAdd: (name: string, color: string) => void;
  onDelete: (category: CategoryDef) => void;
}

function CategoriesSection({ categories, counts, busy, onAdd, onDelete }: CategoriesProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7fb2e5");

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
        Categories
      </h2>
      <p className="mt-1 text-xs text-ink-mute">
        The buckets every app and every scheduled block is filed into. Removing one keeps
        what was in it — rules and recorded time fall back to Neutral.
      </p>

      <ul className="mt-4 flex flex-wrap gap-2">
        {categories.map((category) => (
          <li
            key={category.id}
            className="flex items-center gap-2 rounded-full border border-edge bg-canvas py-1.5 pr-2 pl-3"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: category.color }}
            />
            <span className="text-xs text-ink">{category.name}</span>
            <span className="font-mono text-tiny tabular-nums text-ink-mute">
              {counts.get(category.name) ?? 0}
            </span>
            {category.isBuiltin ? (
              <span className="w-[18px]" />
            ) : (
              <button
                type="button"
                disabled={busy === `category:${category.id}`}
                onClick={() => onDelete(category)}
                className="rounded-full p-0.5 text-ink-mute transition hover:text-bad disabled:opacity-50"
                aria-label={`Remove ${category.name}`}
              >
                <X size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-edge bg-canvas p-1"
          aria-label="Category colour"
        />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) {
              onAdd(name.trim(), color);
              setName("");
            }
          }}
          placeholder="New category — Reading, Chores, Exercise…"
          className="min-w-[200px] flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        />
        <button
          type="button"
          disabled={name.trim().length === 0 || busy === "category:new"}
          onClick={() => {
            onAdd(name.trim(), color);
            setName("");
          }}
          className="flex items-center gap-1.5 rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong disabled:opacity-40"
        >
          <Plus size={13} />
          Add
        </button>
      </div>
    </section>
  );
}
