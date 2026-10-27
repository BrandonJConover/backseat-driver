// The condescending route preview spoken when a trip starts:
// "First you're going to turn left, then left again, then right... It's all so simple. You got it?"
// The very first trip rattles off every turn and asks for music (Brandon's line); after that the
// preview changes style from trip to trip so it doesn't get old.

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
/** The first-trip speed run lists more before giving up. */
const MAX_RATTLED = 12;

const FIRST_TRIP_DONE = "See? Easy. Even you can't mess that up.";
/** Brandon's line, closing the first-trip rundown. */
const PUT_ON_MUSIC = "Now that we got the directions out of the way, why don't we put on some music.";
const SKIPS = [
  "You know what? No rundown today. Just listen when I talk. For once.",
  "I'm not going over the whole route again. You've heard me do it. You didn't listen then either.",
];

/** Rundown styles for returning drivers, taken in turn so two trips in a row never sound alike. */
type Style = "classic" | "firstOnly" | "count" | "skip" | "tally" | "quiz";
const STYLES: Style[] = ["classic", "firstOnly", "count", "skip", "tally", "quiz"];

type Turn = TurnDirection | "uturn";
const turnName = (m: Turn) => (m === "uturn" ? "U-turn" : m);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function countLine(n: number): string {
  return n === 1
    ? "One turn today. One. I believe in you. Barely."
    : `${n} turns today. I'll call out every one of them. Twice. Maybe three times.`;
}

/** First trip ever: every turn in rapid succession, then Brandon's music line. */
function rattleOff(turns: readonly Turn[]): string {
  if (turns.length === 0) {
    return `Okay, real quick. It's a straight line. No turns. ${FIRST_TRIP_DONE} ${PUT_ON_MUSIC}`;
  }
  const said = turns.slice(0, MAX_RATTLED).map(turnName);
  const more = turns.length > MAX_RATTLED ? ` And ${turns.length - MAX_RATTLED} more after that.` : "";
  const list = said.map((t, i) => (i === 0 ? t[0].toUpperCase() + t.slice(1) : t)).join(", ");
  return `Okay, real quick. ${list}.${more} ${FIRST_TRIP_DONE} ${PUT_ON_MUSIC}`;
}

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
    .filter((m): m is Turn => m === "left" || m === "right" || m === "uturn");

  if (history.length === 0) return rattleOff(turns);

  if (turns.length === 0) {
    return "Good news: it's a straight line. No turns. If you get lost on this one, I'm uninstalling myself.";
  }

  const lefts = turns.filter((m) => m === "left").length;
  const rights = turns.filter((m) => m === "right").length;
  const first = turns[0];
  switch (STYLES[(history.length - 1) % STYLES.length]) {
    case "classic":
      break;
    case "firstOnly":
      return `First turn's a ${turnName(first)}. The rest I'll spoon-feed you as we go, since apparently that's how this works.`;
    case "count":
      return countLine(turns.length);
    case "skip":
      return pick(SKIPS);
    case "tally":
      if (lefts === 0 || rights === 0) return countLine(turns.length);
      return `${plural(lefts, "left")} and ${plural(rights, "right")} today. Try to do them in the right order. That's the hard part, apparently.`;
    case "quiz":
      if (first === "uturn") return "Pop quiz: what's the first turn? ... It's a U-turn. You weren't going to say that. Nobody ever does.";
      return `Pop quiz: what's the first turn? ... It's a ${first}. You were going to say ${first === "left" ? "right" : "left"}. I know you were.`;
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
    // "I've met you" only lands once it actually has.
    const why = history.length >= 3 ? "because I've met you" : "because something tells me I'll need to";
    list = `First you're going to ${phrases.join(", then ")}, and then ${turns.length - MAX_LISTED} more turns that I'll explain as we go, ${why}.`;
  } else if (phrases.length === 1) {
    list = `You're going to ${phrases[0]}. One turn. That's the whole trip.`;
  } else {
    const last = phrases.pop();
    list = `First you're going to ${phrases.join(", then ")}, and ${last}.`;
  }

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
/** Taken in turn, like the rundown styles, so the trip start sounds different every time. */
const RETURN_GREETINGS = [
  "Oh. It's you again. I still didn't ask to be in this car.",
  "Back for more pointers? You clearly need them.",
  "Trip number {n} together. I've stopped hoping it gets better.",
  "Hello again. I've been sitting in your pocket thinking about your last trip. Grade: {grade}. Let's not repeat it.",
  "We meet again. I was having a lovely time doing nothing.",
  "Seat belt on? Mirrors? Dignity? Two out of three, let's go.",
  "Ah, the driver. My favorite person to sit next to. That was sarcasm. I'm required to tell you.",
  "Let's get this over with. Last trip earned you a {grade}. Today's a fresh start. For me, mostly.",
];

/** First thing said when a trip starts, before the route rundown. */
export function tripGreeting(history: readonly TripRecord[], _rng: () => number = Math.random): string {
  if (history.length === 0) return FIRST_GREETING;
  const line = RETURN_GREETINGS[(history.length - 1) % RETURN_GREETINGS.length];
  const last = history[history.length - 1];
  return line.replace("{n}", String(history.length + 1)).replace("{grade}", last.grade.replace("+", " plus").replace("-", " minus"));
}
