// Trip memory: the GPS remembers every trip so it can predict how you'll ruin the next one.
// Records are plain JSON; the app persists them (AsyncStorage, SQLite, localStorage...).

import { fill } from "./lines.ts";
import type { CritiqueEngine } from "./engine.ts";
import type { LatLon } from "./types.ts";

export interface TripRecord {
  routeKey: string;
  destination: string;
  endedAt: number;
  /** What the routing provider estimated when the trip started. */
  expectedMinutes: number;
  actualMinutes: number;
  speedingShare: number; // 0..1 of the trip spent over the limit
  missedTurns: number;
  hardBrakes: number;
  grade: string;
}

export interface TripPlan {
  origin: LatLon;
  destination: LatLon;
  /** What the driver said to Whisper, e.g. "Mom's house". */
  destinationName: string;
  expectedMinutes: number;
}

export interface TripPrediction {
  text: string;
  predictedMinutes: number;
  habit: "leadFoot" | "slowpoke" | "onTime" | "unknown";
  timesOnRoute: number;
}

/**
 * Same origin and destination within ~250 m count as the same route, so "home to work"
 * matches even if you park in a different spot.
 */
export function routeKey(origin: LatLon, destination: LatLon): string {
  const snap = (p: LatLon) => `${(Math.round(p.lat * 400) / 400).toFixed(4)},${(Math.round(p.lon * 400) / 400).toFixed(4)}`;
  return `${snap(origin)}>${snap(destination)}`;
}

/** Turn a finished trip into a record to store. */
export function recordTrip(engine: CritiqueEngine, plan: TripPlan): TripRecord {
  const st = engine.stats;
  const endedAt = st.endedAt ?? st.startedAt;
  const minutes = Math.max(0, (endedAt - st.startedAt) / 60_000);
  return {
    routeKey: routeKey(plan.origin, plan.destination),
    destination: plan.destinationName,
    endedAt,
    expectedMinutes: plan.expectedMinutes,
    actualMinutes: +minutes.toFixed(1),
    speedingShare: minutes > 0 ? +(st.speedingSeconds / (minutes * 60)).toFixed(3) : 0,
    missedTurns: st.missedTurns,
    hardBrakes: st.hardBrakes,
    grade: engine.report().overall.letter,
  };
}

const LINES = {
  leadFoot: [
    "This route should take {expected} minutes, but knowing you it'll probably take {predicted} with your lead foot. I'm just glad I don't have eyes.",
    "Estimated time: {expected} minutes. Your estimated time: {predicted}. The speed limit's estimated time: we'll never know.",
    "{expected} minutes for normal people. {predicted} for you. Please remember the brake is the other pedal.",
  ],
  slowpoke: [
    "This should take {expected} minutes. With you driving, call it {predicted}. Maybe pack a snack.",
    "{expected} minutes, says the map. The map has never met you. I'm saying {predicted}.",
  ],
  onTime: [
    "{expected} minutes. You usually manage that, somehow. Don't get cocky.",
  ],
  unknown: [
    "New route. I have no data on you here. Yet.",
    "Never driven this one before. Neither of us knows how bad this will be. That's exciting. For me.",
  ],
  repeat: [
    " This is your {n} trip to {destination}. You'd think you'd know the way by now.",
    " {destination} again, for the {n} time. I could drive this myself, and I don't have hands.",
  ],
  missedBefore: [
    " Last time you missed {missed} turn{s} on this exact route. Let's aim for fewer. It's a low bar. Step over it.",
  ],
  brakesBefore: [
    " Last time you brake checked {brakes} times here. The guy behind you still talks about it.",
  ],
};

/**
 * The opening jab when a trip starts. Uses the driver's habits across all trips, weighted
 * toward this route (your "ratio" is actual time / estimated time).
 */
export function predictTrip(history: readonly TripRecord[], plan: TripPlan, rng: () => number = Math.random): TripPrediction {
  const key = routeKey(plan.origin, plan.destination);
  const sameRoute = history.filter((r) => r.routeKey === key);
  const usable = history.filter((r) => r.expectedMinutes > 0 && r.actualMinutes > 0);
  const pick = (lines: string[]) => lines[Math.floor(rng() * lines.length)];

  if (usable.length === 0) {
    return { text: pick(LINES.unknown), predictedMinutes: plan.expectedMinutes, habit: "unknown", timesOnRoute: 0 };
  }

  // Same-route trips count triple; the median keeps one road-trip disaster from skewing it.
  const ratios = usable.flatMap((r) => {
    const ratio = r.actualMinutes / r.expectedMinutes;
    return r.routeKey === key ? [ratio, ratio, ratio] : [ratio];
  });
  const ratio = median(ratios);
  const predicted = Math.max(1, Math.round(plan.expectedMinutes * ratio));
  const habit = ratio <= 0.92 ? "leadFoot" : ratio >= 1.1 ? "slowpoke" : "onTime";

  const vars = {
    expected: Math.round(plan.expectedMinutes),
    predicted,
    destination: plan.destinationName,
    n: ordinalWord(sameRoute.length + 1),
  };
  let text = fill(pick(LINES[habit]), vars);

  const last = sameRoute.at(-1);
  if (last?.missedTurns) {
    text += fill(pick(LINES.missedBefore), { missed: last.missedTurns, s: last.missedTurns === 1 ? "" : "s" });
  } else if (last && last.hardBrakes >= 2) {
    text += fill(pick(LINES.brakesBefore), { brakes: last.hardBrakes });
  } else if (sameRoute.length >= 2) {
    text += fill(pick(LINES.repeat), vars);
  }
  return { text, predictedMinutes: predicted, habit, timesOnRoute: sameRoute.length };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ordinalWord(n: number): string {
  const words = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  if (n < words.length) return words[n];
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}
