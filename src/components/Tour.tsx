import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

import type { Plannable } from "./PlanAssignmentDialog";
import type { View } from "./shell/IconRail";

export interface TourStep {
  /** The `data-tour` value to light up. None means a card in the middle of the screen. */
  target?: string;
  /** The page the step is about, switched to before anything is measured. */
  view?: View;
  /** The sync column folds away; a step about it has to unfold it first. */
  sidebar?: boolean;
  /** Steps about Settings open it; every other step closes it. */
  settings?: boolean;
  title: string;
  body: string;
  /** Numbered, for a step that is a sequence of clicks rather than a description. */
  list?: string[];
  /** Opens the plan window on `DEMO_PLAN`, so the step shows the real thing. */
  demoPlan?: boolean;
}

/**
 * The made-up task the plan steps open. Nothing it could produce is saved: the tour's
 * overlay takes every click, so "Add to plan" cannot be pressed while it is showing.
 */
export const DEMO_PLAN: Plannable = {
  taskId: null,
  title: "Example: History essay",
  subtitle: "HIST 101",
  dueAt: null,
  category: "Productivity",
  targetProcess: null,
  targetAppName: null,
  defaultMinutes: 120,
  planId: null,
  defaultMode: "pomodoro",
  defaultStyle: "classic",
  defaultFocusMinutes: 45,
  defaultBreakMinutes: 5,
};

/** Where the plan window keeps a half-typed draft of the example, cleared on the way out. */
export const DEMO_PLAN_DRAFT = `plan.draft.${DEMO_PLAN.title}`;

export const TOUR_STEPS: TourStep[] = [
  {
    view: "overview",
    title: "Welcome to Nudgy",
    body: "Nudgy runs in the background and answers one question: where did your day actually go, and did you do what you said you would? This takes a couple of minutes. Arrow keys move, Esc leaves.",
  },
  {
    target: "rail",
    view: "overview",
    title: "Four pages",
    body: "Today, Planner, Progress and the App registry. Everything else lives inside one of these.",
  },
  {
    target: "tracking",
    view: "overview",
    title: "Tracking, and the pause",
    body: "This pill shows whether Nudgy is watching. Click it to pause. The session you are in is held, not thrown away. It only records the app in front, never keystrokes, screenshots or a page's address.",
  },
  {
    target: "status",
    view: "overview",
    title: "Right now",
    body: "What you are doing, how long you have been at it, and the focus timer for the block you scheduled. With nothing scheduled, it says so rather than inventing a timer.",
  },
  {
    target: "breakdown",
    view: "overview",
    title: "Where the time went",
    body: "Today split by category, and the apps it came from. Idle time is never counted against whatever window happened to be open.",
  },
  {
    target: "planner-actions",
    view: "timeline",
    title: "Add things to the day",
    body: "Add task is for your own work. It lands in the column on the right, waiting to be planned. Add event and Read a syllabus put fixed things on the calendar, like classes and shifts. Nothing is ever scheduled over them.",
  },
  {
    target: "coursework",
    view: "timeline",
    sidebar: true,
    title: "Your coursework",
    body: "Assignments from your Canvas (or any LMS) feed appear here, grouped by course. Click any one to plan it.",
  },
  {
    target: "sync-card",
    view: "timeline",
    sidebar: true,
    title: "Everything waiting for time",
    body: "This column is your to-do list. Coursework comes first, and tasks you added yourself sit further down under Inactive. Clicking any of them is how a plan starts. Here is what that looks like.",
  },
  {
    target: "plan-how",
    view: "timeline",
    demoPlan: true,
    title: "Making a plan",
    body: "This is what opens when you click a task — here, a made-up one. First: work in focus sessions with breaks, or in one sitting, and roughly how long it will take.",
  },
  {
    target: "plan-proposed",
    view: "timeline",
    demoPlan: true,
    title: "Nudgy finds the time",
    body: "It lays the work into real free gaps in your calendar, around your classes and before the deadline. Pick a day or a start time above if you would rather choose.",
  },
  {
    target: "plan-confirm",
    view: "timeline",
    demoPlan: true,
    title: "Nothing is saved until you say so",
    body: "Add to plan puts the blocks on the planner. Halfway through, Nudgy asks whether the estimate still holds. This one is only an example, so it closes when you move on.",
  },
  {
    target: "planner",
    view: "timeline",
    title: "The planner",
    body: "One day, top to bottom, where a block's height is its real length. Your calendar sits beside your plan, and the strip on top moves between days.",
  },
  {
    target: "commitments",
    view: "progress",
    title: "Commitments",
    body: "Habits you tick yourself, and targets Nudgy measures, like at least 2h of coursework or at most 1h of games. Keep one going and the flame grows. It goes out at midnight.",
  },
  {
    target: "page",
    view: "progress",
    title: "Is it getting better?",
    body: "Day-by-day history, every commitment against every day, and a trend that knows which direction is good. Today is left out so a half-finished morning never looks like a collapse.",
  },
  {
    target: "page",
    view: "apps",
    title: "The App registry",
    body: "Apps Nudgy has not seen before show up here. Give one a category and every minute it already recorded moves with it.",
  },
  {
    target: "feeds",
    view: "overview",
    settings: true,
    title: "Connect your calendars",
    body: "Paste your LMS calendar URL here for coursework, and your Google Calendar's secret iCal address below it for classes and meetings. Neither needs an API key.",
  },
  {
    target: "appearance",
    view: "overview",
    settings: true,
    title: "Make it yours",
    body: "Change the text size, panel see-through and background while looking at the real app. The typeface and background image are just below.",
  },
  {
    target: "colours",
    view: "overview",
    settings: true,
    title: "Colours",
    body: "Pick a preset, or choose any one colour and Nudgy builds a whole theme from it.",
  },
  {
    target: "help",
    view: "overview",
    title: "That's it",
    body: "Run this tour again any time from this button.",
  },
];

interface Props {
  open: boolean;
  onStep: (step: TourStep) => void;
  onClose: () => void;
}

type Box = { left: number; top: number; width: number; height: number };
type Point = { left: number; top: number };

const CARD_WIDTH = 330;
const GAP = 14;
const MARGIN = 16;
const PAD = 6;
/** Frames a target must hold still before the spotlight commits to it. */
const SETTLE_FRAMES = 2;
/** About half a second: how long a named target may take to appear before the card centres. */
const MISSING_FRAMES = 30;

/**
 * Whether something that contains `element` is mid-animation — the page sliding in, the
 * sync column unfolding, Settings opening. Looping animations are skipped: the live dot
 * pulses forever and would otherwise mean nothing ever settles.
 */
function isCarried(element: Element): boolean {
  return document.getAnimations().some((animation) => {
    if (animation.playState !== "running") return false;
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element)) {
      return false;
    }
    if (effect.getComputedTiming().iterations === Infinity) return false;
    return effect.target.contains(element);
  });
}

/**
 * A guided walk over the real app rather than pictures of it.
 *
 * Each step names a `data-tour` element and a page. The page is switched through the same
 * `setView` the rail uses. Pages slide in for most of half a second and the sync column
 * slides out when it unfolds, so the target is watched every frame — but the spotlight
 * only **moves once it has stopped**. Chasing a sliding element restarted the transition
 * sixty times a second, which is what made it feel like it was dragging; waiting a few
 * frames and then gliding once reads as one deliberate move.
 *
 * The overlay takes every click. A tour you could click through would be a tour that could
 * delete a habit halfway through explaining what habits are.
 */
export function Tour({ open, onStep, onClose }: Props) {
  const [index, setIndex] = useState(0);
  // The hole and the card are placed together, in one state change, so they arrive in
  // one move. Placed separately, the card went once for the hole and again when its own
  // height was known — a second glide starting halfway through the first.
  const [layout, setLayout] = useState<{ hole: Box | null; card: Point }>(() => ({
    hole: null,
    card: placeCard(null, 180),
  }));
  const cardRef = useRef<HTMLDivElement>(null);
  const cardHeight = useRef(180);

  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Pages slide in when they mount. Under the tour that meant waiting most of a second
  // for the target to arrive before the spotlight could go to it, so while the tour is
  // open the page arrives already in place. See `.touring` in index.css.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add("touring");
    return () => root.classList.remove("touring");
  }, [open]);

  useEffect(() => {
    if (open) onStep(TOUR_STEPS[index]);
    // `onStep` is a fresh closure on every App render — once a second — and must not
    // re-run the step switch each time.
  }, [open, index]);

  useEffect(() => {
    if (!open) return;
    const target = step.target;
    let frame = 0;
    let reading = "";
    let still = 0;
    let waited = 0;
    let committed: string | null = null;
    let scrolled = false;

    const measure = () => {
      const element = target
        ? document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
        : null;

      // Inside Settings, the field may be below the fold of the dialog. Instant, not
      // smooth: a smooth scroll is one more thing sliding under the spotlight.
      if (element && !scrolled) {
        scrolled = true;
        element.scrollIntoView({ block: "nearest" });
      }

      const rect = element?.getBoundingClientRect();
      const box =
        rect && rect.width > 0 && rect.height > 0
          ? {
              left: Math.round(rect.left - PAD),
              top: Math.round(rect.top - PAD),
              width: Math.round(rect.width + PAD * 2),
              height: Math.round(rect.height + PAD * 2),
            }
          : null;

      const key = box ? `${box.left}|${box.top}|${box.width}|${box.height}` : "none";
      still = key === reading ? still + 1 : 0;
      reading = key;
      waited += 1;

      // Settled means nothing that carries the target is animating, not just that it
      // held still for a few frames: the last stretch of an ease-out moves less than a
      // pixel a frame, so a frame count alone committed mid-slide and then again a pixel
      // later, restarting the glide each time.
      const settled = box
        ? still >= SETTLE_FRAMES && element !== null && !isCarried(element)
        : // A target that has not appeared yet is given a moment before the card gives
          // up on it and centres — the page may still be mounting.
          !target || waited >= MISSING_FRAMES;

      if (settled && key !== committed) {
        committed = key;
        setLayout({ hole: box, card: placeCard(box, cardHeight.current) });
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [open, step.target]);

  // New copy means a new height. Watched rather than read on render, because reading
  // `offsetHeight` mid-render flushes styles and hands the transition an in-between
  // position to start from.
  useEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    const observer = new ResizeObserver(() => {
      const height = card.offsetHeight;
      if (height === cardHeight.current) return;
      cardHeight.current = height;
      setLayout((current) => ({ hole: current.hole, card: placeCard(current.hole, height) }));
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault();
        if (last) onClose();
        else setIndex((current) => current + 1);
      } else if (event.key === "ArrowLeft") {
        setIndex((current) => Math.max(0, current - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, last, onClose]);

  if (!open) return null;

  // No target is a hole of nothing in the middle of the screen, rather than a different
  // element, so moving between a lit step and an unlit one is the same glide.
  const { hole, card } = layout;
  const spot: Box = hole ?? {
    left: window.innerWidth / 2,
    top: window.innerHeight / 2,
    width: 0,
    height: 0,
  };

  return (
    <div className="fixed inset-0 z-80" aria-modal role="dialog" aria-label={step.title}>
      {/* The dim is four window-sized panels pushed up against the hole's four edges,
          moved by `transform` alone so the glide is composited and nothing is repainted
          per frame. They are solid black and overlap freely at the corners; the *group*
          is what is half transparent, so an overlap is not darker and there is no seam
          between two panels for a half-covered pixel to show through mid-glide. */}
      <div className="pointer-events-none fixed inset-0 opacity-50">
        {panels(spot).map((transform, position) => (
          <div
            key={position}
            className="tour-glide absolute top-0 left-0 h-screen w-screen bg-black"
            style={{ transform }}
          />
        ))}
      </div>
      <div
        ref={cardRef}
        className="tour-glide fixed top-0 left-0 rounded-2xl border border-edge bg-surface p-5 shadow-2xl"
        style={{
          width: CARD_WIDTH,
          maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
          overflowY: "auto",
          transform: `translate3d(${card.left}px, ${card.top}px, 0)`,
        }}
      >
        <div key={index} className="tour-copy">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">{step.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the tour"
              className="shrink-0 text-ink-mute transition hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-soft select-text">{step.body}</p>
          {step.list && (
            <ol className="mt-2 space-y-1.5">
              {step.list.map((item, position) => (
                <li key={item} className="flex gap-2 text-xs leading-relaxed text-ink-soft">
                  <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-rose-wash font-mono text-tiny font-semibold text-rose-deep">
                    {position + 1}
                  </span>
                  <span className="select-text">{item}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <span className="mr-auto font-mono text-mini tabular-nums text-ink-mute">
            {index + 1} / {TOUR_STEPS.length}
          </span>
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex((current) => current - 1)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-mini text-ink-mute transition hover:text-ink-soft"
            >
              <ArrowLeft size={12} />
              Back
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={() => (last ? onClose() : setIndex((current) => current + 1))}
            className="flex items-center gap-1 rounded-lg bg-rose px-3 py-1.5 text-mini font-semibold text-white transition hover:bg-rose-deep"
          >
            {last ? "Done" : "Next"}
            {!last && <ArrowRight size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Transforms for the four dim panels around `box`: above, below, left, right. Plain
 * translations — no scaling, so every edge stays crisp — and the side panels run the
 * full height, overlapping the other two, which the group's opacity makes invisible.
 */
function panels(box: Box): string[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return [
    `translate3d(0px, ${box.top - vh}px, 0)`,
    `translate3d(0px, ${box.top + box.height}px, 0)`,
    `translate3d(${box.left - vw}px, 0px, 0)`,
    `translate3d(${box.left + box.width}px, 0px, 0)`,
  ];
}

/**
 * Beside the lit element if there is room, then above or below, and inside its bottom
 * corner when it is the whole page. Always clamped on screen.
 */
function placeCard(hole: Box | null, height: number): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - CARD_WIDTH - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - height - MARGIN);

  if (!hole) return { left: (vw - CARD_WIDTH) / 2, top: clampY((vh - height) / 2) };

  const right = hole.left + hole.width;
  const bottom = hole.top + hole.height;

  if (right + GAP + CARD_WIDTH + MARGIN <= vw) {
    return { left: right + GAP, top: clampY(hole.top) };
  }
  if (hole.left - GAP - CARD_WIDTH >= MARGIN) {
    return { left: hole.left - GAP - CARD_WIDTH, top: clampY(hole.top) };
  }
  if (bottom + GAP + height + MARGIN <= vh) {
    return { left: clampX(hole.left), top: bottom + GAP };
  }
  if (hole.top - GAP - height >= MARGIN) {
    return { left: clampX(hole.left), top: hole.top - GAP - height };
  }
  return { left: clampX(right - CARD_WIDTH - GAP), top: clampY(bottom - height - GAP) };
}
