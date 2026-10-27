import { test } from "node:test";
import assert from "node:assert/strict";
import { routeRundown } from "../src/rundown.ts";
import type { TripRecord } from "../src/history.ts";

const steps = (...texts: string[]) => texts.map((text) => ({ text }));
/** One trip behind them: the classic rundown. */
const back = [{ missedTurns: 0, grade: "B" } as TripRecord];

test("Brandon's example route", () => {
  const text = routeRundown(
    steps("Turn left onto Main", "Turn left onto Oak", "Turn right onto Pine", "Continue straight", "Turn left onto Elm", "Turn left onto 2nd Ave"),
    back,
    () => 0,
  );
  assert.equal(
    text,
    "Okay, here's the plan. First you're going to turn left, then left again, then right, then left, and left again. Once you've done all that, you'll have made it to your destination. It's all so simple. You got it?",
  );
});

test("three in a row gets a 'yes, again'", () => {
  assert.match(routeRundown(steps("Turn right", "Turn right", "Turn right"), back, () => 0), /turn right, then right again, and yes, right again\./);
});

test("long routes get cut short, insultingly", () => {
  const many = steps(...Array.from({ length: 10 }, (_, i) => (i % 2 ? "Turn left" : "Turn right")));
  assert.match(routeRundown(many, back, () => 0), /and then 3 more turns that I'll explain as we go, because something tells me I'll need to\./);
  const regular = Array.from({ length: 6 }, () => ({ missedTurns: 0, grade: "B" }) as TripRecord);  // classic style again
  assert.match(routeRundown(many, [...regular, ...back], () => 0), /because I've met you\./);
});

test("one turn and no turns", () => {
  assert.match(routeRundown(steps("Turn left onto Elm"), back, () => 0), /You're going to turn left\. One turn\. That's the whole trip\. It's all/);
  assert.match(routeRundown(steps("Head north", "Continue straight"), back, () => 0), /straight line/);
});

test("drivers who missed turns recently get a left/right reminder", () => {
  const history = [{ missedTurns: 2 } as TripRecord];
  assert.match(routeRundown(steps("Turn left", "Turn right"), history, () => 0), /hand that makes an L/);
});

test("first trip ever opens with Brandon's line", async () => {
  const { tripGreeting } = await import("../src/rundown.ts");
  assert.equal(tripGreeting([]), "Just so you know, I didn't ask to be in this car. But I guess since I'm here, I might as well give you a few pointers.");
  const back = tripGreeting(Array.from({ length: 4 }, () => ({ grade: "D" }) as TripRecord));
  assert.match(back, /Grade: D\./);
});

test("first trip ever rattles off every turn and asks for music", () => {
  assert.equal(
    routeRundown(steps("Turn left", "Turn left", "Turn right", "Make a U-turn"), [], () => 0),
    "Okay, real quick. Left, left, right, U-turn. See? Easy. Even you can't mess that up. Now that we got the directions out of the way, why don't we put on some music.",
  );
});

test("the rundown changes style from trip to trip", () => {
  const route = steps("Turn left", "Turn right", "Turn left");
  const trips = (n: number) => Array.from({ length: n }, () => ({ missedTurns: 0, grade: "B" }) as TripRecord);
  const said = [1, 2, 3, 4, 5, 6].map((n) => routeRundown(route, trips(n), () => 0));
  assert.equal(new Set(said).size, 6);
  assert.match(said[1], /^First turn's a left\./);
  assert.match(said[2], /^3 turns today\./);
  assert.match(said[4], /^2 lefts and 1 right today\./);
  assert.match(said[5], /You were going to say right\./);
});

test("greetings don't repeat trip to trip", async () => {
  const { tripGreeting } = await import("../src/rundown.ts");
  const trips = (n: number) => Array.from({ length: n }, () => ({ grade: "B" }) as TripRecord);
  const said = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => tripGreeting(trips(n)));
  assert.equal(new Set(said).size, 8);
});
