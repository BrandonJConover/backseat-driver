import { test } from "node:test";
import assert from "node:assert/strict";
import { routeRundown } from "../src/rundown.ts";
import type { TripRecord } from "../src/history.ts";

const steps = (...texts: string[]) => texts.map((text) => ({ text }));

test("Brandon's example route", () => {
  const text = routeRundown(
    steps("Turn left onto Main", "Turn left onto Oak", "Turn right onto Pine", "Continue straight", "Turn left onto Elm", "Turn left onto 2nd Ave"),
    [],
    () => 0,
  );
  assert.equal(
    text,
    "Okay, here's the plan. First you're going to turn left, then left again, then right, then left, and left again. Once you've done all that, you'll have made it to your destination. It's all so simple. You got it?",
  );
});

test("three in a row gets a 'yes, again'", () => {
  assert.match(routeRundown(steps("Turn right", "Turn right", "Turn right"), [], () => 0), /turn right, then right again, and yes, right again\./);
});

test("long routes get cut short, insultingly", () => {
  const many = steps(...Array.from({ length: 10 }, (_, i) => (i % 2 ? "Turn left" : "Turn right")));
  assert.match(routeRundown(many, [], () => 0), /and then 3 more turns that I'll explain as we go, because I've met you\./);
});

test("one turn and no turns", () => {
  assert.match(routeRundown(steps("Turn left onto Elm"), [], () => 0), /You're going to turn left\. One turn\. That's the whole trip\. It's all/);
  assert.match(routeRundown(steps("Head north", "Continue straight"), [], () => 0), /straight line/);
});

test("drivers who missed turns recently get a left/right reminder", () => {
  const history = [{ missedTurns: 2 } as TripRecord];
  assert.match(routeRundown(steps("Turn left", "Turn right"), history, () => 0), /hand that makes an L/);
});

test("first trip ever opens with Brandon's line", async () => {
  const { tripGreeting } = await import("../src/rundown.ts");
  assert.equal(tripGreeting([]), "Just so you know, I didn't ask to be in this car. But I guess since I'm here, I might as well give you a few pointers.");
  const back = tripGreeting([{ grade: "D" } as TripRecord], () => 0.99);
  assert.match(back, /Grade: D\./);
});
