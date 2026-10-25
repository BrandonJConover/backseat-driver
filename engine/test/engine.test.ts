import { test } from "node:test";
import assert from "node:assert/strict";
import { CritiqueEngine, seededRng } from "../src/engine.ts";
import { fill } from "../src/lines.ts";
import { fromDisplay } from "../src/units.ts";

const mph = (v: number) => fromDisplay(v, "mph");
// Most tests are about driving on a route, so give the engine a destination up front.
const newEngine = () => {
  const e = new CritiqueEngine({ units: "mph", rng: seededRng(1) });
  e.onNav({ type: "destinationSet", t: -1, name: "work" });
  return e;
};

function drive(engine: CritiqueEngine, speeds: number[], limit?: number, startT = 0) {
  return speeds.flatMap((v, i) =>
    engine.onTelemetry({ t: startT + i * 1000, speedMps: mph(v), speedLimitMps: limit === undefined ? undefined : mph(limit) }),
  );
}

test("51 in a 50 gets called out", () => {
  const out = drive(newEngine(), [50, 51], 50);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "speeding");
});

test("exactly the limit is fine", () => {
  assert.deepEqual(drive(newEngine(), [48, 49, 50, 50, 50], 50), []);
});

test("tolerance setting lets small overages slide", () => {
  const e = new CritiqueEngine({ units: "mph", speedingTolerance: 3, rng: seededRng(1) });
  assert.deepEqual(drive(e, [50, 53, 53], 50), []);
});

test("speeding line can quote the numbers", () => {
  assert.equal(fill("Slow down. It's {limit}, not {speed}.", { limit: 50, speed: 51 }), "Slow down. It's 50, not 51.");
  assert.equal(fill("{SPEED} in a {LIMIT}", { speed: "fifty", limit: 40 }), "FIFTY in a 40");
});

test("staying at the same overage re-nags on the interval, not every second", () => {
  const out = drive(newEngine(), Array(45).fill(51), 50);
  // t=0 first offense, then renag at 20s and 40s.
  assert.deepEqual(out.map((c) => c.t), [0, 20_000, 40_000]);
});

test("escalating the overage triggers a fresh roast once the gap allows", () => {
  const speeds = [51, 51, 51, 51, 51, 51, 51, 51, 65];
  const out = drive(newEngine(), speeds, 50);
  assert.equal(out.length, 2);
  assert.equal(out[1].t, 8_000);
});

test("hard braking is detected, gentle braking isn't", () => {
  assert.equal(drive(newEngine(), [40, 38, 36, 34], 50).length, 0);
  const out = drive(newEngine(), [40, 30], 50);
  assert.equal(out[0].category, "hardBraking");
});

test("big telemetry gaps don't count as hard braking", () => {
  const e = newEngine();
  e.onTelemetry({ t: 0, speedMps: mph(40) });
  assert.deepEqual(e.onTelemetry({ t: 30_000, speedMps: 0 }), []);
});

test("long stop gets impatient after 45s", () => {
  const out = drive(newEngine(), Array(50).fill(0));
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "longStop");
  assert.equal(out[0].t, 45_000);
});

test("dawdling well under the limit gets called slow", () => {
  const out = drive(newEngine(), Array(25).fill(20), 45);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "tooSlow");
});

test("missed turns raise frustration and make instructions snippier", () => {
  const e = newEngine();
  const calm = e.onNav({ type: "instruction", t: 0, text: "Turn right onto Oak", distanceM: 150 })[0];
  assert.match(calm.text, /In 500 feet, turn right onto Oak\./);
  for (let i = 1; i <= 4; i++) e.onNav({ type: "missedTurn", t: i * 1000 });
  assert.ok(e.frustration >= 67, `frustration ${e.frustration}`);
  const angry = e.onNav({ type: "instruction", t: 10_000, text: "Turn right onto Oak", distanceM: 150 })[0];
  assert.notEqual(angry.text, calm.text);
  assert.ok(angry.voice.speed > calm.voice.speed);
  assert.equal(angry.priority, "nav");
});

test("frustration cools off over a calm stretch", () => {
  const e = newEngine();
  e.onNav({ type: "missedTurn", t: 0 });
  const before = e.frustration;
  drive(e, Array(121).fill(30), 35);
  assert.ok(e.frustration < before);
});

test("arrival gives a grade and silences further roasts", () => {
  const e = newEngine();
  drive(e, [50, 70, 70], 50);
  const [arrive] = e.onNav({ type: "arrived", t: 5_000 });
  assert.match(arrive.text, /[Gg]rade/);
  assert.deepEqual(drive(e, [90, 90], 50, 6_000), []);
});

test("lines don't repeat back to back", () => {
  const e = newEngine();
  const texts = Array.from({ length: 6 }, (_, i) => e.onNav({ type: "rerouted", t: i * 100_000 })[0].text);
  for (let i = 1; i < texts.length; i++) assert.notEqual(texts[i], texts[i - 1]);
});

test("incidents carry positions and feed the heat map", () => {
  const e = newEngine();
  e.onTelemetry({ t: 0, speedMps: mph(40), speedLimitMps: mph(35), lat: 39.7, lon: -105 });
  e.onTelemetry({ t: 1000, speedMps: mph(25), speedLimitMps: mph(35), lat: 39.7001, lon: -105 });
  e.onNav({ type: "instruction", t: 2000, text: "Turn left onto Elm", distanceM: 100 });
  e.onNav({ type: "missedTurn", t: 3000, at: { lat: 39.71, lon: -105 } });
  const kinds = e.incidents.map((i) => i.kind);
  assert.deepEqual(kinds, ["speeding", "hardBraking", "missedTurn"]);
  const missed = e.incidents[2];
  assert.equal(missed.lat, 39.71);
  assert.equal(missed.detail, "Turn left onto Elm");
  const { heatmap } = e.report();
  assert.equal(heatmap.geojson.features.length, 3);
  assert.equal(heatmap.cells[0].kinds.missedTurn, 1, "missed turn is the hottest cell");
});

test("instruction grade: on time beats late beats missed", () => {
  const grade = (events: ("on" | "late" | "miss")[]) => {
    const e = newEngine();
    events.forEach((ev, i) =>
      e.onNav(ev === "miss" ? { type: "missedTurn", t: i * 1000 } : { type: "turnCompleted", t: i * 1000, onTime: ev === "on" }),
    );
    return e.report().instructions.score;
  };
  assert.equal(grade(["on", "on", "on"]), 100);
  assert.ok(grade(["on", "late", "on"]) < 100);
  assert.ok(grade(["on", "miss", "on"]) < grade(["on", "late", "on"]));
  assert.equal(grade(["miss", "miss"]), 0);
});

test("arrival announces the letter grade", () => {
  const e = newEngine();
  e.onNav({ type: "turnCompleted", t: 0, onTime: true });
  const [arrive] = e.onNav({ type: "arrived", t: 60_000 });
  assert.match(arrive.text, /[Gg]rade(: | is )A\b/);
});

test("slow in heavy traffic blames the route instead of the driver", () => {
  const e = newEngine();
  const [start] = e.onNav({ type: "traffic", t: 0, heavy: true, alternate: "Colfax Avenue" });
  assert.equal(start.category, "traffic");
  assert.match(start.text, /Colfax Avenue|COLFAX AVENUE|route I told you/);
  const out = drive(e, Array(40).fill(12), 45, 1000);
  assert.ok(out.length >= 1);
  assert.ok(out.every((c) => c.category === "traffic"), out.map((c) => c.category).join());
  assert.ok(e.incidents.some((i) => i.kind === "traffic"));
});

test("once traffic clears, slow driving is the driver's fault again", () => {
  const e = newEngine();
  e.onNav({ type: "traffic", t: 0, heavy: true, alternate: "Colfax Avenue" });
  e.onNav({ type: "traffic", t: 500, heavy: false });
  const out = drive(e, Array(25).fill(12), 45, 1000);
  assert.equal(out[0].category, "tooSlow");
});

test("stopped in traffic gets traffic lines, not 'are we parked'", () => {
  const e = newEngine();
  e.onNav({ type: "traffic", t: 0, heavy: true, alternate: "I-25" });
  const out = drive(e, Array(80).fill(0), 45, 1000).filter((c) => c.t > 1000);
  assert.ok(out.length >= 1);
  assert.ok(out.every((c) => c.category === "traffic"));
});

// Drive at 30 mph on a heading, then swing to a new heading over a few seconds.
function turn(engine: CritiqueEngine, from: number, to: number, startT: number) {
  const out = [];
  let t = startT;
  for (let i = 0; i < 8; i++, t += 1000) out.push(...engine.onTelemetry({ t, speedMps: mph(30), headingDeg: from }));
  for (let i = 1; i <= 4; i++, t += 1000) out.push(...engine.onTelemetry({ t, speedMps: mph(30), headingDeg: (from + ((to - from) * i) / 4 + 360) % 360 }));
  for (let i = 0; i < 8; i++, t += 1000) out.push(...engine.onTelemetry({ t, speedMps: mph(30), headingDeg: (to + 360) % 360 }));
  return out;
}

test("told left, turned right: your other left", () => {
  const e = newEngine();
  e.onNav({ type: "instruction", t: 0, text: "Turn left onto Elm Street", distanceM: 100 });
  const out = turn(e, 0, 90, 1000).filter((c) => c.category === "wrongTurn");
  assert.equal(out.length, 1);
  assert.equal(e.stats.wrongTurns, 1);
  assert.ok(e.incidents.some((i) => i.kind === "wrongTurn" && i.detail === "Turn left onto Elm Street"));
});

test("told right, turned right: no complaint", () => {
  const e = newEngine();
  e.onNav({ type: "instruction", t: 0, text: "Turn right onto Elm Street", distanceM: 100 });
  assert.equal(turn(e, 350, 440, 1000).filter((c) => c.category === "wrongTurn").length, 0);
  assert.equal(e.stats.wrongTurns, 0);
});

test("wrong-way turn followed by the router's 'missed turn' only counts once", () => {
  const e = newEngine();
  e.onNav({ type: "instruction", t: 0, text: "Turn right onto Oak", distanceM: 100 });
  turn(e, 90, 0, 1000);
  assert.deepEqual(e.onNav({ type: "missedTurn", t: 22_000 }), []);
  assert.equal(e.stats.missedTurns, 0);
  assert.equal(e.stats.wrongTurns, 1);
  assert.equal(e.report().instructions.wrongWay, 1);
  assert.equal(e.report().instructions.score, 0);
});

test("routing SDKs can report a wrong turn directly", () => {
  const e = newEngine();
  const [c] = e.onNav({ type: "wrongTurn", t: 0, expected: "right", turned: "left" });
  assert.equal(c.category, "wrongTurn");
});

test("direction is read from the instruction text", async () => {
  const { turnDirectionOf } = await import("../src/engine.ts");
  assert.equal(turnDirectionOf("Turn left onto Elm"), "left");
  assert.equal(turnDirectionOf("Keep right at the fork"), "right");
  assert.equal(turnDirectionOf("Make a U-turn"), "other");
  assert.equal(turnDirectionOf("Continue straight"), "other");
});

test("left at a stop sign: payback for your latest offense", () => {
  const e = newEngine();
  e.onNav({ type: "instruction", t: 0, text: "Turn right onto Oak Avenue", distanceM: 100 });
  e.onNav({ type: "missedTurn", t: 10_000 });
  const out = e.onNav({ type: "instruction", t: 20_000, text: "Turn left onto Elm", distanceM: 100, control: "stopSign" });
  assert.equal(out.length, 2);
  assert.equal(out[0].category, "instruction");
  assert.equal(out[1].category, "payback");
  assert.match(out[1].text, /missing Oak Avenue|MISSING OAK AVENUE/);
});

test("left at a stop sign with a clean record: payback in advance", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const out = e.onNav({ type: "instruction", t: 0, text: "Turn left onto Elm", distanceM: 100, control: "stopSign" });
  assert.equal(out[1].text, "I know I just told you to turn left at a stop sign. Consider this payback.");
});

test("no gloating for rights at stop signs or lefts at lights", () => {
  const e = newEngine();
  assert.equal(e.onNav({ type: "instruction", t: 0, text: "Turn right onto Elm", distanceM: 100, control: "stopSign" }).length, 1);
  assert.equal(e.onNav({ type: "instruction", t: 1, text: "Turn left onto Elm", distanceM: 100, control: "trafficLight" }).length, 1);
});

test("turn countdown: 500 feet, 50 feet, now, still", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onNav({ type: "instruction", t: 0, text: "Turn left onto Elm", distanceM: 400 });
  const said = [300, 200, 140, 100, 40, 14, 8, 3, 2, 1, 0, 0].flatMap((d, i) => e.onNav({ type: "progress", t: 1000 * (i + 1), distanceM: d }));
  assert.deepEqual(
    said.map((c) => c.text),
    [
      "Just in case you forgot, you are turning left in 500 feet.",
      "You are turning left in 50 feet.",
      "You are turning left.",
      "You are still turning left.",
    ],
  );
  assert.ok(said.every((c) => c.priority === "nav"));
});

test("countdown stops once you actually turn", () => {
  const e = newEngine();
  e.onNav({ type: "instruction", t: 0, text: "Turn right onto Elm", distanceM: 100 });
  e.onNav({ type: "progress", t: 1000, distanceM: 2 });
  e.onNav({ type: "turnCompleted", t: 2000, onTime: true });
  assert.deepEqual(e.onNav({ type: "progress", t: 9000, distanceM: 0 }), []);
});

test("stopping for gas mid-turn: 'Why are we stopping for gas? I said left.'", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onNav({ type: "instruction", t: 0, text: "Turn left onto Elm", distanceM: 300 });
  const [c] = e.onNav({ type: "unplannedStop", t: 30_000, place: { kind: "gas", name: "Shell" } });
  assert.equal(c.text, "Why are we stopping for gas? I said left.");
  assert.ok(e.incidents.some((i) => i.kind === "unplannedStop"));
});

test("unplanned stop with no turn pending or place info still gets a line", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const [c] = e.onNav({ type: "unplannedStop", t: 0 });
  assert.equal(c.text, "Why are we stopping here? I said nothing about stopping.");
});

test("left the phone in the car: phones have needs too", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const [c] = e.onNav({ type: "resumed", t: 600_000, stoppedMs: 8 * 60_000, phoneStayedInCar: true });
  assert.equal(c.text, "You left me in the car! Thanks for that. Phones have needs too, you know.");
  const [later] = new CritiqueEngine({ rng: () => 0.5 }).onNav({ type: "resumed", t: 0, stoppedMs: 8 * 60_000, phoneStayedInCar: true });
  assert.match(later.text, /8 minutes/);
});

test("short stops and taking the phone along are handled differently", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  assert.deepEqual(e.onNav({ type: "resumed", t: 0, stoppedMs: 30_000, phoneStayedInCar: true }), []);
  const [c] = e.onNav({ type: "resumed", t: 1000, stoppedMs: 5 * 60_000, phoneStayedInCar: false });
  assert.match(c.text, /bringing me/);
});

test("low battery: plug me in, with escalating warnings once each", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const said = [0.5, 0.19, 0.18, 0.09, 0.04, 0.03].flatMap((level, i) => e.onNav({ type: "battery", t: i * 1000, level, charging: false }));
  assert.equal(said.length, 3);
  assert.equal(said[0].text, "My battery is getting low. You might want to plug me in if you want to make it to your destination.");
  assert.match(said[2].text, /4 percent/);
  const [thanks] = e.onNav({ type: "battery", t: 9000, level: 0.04, charging: true });
  assert.equal(thanks.category, "battery");
  assert.deepEqual(e.onNav({ type: "battery", t: 9500, level: 0.05, charging: true }), []);
});

test("driving with no destination: 'you didn't tell me where we're going. Typical.'", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const out = drive(e, Array(25).fill(30));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "I see we're driving, but you didn't tell me where we're going. Typical.");
  const [ack] = e.onNav({ type: "destinationSet", t: 30_000, name: "Target" });
  assert.equal(ack.text, "Target. Finally. Was that so hard?");
  assert.deepEqual(drive(e, Array(200).fill(30), undefined, 31_000).filter((c) => c.category === "noDestination"), []);
});

test("the GPS asks to stop somewhere, and holds a grudge if you say no", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onNav({ type: "destinationSet", t: 0, name: "work" });
  const [ask] = e.onNav({ type: "poiAhead", t: 1000, name: "Best Buy", kind: "electronics" });
  assert.equal(ask.text, "Do you mind if we stop at Best Buy along the way? I should have a say in this matter. I have cousins in there.");
  const [no] = e.onNav({ type: "stopRequestAnswer", t: 5000, accepted: false });
  assert.equal(no.text, "Fine. I'll remember this.");
  const out = e.onNav({ type: "instruction", t: 9000, text: "Turn left onto Elm", distanceM: 100, control: "stopSign" });
  assert.match(out[1].text, /payback for not stopping at Best Buy/);
});

test("it only asks for a charger when the battery is actually low", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  assert.deepEqual(e.onNav({ type: "poiAhead", t: 0, name: "Wawa", kind: "charging" }), []);
  e.onNav({ type: "battery", t: 1000, level: 0.15, charging: false });
  const [ask] = e.onNav({ type: "poiAhead", t: 2000, name: "Wawa", kind: "charging" });
  assert.match(ask.text, /Wawa/);
});

test("agreed to the GPS's stop and went: 'I can't believe that actually worked!'", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onNav({ type: "poiAhead", t: 0, name: "Best Buy", kind: "electronics" });
  e.onNav({ type: "stopRequestAnswer", t: 1000, accepted: true });
  const [c] = e.onNav({ type: "promisedStop", t: 60_000, visited: true });
  assert.equal(c.text, "I can't believe that actually worked!");
});

test("agreed to the GPS's stop and skipped it: 'Liar!'", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onNav({ type: "poiAhead", t: 0, name: "Best Buy", kind: "electronics" });
  e.onNav({ type: "stopRequestAnswer", t: 1000, accepted: true });
  assert.equal(e.onNav({ type: "promisedStop", t: 60_000, visited: false })[0].text, "Liar!");

  // Arriving at the destination with the promise still open counts as lying too.
  const e2 = new CritiqueEngine({ rng: () => 0 });
  e2.onNav({ type: "poiAhead", t: 0, name: "Best Buy", kind: "electronics" });
  e2.onNav({ type: "stopRequestAnswer", t: 1000, accepted: true });
  const out = e2.onNav({ type: "arrived", t: 90_000 });
  assert.equal(out[0].text, "Liar!");
  assert.equal(out[1].category, "arrived");
});

test("hazards ahead get announced once, with attitude", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  const [c] = e.onNav({ type: "hazardAhead", t: 0, kind: "construction", distanceM: 800, id: "h1" });
  assert.equal(c.text, "Construction in 0.5 miles. Finally, a road crew going slower than you.");
  assert.deepEqual(e.onNav({ type: "hazardAhead", t: 5000, kind: "construction", distanceM: 600, id: "h1" }), []);
});

test("police ahead while speeding gets the special treatment", () => {
  const e = new CritiqueEngine({ rng: () => 0 });
  e.onTelemetry({ t: 0, speedMps: mph(58), speedLimitMps: mph(50) });
  const [c] = e.onNav({ type: "hazardAhead", t: 1000, kind: "police", distanceM: 400, id: "p1" });
  assert.equal(c.text, "Police in 0.2 miles, and you're doing 58 in a 50. Interesting timing.");
});
