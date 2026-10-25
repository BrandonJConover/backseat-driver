// Scripted drive that exercises every detector. Run: node sim/drive.ts [seed]
// Prints a timeline of what Backseat Driver would say, plus the trip report.

import { CritiqueEngine, seededRng } from "../src/engine.ts";
import { writeFileSync } from "node:fs";
import { fromDisplay } from "../src/units.ts";
import { routeRundown } from "../src/rundown.ts";
import type { Commentary, NavEvent } from "../src/types.ts";

const seed = Number(process.argv[2] ?? 7);
const engine = new CritiqueEngine({ units: "mph", rng: seededRng(seed) });
const mph = (v: number) => fromDisplay(v, "mph");

// Omit distributed over the union, so each event variant keeps its own fields.
type NavInput = NavEvent extends infer E ? (E extends NavEvent ? Omit<E, "t"> : never) : never;

type Segment =
  | { kind: "ramp"; to: number; seconds: number; limit?: number; note?: string }
  | { kind: "hold"; seconds: number; limit?: number; note?: string }
  | { kind: "nav"; event: NavInput; note?: string }
  | { kind: "heading"; degrees: number };

const script: Segment[] = [
  { kind: "nav", event: { type: "instruction", text: "Head north on Main Street", distanceM: 150 } },
  { kind: "ramp", to: 30, seconds: 10, limit: 35, note: "pulling out" },
  { kind: "ramp", to: 51, seconds: 15, limit: 50, note: "onto a 50 zone, creeping to 51" },
  { kind: "hold", seconds: 25, limit: 50 },
  { kind: "ramp", to: 57, seconds: 4, limit: 50, note: "getting comfortable" },
  { kind: "hold", seconds: 8, limit: 50 },
  { kind: "ramp", to: 63, seconds: 4, limit: 50, note: "full send" },
  { kind: "hold", seconds: 10, limit: 50 },
  { kind: "ramp", to: 50, seconds: 8, limit: 50 },
  { kind: "nav", event: { type: "instruction", text: "Turn right onto Oak Avenue", distanceM: 300 } },
  { kind: "hold", seconds: 20, limit: 50 },
  { kind: "nav", event: { type: "missedTurn" }, note: "sails past Oak Ave" },
  { kind: "nav", event: { type: "rerouted" } },
  { kind: "nav", event: { type: "instruction", text: "Turn right onto Pine Street", distanceM: 200 } },
  { kind: "ramp", to: 0, seconds: 3, limit: 50, note: "brake-checks the car behind for a yellow light" },
  { kind: "hold", seconds: 50, limit: 50, note: "sitting at the light" },
  { kind: "ramp", to: 25, seconds: 3, limit: 50, note: "jackrabbit start" },
  { kind: "heading", degrees: 90 },
  { kind: "nav", event: { type: "turnCompleted", onTime: false }, note: "swings onto Pine at the last second" },
  { kind: "hold", seconds: 30, limit: 45, note: "dawdling at 25 in a 45" },
  { kind: "ramp", to: 40, seconds: 6, limit: 45 },
  { kind: "nav", event: { type: "traffic", heavy: true, alternate: "Colfax Avenue" }, note: "hits morning traffic" },
  { kind: "ramp", to: 8, seconds: 6, limit: 45 },
  { kind: "hold", seconds: 50, limit: 45 },
  { kind: "ramp", to: 0, seconds: 4, limit: 45 },
  { kind: "hold", seconds: 50, limit: 45, note: "fully stopped in traffic" },
  { kind: "ramp", to: 35, seconds: 15, limit: 45 },
  { kind: "nav", event: { type: "traffic", heavy: false }, note: "traffic clears" },
  { kind: "hold", seconds: 10, limit: 45 },
  { kind: "nav", event: { type: "instruction", text: "Turn left onto Elm Street", distanceM: 250 } },
  { kind: "hold", seconds: 15, limit: 45 },
  { kind: "heading", degrees: 180 },
  { kind: "hold", seconds: 10, limit: 35, note: "turns right onto Elm instead" },
  { kind: "nav", event: { type: "missedTurn" } },
  { kind: "nav", event: { type: "rerouted" } },
  { kind: "nav", event: { type: "instruction", text: "Turn left onto 2nd Avenue", distanceM: 150, control: "stopSign" } },
  { kind: "hold", seconds: 10, limit: 35 },
  { kind: "heading", degrees: 90 },
  { kind: "nav", event: { type: "turnCompleted", onTime: true }, note: "nails the turn" },
  { kind: "hold", seconds: 20, limit: 30 },
  { kind: "ramp", to: 0, seconds: 10, limit: 30, note: "pulling into the driveway" },
  { kind: "nav", event: { type: "arrived" } },
];

let t = 0;
let speed = 0;
// Start somewhere plausible and dead-reckon the position from speed + heading.
let lat = 39.7392;
let lon = -104.9903;
let heading = 0;
let toTurn: number | undefined;
const track: [number, number][] = [[lon, lat]];
const log: { t: number; c?: Commentary; note?: string }[] = [];
const say = (cs: Commentary[]) => cs.forEach((c) => log.push({ t: c.t, c }));

// Trip start: the condescending preview of the planned route.
const planned = ["Head north on Main Street", "Turn right onto Oak Avenue", "Turn left onto Elm Street", "Turn left onto 2nd Avenue", "Turn right onto Birch Lane"];
say([{ t: 0, category: "instruction", text: routeRundown(planned.map((text) => ({ text })), [], seededRng(seed)), frustration: 0, priority: "nav", voice: { speed: 1 } }]);

for (const seg of script) {
  if ("note" in seg && seg.note) log.push({ t, note: seg.note });
  if (seg.kind === "heading") {
    heading = seg.degrees;
    continue;
  }
  if (seg.kind === "nav") {
    say(engine.onNav({ ...seg.event, t } as NavEvent));
    // Feed routing progress toward the announced turn until it's resolved.
    if (seg.event.type === "instruction") toTurn = seg.event.distanceM;
    if (["turnCompleted", "missedTurn", "wrongTurn", "arrived"].includes(seg.event.type)) toTurn = undefined;
    continue;
  }
  const start = speed;
  const target = seg.kind === "ramp" ? mph(seg.to) : speed;
  for (let i = 1; i <= seg.seconds; i++) {
    t += 1000;
    speed = start + ((target - start) * i) / seg.seconds;
    const rad = (heading * Math.PI) / 180;
    lat += (speed * Math.cos(rad)) / 111_320;
    lon += (speed * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    track.push([lon, lat]);
    if (toTurn !== undefined) {
      toTurn = Math.max(0, toTurn - speed);
      say(engine.onNav({ type: "progress", t, distanceM: toTurn }));
    }
    say(engine.onTelemetry({ t, speedMps: speed, speedLimitMps: seg.limit === undefined ? undefined : mph(seg.limit), lat, lon, headingDeg: heading }));
  }
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

for (const entry of log) {
  if (entry.note) console.log(`\n${clock(entry.t)}  -- ${entry.note} --`);
  if (entry.c) {
    const c = entry.c;
    const tag = c.priority === "nav" ? "NAV " : "ROAST";
    console.log(`${clock(c.t)}  [${tag}] (${String(c.frustration).padStart(3)}% mad) ${c.text}`);
  }
}

const st = engine.stats;
const r = engine.report();
console.log(`
=== Trip report ===
overall         ${r.overall.letter} (${r.overall.score})  ${r.overall.quip}
instructions    ${r.instructions.letter} (${r.instructions.score})  on time ${r.instructions.onTime}, late ${r.instructions.late}, missed ${r.instructions.missed}, wrong way ${r.instructions.wrongWay}, reroutes ${r.instructions.reroutes}
driving         ${r.driving.letter} (${r.driving.score})  speeding ${r.driving.speedingSeconds}s (worst +${r.driving.maxOverLimit}), hard brakes ${r.driving.hardBrakes}, jackrabbits ${r.driving.hardAccels}
distance        ${(st.distanceM / 1609.34).toFixed(2)} mi, ${st.roastsDelivered} roasts, ${engine.incidents.length} incidents logged

Hall of shame (worst heat-map cells):`);
for (const c of r.heatmap.cells.slice(0, 5)) {
  const kinds = Object.entries(c.kinds).map(([k, n]) => `${k} x${n}`).join(", ");
  console.log(`  ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}  heat ${String(c.weight).padStart(5)}  ${kinds}`);
}

const outFile = process.argv[3];
if (outFile) {
  writeFileSync(outFile, JSON.stringify({ track, log, report: r }, null, 2));
  console.log(`\nWrote trip data to ${outFile}`);
}
