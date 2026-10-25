// Records randomized drives through the TypeScript engine: every input event and every line it
// said. The C++ port replays the file and must say exactly the same things (parity test).
//   node core/tools/record-trace.ts ../backseat-driver-comaps/libs/backseat/backseat_tests/parity_trace.txt
import { writeFileSync } from "node:fs";
import { CritiqueEngine, seededRng } from "../../engine/src/engine.ts";
import { predictTrip, recordTrip, routeKey, type TripRecord } from "../../engine/src/history.ts";
import { routeRundown, tripGreeting, type RouteStep } from "../../engine/src/rundown.ts";
import type { Commentary, HazardKind, NavEvent, PlaceKind, StopWish, TelemetrySample } from "../../engine/src/types.ts";

const SCENARIOS = 30;
const lines: string[] = [];
const opt = (v: unknown) => (v === undefined ? "-" : String(v));

const TEXTS = [
  "Turn left onto Elm Street", "Turn right onto Oak Avenue", "Keep left at the fork", "Make a U-turn",
  "Continue straight on Main Street", "Turn slight right at 5th Avenue", "Head north on Pine Road", "Turn left",
];
const HAZARDS: HazardKind[] = ["police", "construction", "debris", "crash", "stalledCar"];
const WISHES: StopWish[] = ["electronics", "carWash", "charging", "other"];
const PLACES: PlaceKind[] = ["gas", "food", "coffee", "store", "other"];
const NAMES = ["Best Buy", "Sparkle Car Wash", "the Supercharger", "Grandma's"];

function encodeNav(e: NavEvent): string {
  switch (e.type) {
    case "instruction": return ["I", e.t, e.text, e.distanceM, opt(e.maneuver), opt(e.control)].join("\t");
    case "turnCompleted": return ["C", e.t, e.onTime ? 1 : 0].join("\t");
    case "progress": return ["P", e.t, e.distanceM].join("\t");
    case "missedTurn": return ["M", e.t].join("\t");
    case "wrongTurn": return ["W", e.t, e.expected, e.turned].join("\t");
    case "rerouted": return ["R", e.t].join("\t");
    case "hazardAhead": return ["H", e.t, e.kind, e.distanceM, opt(e.id)].join("\t");
    case "poiAhead": return ["O", e.t, e.name, e.kind].join("\t");
    case "stopRequestAnswer": return ["A", e.t, e.accepted ? 1 : 0].join("\t");
    case "promisedStop": return ["S", e.t, e.visited ? 1 : 0].join("\t");
    case "destinationSet": return ["D", e.t, e.name].join("\t");
    case "battery": return ["B", e.t, e.level, e.charging ? 1 : 0].join("\t");
    case "resumed": return ["U", e.t, e.stoppedMs, e.phoneStayedInCar ? 1 : 0].join("\t");
    case "unplannedStop": return ["X", e.t, opt(e.place?.kind), opt(e.place?.name)].join("\t");
    case "traffic": return ["F", e.t, e.heavy ? 1 : 0, opt(e.alternate)].join("\t");
    case "arrived": return ["Z", e.t].join("\t");
  }
}

const say = (cs: Commentary[]) => {
  for (const c of cs) lines.push([">", c.category, c.priority, c.frustration, c.voice.speed, c.text].join("\t"));
};

for (let seed = 1; seed <= SCENARIOS; seed++) {
  const units = seed % 4 === 0 ? "kmh" : "mph";
  const engine = new CritiqueEngine({ units, rng: seededRng(seed) }, 0);
  const r = seededRng(seed * 7919); // drives the scenario, separate from the engine's RNG
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  lines.push(["E", seed, units].join("\t"));

  let t = 0, speed = 0, heading = 0, limit: number | undefined = 22, lat = 39.7 + seed / 100, lon = -105;
  let toTurn = 0;
  const steps = 250 + Math.floor(r() * 250);
  for (let i = 0; i < steps; i++) {
    t += r() < 0.03 ? 0 : r() < 0.02 ? 30_000 : 1000; // occasional duplicate stamp or a tunnel gap
    const roll = r();
    if (roll < 0.08) speed = Math.max(0, speed - 4 - r() * 6); // hard brake
    else if (roll < 0.14) speed += 3 + r() * 3; // jackrabbit
    else if (roll < 0.2) speed = 0;
    else speed = Math.max(0, speed + (r() - 0.45) * 2);
    if (r() < 0.02) limit = r() < 0.2 ? undefined : pick([11.2, 13.4, 15.6, 20.1, 22.4, 26.8, 29.1]);
    if (r() < 0.04) heading = (heading + (r() < 0.5 ? 90 : 270)) % 360;
    else heading = (heading + (r() - 0.5) * 6 + 360) % 360;
    lat += (speed * Math.cos((heading * Math.PI) / 180)) / 111_320;
    lon += (speed * Math.sin((heading * Math.PI) / 180)) / 85_000;
    const s: TelemetrySample = { t, speedMps: +speed.toFixed(3), speedLimitMps: limit, lat: +lat.toFixed(6), lon: +lon.toFixed(6), headingDeg: r() < 0.1 ? undefined : +heading.toFixed(2) };
    lines.push(["T", s.t, s.speedMps, opt(s.speedLimitMps), opt(s.lat), opt(s.lon), opt(s.headingDeg)].join("\t"));
    say(engine.onTelemetry(s));

    // Navigation events, roughly how a routing layer would send them.
    const events: NavEvent[] = [];
    if (toTurn > 0) {
      toTurn = Math.max(0, toTurn - speed - r() * 5);
      events.push({ type: "progress", t, distanceM: +toTurn.toFixed(1) });
    }
    const n = r();
    if (n < 0.02) {
      toTurn = 20 + r() * 600;
      const m = r();
      events.push({ type: "instruction", t, text: pick(TEXTS), distanceM: +toTurn.toFixed(1),
        maneuver: m < 0.5 ? undefined : pick(["left", "right", "other"] as const),
        control: r() < 0.3 ? pick(["stopSign", "trafficLight", "none"] as const) : undefined });
    } else if (n < 0.03) events.push({ type: "turnCompleted", t, onTime: r() < 0.7 });
    else if (n < 0.035) events.push({ type: "missedTurn", t });
    else if (n < 0.04) events.push({ type: "rerouted", t });
    else if (n < 0.043) events.push({ type: "wrongTurn", t, expected: pick(["left", "right"] as const), turned: pick(["left", "right"] as const) });
    else if (n < 0.048) events.push({ type: "hazardAhead", t, kind: pick(HAZARDS), distanceM: Math.round(r() * 2000), id: r() < 0.5 ? `h${Math.floor(r() * 5)}` : undefined });
    else if (n < 0.054) events.push({ type: "poiAhead", t, name: pick(NAMES), kind: pick(WISHES) });
    else if (n < 0.06) events.push({ type: "stopRequestAnswer", t, accepted: r() < 0.5 });
    else if (n < 0.063) events.push({ type: "promisedStop", t, visited: r() < 0.5 });
    else if (n < 0.066) events.push({ type: "destinationSet", t, name: pick(NAMES) });
    else if (n < 0.072) events.push({ type: "battery", t, level: +r().toFixed(2), charging: r() < 0.2 });
    else if (n < 0.076) events.push({ type: "resumed", t, stoppedMs: Math.round(r() * 600_000), phoneStayedInCar: r() < 0.5 });
    else if (n < 0.08) events.push({ type: "unplannedStop", t, place: r() < 0.3 ? undefined : { kind: pick(PLACES), name: r() < 0.5 ? pick(NAMES) : undefined } });
    else if (n < 0.086) events.push({ type: "traffic", t, heavy: r() < 0.6, alternate: r() < 0.6 ? "Colfax Avenue" : undefined });
    for (const e of events) {
      lines.push(encodeNav(e));
      say(engine.onNav(e));
    }
  }
  const end: NavEvent = { type: "arrived", t: t + 1000 };
  lines.push(encodeNav(end));
  say(engine.onNav(end));
  const rep = engine.report();
  const st = engine.stats;
  const top = rep.heatmap.cells[0];
  lines.push(["=", rep.overall.score, rep.overall.letter, rep.instructions.score, rep.driving.score, st.hardBrakes, st.hardAccels,
    st.missedTurns, st.wrongTurns, st.lateTurns, st.reroutes, st.turnsCompleted, st.roastsDelivered, st.maxOverLimit,
    +st.speedingSeconds.toFixed(3), +st.distanceM.toFixed(3), engine.incidents.length, rep.heatmap.cells.length,
    top ? `${top.lat},${top.lon},${top.weight},${top.count}` : "-"].join("\t"));
}

// Trip-start speech: greeting, route rundown and time prediction from a random history.
// Y seed oLat oLon dLat dLon name expected records steps
//   records: routeKey,destination,expected,actual,missed,brakes,grade;...   steps: maneuver:text;...
for (let seed = 1; seed <= 40; seed++) {
  const r = seededRng(seed * 104729);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const origin = { lat: 39.7 + pick([0, 0.001, 0.02]), lon: -105 };
  const destination = { lat: 39.75, lon: -104.9 + pick([0, 0.0005, 0.03]) };
  const plan = { origin, destination, destinationName: pick(NAMES), expectedMinutes: Math.round(r() * 40) };
  const history: TripRecord[] = [];
  const count = Math.floor(r() * 14);
  for (let i = 0; i < count; i++) {
    history.push({
      routeKey: r() < 0.5 ? routeKey(origin, destination) : routeKey(destination, origin),
      destination: plan.destinationName, endedAt: i, expectedMinutes: r() < 0.1 ? 0 : 5 + Math.round(r() * 30),
      actualMinutes: +(3 + r() * 40).toFixed(1), speedingShare: 0, missedTurns: r() < 0.3 ? Math.floor(r() * 3) : 0,
      hardBrakes: Math.floor(r() * 4), grade: pick(["A", "B+", "C-", "D", "F"]),
    });
  }
  const steps: RouteStep[] = [];
  const stepCount = Math.floor(r() * 11);
  for (let i = 0; i < stepCount; i++) steps.push({ text: pick(TEXTS), maneuver: r() < 0.5 ? undefined : pick(["left", "right", "uturn", "other"] as const) });
  const rec = history.map((h) => [h.routeKey, h.destination, h.expectedMinutes, h.actualMinutes, h.missedTurns, h.hardBrakes, h.grade].join(",")).join(";");
  const st = steps.map((s) => `${opt(s.maneuver)}:${s.text}`).join(";");
  lines.push(["Y", seed, origin.lat, origin.lon, destination.lat, destination.lon, plan.destinationName, plan.expectedMinutes, rec || "-", st || "-"].join("\t"));
  const rng = seededRng(seed);
  lines.push([">", "greeting", tripGreeting(history, rng)].join("\t"));
  lines.push([">", "rundown", routeRundown(steps, history, rng)].join("\t"));
  const p = predictTrip(history, plan, rng);
  lines.push([">", "predict", p.predictedMinutes, p.habit, p.timesOnRoute, p.text].join("\t"));
}

// A finished trip's record (rounding and route key), from the first scenario's engine.
{
  const engine = new CritiqueEngine({ rng: seededRng(5) }, 0);
  engine.onTelemetry({ t: 0, speedMps: 20, speedLimitMps: 13.4 });
  engine.onTelemetry({ t: 1000, speedMps: 21, speedLimitMps: 13.4 });
  engine.onTelemetry({ t: 2000, speedMps: 10, speedLimitMps: 13.4 });
  engine.onNav({ type: "arrived", t: 754_321 });
  const rec = recordTrip(engine, { origin: { lat: 39.7391, lon: -104.9902 }, destination: { lat: 39.761, lon: -105.0123 }, destinationName: "Work", expectedMinutes: 14 });
  lines.push(["V", rec.routeKey, rec.actualMinutes, rec.speedingShare, rec.hardBrakes, rec.grade].join("\t"));
}

const target = process.argv[2];
if (!target) throw new Error("usage: node core/tools/record-trace.ts <path/to/parity_trace.txt>");
writeFileSync(target, lines.join("\n") + "\n");
console.log(`${SCENARIOS} scenarios, ${lines.length} lines, ${lines.filter((l) => l.startsWith(">")).length} spoken`);
