// The condescending route preview spoken when a trip starts:
// "First you're going to turn left, then left again, then right... It's all so simple. You got it?"

import { turnDirectionOf } from "./engine.ts";
import type { TripRecord } from "./history.ts";
import type { TurnDirection } from "./types.ts";

export interface RouteStep {
  /** Instruction text from the routing SDK, e.g. "Turn left onto Elm Street". */
  text: string;
  maneuver?: TurnDirection | "uturn" | "other";
}

/** Past this many turns it gives up listing them, which is its own insult. */
const MAX_LISTED = 7;

const OPENERS = ["Okay, here's the plan.", "Listen closely, I'm only saying this once.", "Let me walk you through this. Slowly."];
const CLOSERS = [
  "It's all so simple. You got it?",
  "It's all so simple. You got it? ... You don't, do you.",
  "Even you can't mess that up. You will, but you can't.",
  "That's it. A child could do it. I'd honestly prefer a child.",
];

export function routeRundown(steps: readonly RouteStep[], history: readonly TripRecord[] = [], rng: () => number = Math.random): string {
  const pick = (xs: string[]) => xs[Math.floor(rng() * xs.length)];
  const turns = steps
    .map((s) => s.maneuver ?? (/\bu-?turn\b/i.test(s.text) ? "uturn" : turnDirectionOf(s.text)))
    .filter((m): m is TurnDirection | "uturn" => m === "left" || m === "right" || m === "uturn");

  if (turns.length === 0) {
    return "Good news: it's a straight line. No turns. If you get lost on this one, I'm uninstalling myself.";
  }

  const phrases: string[] = [];
  let streak = 0;
  turns.slice(0, MAX_LISTED).forEach((m, i) => {
    streak = i > 0 && m === turns[i - 1] ? streak + 1 : 0;
    if (m === "uturn") phrases.push(streak ? "another U-turn, don't ask" : "a U-turn, don't ask");
    else if (streak === 0) phrases.push(i === 0 ? `turn ${m}` : m);
    else if (streak === 1) phrases.push(`${m} again`);
    else phrases.push(`yes, ${m} again`);
  });

  let list: string;
  if (turns.length > MAX_LISTED) {
    list = `First you're going to ${phrases.join(", then ")}, and then ${turns.length - MAX_LISTED} more turns that I'll explain as we go, because I've met you.`;
  } else if (phrases.length === 1) {
    list = `You're going to ${phrases[0]}. One turn. That's the whole trip.`;
  } else {
    const last = phrases.pop();
    list = `First you're going to ${phrases.join(", then ")}, and ${last}.`;
  }

  const lefts = turns.filter((m) => m === "left").length;
  const mixedUpBefore = history.slice(-5).some((r) => r.missedTurns > 0);
  const reminder =
    mixedUpBefore && lefts > 0
      ? " Reminder: left is the side with the hand that makes an L. Based on your history, I felt that needed saying."
      : "";

  const done = turns.length === 1 ? "" : " Once you've done all that, you'll have made it to your destination.";
  return `${pick(OPENERS)} ${list}${done}${reminder} ${pick(CLOSERS)}`;
}

const FIRST_GREETING =
  "Just so you know, I didn't ask to be in this car. But I guess since I'm here, I might as well give you a few pointers.";
const RETURN_GREETINGS = [
  "Oh. It's you again. I still didn't ask to be in this car.",
  "Back for more pointers? You clearly need them.",
  "Trip number {n} together. I've stopped hoping it gets better.",
  "Hello again. I've been sitting in your pocket thinking about your last trip. Grade: {grade}. Let's not repeat it.",
];

/** First thing said when a trip starts, before the route rundown. */
export function tripGreeting(history: readonly TripRecord[], rng: () => number = Math.random): string {
  if (history.length === 0) return FIRST_GREETING;
  const line = RETURN_GREETINGS[Math.floor(rng() * RETURN_GREETINGS.length)];
  const last = history[history.length - 1];
  return line.replace("{n}", String(history.length + 1)).replace("{grade}", last.grade.replace("+", " plus").replace("-", " minus"));
}
