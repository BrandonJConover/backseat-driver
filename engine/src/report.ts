// End-of-trip report: the grade (mostly about following instructions) and the heat map
// of where the driver went wrong. Built purely from the engine's incident log, so the
// app can also store the log and rebuild the report later (trip history, sharing).

import type { Incident, TripStats } from "./types.ts";

/** How bad each kind of incident is on the heat map. Speeding scales with the overage. */
const HEAT_WEIGHT: Record<Incident["kind"], number> = {
  speeding: 1,
  tooSlow: 0.5,
  traffic: 0.5,
  hardBraking: 3,
  hardAccel: 2,
  longStop: 0.5,
  missedTurn: 5,
  wrongTurn: 5,
  unplannedStop: 1,
  lateTurn: 2,
  rerouted: 1,
};

export interface GradePart {
  score: number; // 0..100
  letter: string;
}

export interface TripReport {
  overall: GradePart & { quip: string };
  /** The headline: did you do what the GPS told you? */
  instructions: GradePart & { onTime: number; late: number; missed: number; wrongWay: number; reroutes: number };
  driving: GradePart & {
    speedingSeconds: number;
    maxOverLimit: number;
    hardBrakes: number;
    hardAccels: number;
  };
  heatmap: Heatmap;
}

export interface HeatCell {
  lat: number; // cell center
  lon: number;
  weight: number;
  count: number;
  kinds: Partial<Record<Incident["kind"], number>>;
}

export interface Heatmap {
  /** Incidents binned into ~cellMeters squares, worst first. Good for a "hall of shame" list. */
  cells: HeatCell[];
  /** Weighted points, ready for a Mapbox/MapLibre `heatmap` layer or Google HeatmapLayer. */
  geojson: {
    type: "FeatureCollection";
    features: {
      type: "Feature";
      geometry: { type: "Point"; coordinates: [number, number] };
      properties: { weight: number; kind: Incident["kind"]; t: number; detail?: string };
    }[];
  };
}

export function incidentWeight(i: Incident): number {
  return i.kind === "speeding" ? HEAT_WEIGHT.speeding * Math.max(1, (i.overLimit ?? 1) / 3) : HEAT_WEIGHT[i.kind];
}

export function buildReport(incidents: readonly Incident[], stats: TripStats, cellMeters = 75): TripReport {
  const count = (k: Incident["kind"]) => incidents.filter((i) => i.kind === k).length;
  const onTime = stats.turnsCompleted - stats.lateTurns;
  const late = stats.lateTurns;
  const missed = stats.missedTurns;
  const wrongWay = stats.wrongTurns;
  const reroutes = stats.reroutes;

  // Each maneuver is worth 1 if on time, 0.6 if late, 0 if missed or turned the wrong way;
  // extra reroutes (beyond those a botched turn already explains) cost a bit more.
  const maneuvers = onTime + late + missed + wrongWay;
  const extraReroutes = Math.max(0, reroutes - missed - wrongWay);
  const instrScore = maneuvers === 0
    ? 100
    : clamp((100 * (onTime + 0.6 * late)) / maneuvers - extraReroutes * 5, 0, 100);

  const minutes = Math.max(1, ((stats.endedAt ?? stats.startedAt) - stats.startedAt) / 60_000);
  const drivingScore = clamp(
    100 -
      (stats.speedingSeconds / (minutes * 60)) * 60 - // share of the trip spent speeding
      stats.maxOverLimit * 1.5 -
      count("hardBraking") * 6 -
      count("hardAccel") * 4 -
      count("tooSlow") * 2,
    0,
    100,
  );

  const overallScore = Math.round(0.65 * instrScore + 0.35 * drivingScore);
  return {
    overall: { score: overallScore, letter: letter(overallScore), quip: quip(overallScore) },
    instructions: { score: Math.round(instrScore), letter: letter(instrScore), onTime, late, missed, wrongWay, reroutes },
    driving: {
      score: Math.round(drivingScore),
      letter: letter(drivingScore),
      speedingSeconds: Math.round(stats.speedingSeconds),
      maxOverLimit: stats.maxOverLimit,
      hardBrakes: stats.hardBrakes,
      hardAccels: stats.hardAccels,
    },
    heatmap: buildHeatmap(incidents, cellMeters),
  };
}

export function buildHeatmap(incidents: readonly Incident[], cellMeters = 75): Heatmap {
  const located = incidents.filter((i) => i.lat !== undefined && i.lon !== undefined);
  const cells = new Map<string, HeatCell>();
  for (const i of located) {
    const latStep = cellMeters / 111_320;
    const lonStep = cellMeters / (111_320 * Math.cos((i.lat! * Math.PI) / 180));
    const row = Math.floor(i.lat! / latStep);
    const col = Math.floor(i.lon! / lonStep);
    const key = `${row}:${col}`;
    const cell = cells.get(key) ?? {
      lat: (row + 0.5) * latStep,
      lon: (col + 0.5) * lonStep,
      weight: 0,
      count: 0,
      kinds: {},
    };
    cell.weight += incidentWeight(i);
    cell.count++;
    cell.kinds[i.kind] = (cell.kinds[i.kind] ?? 0) + 1;
    cells.set(key, cell);
  }
  return {
    cells: [...cells.values()]
      .map((c) => ({ ...c, weight: +c.weight.toFixed(2), lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6) }))
      .sort((a, b) => b.weight - a.weight),
    geojson: {
      type: "FeatureCollection",
      features: located.map((i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [i.lon!, i.lat!] },
        properties: { weight: +incidentWeight(i).toFixed(2), kind: i.kind, t: i.t, detail: i.detail },
      })),
    },
  };
}

function letter(score: number): string {
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
}

function quip(score: number): string {
  if (score >= 93) return "An A. I checked twice. I'm as surprised as you are.";
  if (score >= 80) return "Fine. Adequate. Don't make it weird.";
  if (score >= 70) return "Average, which in your case is a personal best.";
  if (score >= 60) return "A D. The D stands for 'Did you even listen'.";
  return "An F. I'd write more, but the heat map says it all.";
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
