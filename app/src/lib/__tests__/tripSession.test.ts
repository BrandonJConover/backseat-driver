import { test } from "node:test";
import assert from "node:assert/strict";
import type { Commentary } from "@backseat/engine";
import { TripSession, type SdkTurnByTurn } from "../tripSession.ts";

function session(opts: { now?: () => number } = {}) {
  const said: Commentary[] = [];
  let finished: unknown;
  const s = new TripSession(
    { name: "Work", lat: 39.75, lng: -104.99 },
    { speak: (l) => said.push(...l), onFinished: (r) => (finished = r), now: opts.now, engine: { rng: () => 0 } },
  );
  return { s, said, finished: () => finished };
}

const step = (n: number, instruction: string, maneuver: number) => ({ stepNumber: n, instruction, maneuver });
const tbt = (current: ReturnType<typeof step>, distance: number, rest: ReturnType<typeof step>[] = []): SdkTurnByTurn => ({
  navState: 1,
  routeChanged: false,
  distanceToCurrentStepMeters: distance,
  distanceToFinalDestinationMeters: 3000,
  timeToFinalDestinationSeconds: 600,
  currentStep: current,
  getRemainingSteps: rest,
});

test("trip start: greeting, then route rundown on the first turn-by-turn update", () => {
  const { s, said } = session();
  assert.match(said[0].text, /didn't ask to be in this car/);
  s.onLocation({ lat: 39.74, lng: -104.99, speed: 0, time: Date.now() });
  s.onTurnByTurn(tbt(step(0, "Turn left onto Main St", 6), 300, [step(1, "Turn left onto Oak", 6), step(2, "Turn right onto Pine", 7)]));
  const texts = said.map((c) => c.text);
  assert.ok(texts.some((t) => /First you're going to turn left, then left again, and right\./.test(t)), texts.join("\n"));
  assert.ok(texts.some((t) => /In 1000 feet, turn left onto Main St\./.test(t)));
});

test("step changes become completed turns; off-route at the turn is a missed turn", () => {
  const { s } = session();
  s.onTurnByTurn(tbt(step(0, "Turn left onto Main St", 6), 300));
  s.onTurnByTurn(tbt(step(1, "Turn right onto Oak", 7), 400));
  assert.equal(s.engine.stats.turnsCompleted, 1);
  s.onTurnByTurn(tbt(step(1, "Turn right onto Oak", 7), 40));
  s.onOffRoute();
  assert.equal(s.engine.stats.missedTurns, 1);
  assert.equal(s.engine.stats.reroutes, 1);
  s.onTurnByTurn(tbt(step(0, "Make a U-turn", 14), 200));
  assert.equal(s.engine.stats.turnsCompleted, 1, "the reroute's new step isn't a completed turn");
});

test("parked away from the destination, left the phone, came back", () => {
  let t = 1_000_000;
  const { s, said } = session({ now: () => t });
  s.onTurnByTurn(tbt(step(0, "Turn left onto Main St", 6), 300));
  for (let i = 0; i < 130; i++, t += 1000) s.onLocation({ lat: 39.74, lng: -104.99, speed: 0, time: t });
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      assert.ok(said.some((c) => c.category === "unplannedStop"));
      for (let i = 0; i < 4; i++, t += 1000) s.onLocation({ lat: 39.74, lng: -104.99, speed: 10, time: t });
      assert.ok(said.some((c) => c.category === "abandoned" && /left me in the car/i.test(c.text)), said.map((c) => c.text).join("\n"));
      resolve();
    }, 0),
  );
});

test("arrival produces the report and the trip record", () => {
  const { s, finished } = session();
  s.onLocation({ lat: 39.74, lng: -104.99, speed: 0, time: Date.now() });
  s.onTurnByTurn(tbt(step(0, "Turn left onto Main St", 6), 300));
  s.onArrival(true);
  const r = finished() as { report: { overall: { letter: string } }; record: { destination: string } };
  assert.equal(r.record.destination, "Work");
  assert.ok(r.report.overall.letter);
});
