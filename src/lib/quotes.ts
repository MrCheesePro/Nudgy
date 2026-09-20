/**
 * A line from a Ghibli film, one per day.
 *
 * Deterministic on the date, not random: a quote that reshuffles on every render is
 * decoration, and one that holds for the day is something you can actually sit with.
 *
 * Translations of these films vary between subtitle and dub releases, so these are the
 * widely circulated English renderings rather than a single canonical script.
 */

export interface Quote {
  text: string;
  film: string;
}

const QUOTES: Quote[] = [
  {
    text: "You cannot alter your fate. However, you can rise to meet it.",
    film: "Princess Mononoke",
  },
  {
    text: "Life is suffering. It is hard. The world is cursed. But still, you find reasons to keep on living.",
    film: "Princess Mononoke",
  },
  {
    text: "Once you've met someone, you never really forget them.",
    film: "Spirited Away",
  },
  {
    text: "Nothing that happens is ever forgotten, even if you can't remember it.",
    film: "Spirited Away",
  },
  {
    text: "A heart's a heavy burden.",
    film: "Howl's Moving Castle",
  },
  {
    text: "They say that the best blaze burns brightest when circumstances are at their worst.",
    film: "Howl's Moving Castle",
  },
  {
    text: "Always believe in yourself. Do this and no matter where you are, you will have nothing to fear.",
    film: "The Cat Returns",
  },
  {
    text: "We each need to find our own inspiration. Sometimes it isn't easy.",
    film: "Kiki's Delivery Service",
  },
  {
    text: "Sometimes I have to rest and wait for the inspiration to return.",
    film: "Kiki's Delivery Service",
  },
  {
    text: "The wind is rising. We must try to live.",
    film: "The Wind Rises",
  },
  {
    text: "Airplanes are beautiful dreams. Engineers turn dreams into reality.",
    film: "The Wind Rises",
  },
  {
    text: "Trees and people used to be good friends.",
    film: "My Neighbour Totoro",
  },
  {
    text: "One thing you can always count on is that hearts change.",
    film: "Howl's Moving Castle",
  },
  {
    text: "You've got to look for your own inspiration.",
    film: "Kiki's Delivery Service",
  },
];

/**
 * The quote for a given local day. Stable within the day, different the next.
 *
 * FNV-1a over the date rather than an index into the calendar, so the sequence does not
 * march predictably through the list and the same quote does not land on the same weekday
 * every week.
 */
export function quoteForDay(day: string): Quote {
  let hash = 2166136261;
  for (let index = 0; index < day.length; index += 1) {
    hash ^= day.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return QUOTES[Math.abs(hash) % QUOTES.length];
}
