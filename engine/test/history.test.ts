import { test } from "node:test";
import assert from "node:assert/strict";
import { CritiqueEngine, seededRng } from "../src/engine.ts";
import { predictTrip, recordTrip, routeKey, type TripPlan, type TripRecord } from "../src/history.ts";

const home = { lat: 39.7392, lon: -104.9903 };
const work = { lat: 39.7525, lon: -104.9995 };
const plan: TripPlan = { origin: home, destination: work, destinationName: "work", expectedMinutes: 10 };
const rec = (over: Partial<TripRecord>): TripRecord => ({
  routeKey: routeKey(home, work),
  destination: "work",
  endedAt: 0,
  expectedMinutes: 10,
  actualMinutes: 10,
  speedingShare: 0,
  missedTurns: 0,
  hardBrakes: 0,
  grade: "C",
  ...over,
});

test("no history: admits it has nothing on you yet", () => {
  const p = predictTrip([], plan, seededRng(1));
  assert.equal(p.habit, "unknown");
  assert.equal(p.predictedMinutes, 10);
});

test("lead foot: predicts the trip will be faster than the estimate", () => {
  const history = [rec({ actualMinutes: 8 }), rec({ actualMinutes: 8.2 })];
  const p = predictTrip(history, plan, () => 0);
  assert.equal(p.habit, "leadFoot");
  assert.equal(p.predictedMinutes, 8);
  assert.equal(
    p.text.split(". You'd")[0].split(" This is")[0],
    "This route should take 10 minutes, but knowing you it'll probably take 8 with your lead foot. I'm just glad I don't have eyes.",
  );
});

test("slow drivers get a longer prediction", () => {
  const p = predictTrip([rec({ actualMinutes: 14 })], plan, () => 0);
  assert.equal(p.habit, "slowpoke");
  assert.equal(p.predictedMinutes, 14);
});

test("same route counts more than other trips", () => {
  const elsewhere = { lat: 40.0, lon: -105.2 };
  const history = [
    rec({ actualMinutes: 8 }),
    rec({ routeKey: routeKey(home, elsewhere), actualMinutes: 13 }),
    rec({ routeKey: routeKey(home, elsewhere), actualMinutes: 13 }),
  ];
  assert.equal(predictTrip(history, plan, () => 0).habit, "leadFoot");
});

test("parking a block away still counts as the same route", () => {
  assert.equal(routeKey(home, work), routeKey({ lat: 39.7395, lon: -104.9899 }, { lat: 39.7522, lon: -104.9998 }));
});

test("brings up the turns you missed last time on this route", () => {
  const p = predictTrip([rec({ actualMinutes: 8, missedTurns: 2 })], plan, () => 0);
  assert.match(p.text, /missed 2 turns on this exact route/);
});

test("regulars get mocked for needing directions at all", () => {
  const p = predictTrip([rec({ actualMinutes: 8 }), rec({ actualMinutes: 8 })], plan, () => 0);
  assert.match(p.text, /your third trip to work/);
});

test("a finished trip becomes a record", () => {
  const e = new CritiqueEngine({ rng: seededRng(1) }, 0);
  e.onNav({ type: "missedTurn", t: 60_000 });
  e.onNav({ type: "arrived", t: 480_000 });
  const r = recordTrip(e, plan);
  assert.equal(r.actualMinutes, 8);
  assert.equal(r.missedTurns, 1);
  assert.equal(r.routeKey, routeKey(home, work));
});
