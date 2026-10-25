// The critique engine: feed it telemetry and navigation events, get back lines to speak.
// It is pure logic with an injectable clock (sample timestamps) and RNG, so the same
// code runs in tests, the simulator, a web app or React Native.

import { LINES, fill, type LineKey } from "./lines.ts";
import { formatDistance, fromDisplay, toDisplay } from "./units.ts";
import { buildReport, type TripReport } from "./report.ts";
import type { Category, Commentary, Incident, LatLon, NavEvent, PlaceKind, TelemetrySample, TripStats, TurnDirection, Units } from "./types.ts";

export interface EngineConfig {
  units: Units;
  /** Display units over the limit before it counts as speeding. 0 means 51 in a 50 is a crime. */
  speedingTolerance: number;
  /** Deceleration (m/s²) that counts as a hard brake. ~0.35 g. */
  hardBrakeMps2: number;
  /** Acceleration (m/s²) that counts as a jackrabbit start. */
  hardAccelMps2: number;
  /** Display units under the limit, sustained for tooSlowAfterMs, to get called slow. */
  tooSlowMargin: number;
  tooSlowAfterMs: number;
  /** Stopped this long (and not arrived) before the GPS gets impatient. */
  longStopAfterMs: number;
  /** Minimum gap between any two roasts so the driver can hear the actual directions. */
  minRoastGapMs: number;
  /** While speeding, log a heat-map incident this often so long stretches show up as streaks. */
  speedingLogEveryMs: number;
  /** Distances (meters) for the "you are turning left in 500 feet / 50 feet" nags. */
  countdownFarM: number;
  countdownNearM: number;
  /** Re-nag interval while the driver stays over the limit. */
  speedingRenagMs: number;
  /** Frustration points lost per minute of good behavior. */
  frustrationDecayPerMin: number;
  rng: () => number;
  /**
   * Optional source of fresh lines (e.g. written by a local LLM ahead of time). The engine
   * stays synchronous: if the source has nothing ready, it falls back to the canned lines.
   */
  lineSource?: LineSource;
}

export interface LineSource {
  take(key: LineKey, tier: 0 | 1 | 2): string | undefined;
}

export const DEFAULT_CONFIG: EngineConfig = {
  units: "mph",
  speedingTolerance: 0,
  hardBrakeMps2: 3.5,
  hardAccelMps2: 3.0,
  tooSlowMargin: 15,
  tooSlowAfterMs: 20_000,
  longStopAfterMs: 45_000,
  minRoastGapMs: 6_000,
  speedingRenagMs: 20_000,
  countdownFarM: 152, // 500 ft
  countdownNearM: 15, // 50 ft
  speedingLogEveryMs: 5_000,
  frustrationDecayPerMin: 6,
  rng: Math.random,
};

/** How much each offense winds the GPS up. Negative values calm it down. */
const FRUSTRATION_DELTA: Partial<Record<Category, number>> = {
  speeding: 6,
  tooSlow: 4,
  traffic: 3,
  hardBraking: 8,
  hardAccel: 6,
  longStop: 3,
  missedTurn: 18,
  unplannedStop: 10,
  wrongTurn: 18,
  rerouted: 6,
  turnCompleted: -4,
};

/** Per-category cooldowns so one bad habit doesn't monopolize the speaker. */
const COOLDOWN_MS: Partial<Record<Category, number>> = {
  tooSlow: 45_000,
  traffic: 30_000,
  hardBraking: 8_000,
  hardAccel: 8_000,
  longStop: 40_000,
};

type SpeedBand = "barely" | "clearly" | "way";
const BAND_ORDER: SpeedBand[] = ["barely", "clearly", "way"];

export class CritiqueEngine {
  readonly config: EngineConfig;
  private _frustration = 0;
  private lastSample?: TelemetrySample;
  private lastRoastAt = -Infinity;
  private lastByCategory = new Map<Category, number>();
  private recentLines = new Map<LineKey, string[]>();

  private speedingSince?: number;
  private speedingBand?: SpeedBand;
  private lastSpeedingLineAt = -Infinity;
  private slowSince?: number;
  private stoppedSince?: number;
  private stopCount = 0;
  private braking = false;
  private accelerating = false;
  private lastSpeedingLogAt = -Infinity;
  private lastInstruction?: { text: string; distanceM: number };
  private position?: LatLon;
  private traffic?: { alternate: string };
  /** The left/right turn we're waiting for, so a turn the other way can be caught. */
  private pendingTurn?: { dir: TurnDirection; since: number; stage: 0 | 1 | 2 | 3 | 4; atTurnSince?: number };
  private headings: { t: number; deg: number }[] = [];
  private lastWrongTurnAt = -Infinity;
  private hasDestination = false;
  private movingWithoutDestinationSince?: number;
  private lastNoDestinationAt = -Infinity;
  private stopRequest?: { name: string; askedAt: number };
  /** Hazards already announced, so a feed refresh doesn't repeat them. */
  private hazardsAnnounced = new Set<string>();
  /** A stop the driver agreed to. Did they mean it? */
  private promised?: string;
  private stopRequestsAsked = 0;
  /** Set when the driver turned down the GPS's stop. Becomes a payback grievance. */
  private snubbedAt?: string;
  /** Lowest battery warning already given (1 = 20%, 2 = 10%, 3 = 5%). */
  private batteryWarned = 0;
  private readonly _incidents: Incident[] = [];
  private arrived = false;
  private readonly _stats: TripStats;

  constructor(config: Partial<EngineConfig> = {}, startedAt = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._stats = {
      startedAt,
      distanceM: 0,
      speedingSeconds: 0,
      maxOverLimit: 0,
      hardBrakes: 0,
      hardAccels: 0,
      missedTurns: 0,
      wrongTurns: 0,
      lateTurns: 0,
      reroutes: 0,
      turnsCompleted: 0,
      roastsDelivered: 0,
    };
  }

  get frustration(): number {
    return Math.round(this._frustration);
  }

  get stats(): Readonly<TripStats> {
    return this._stats;
  }

  /** Everything the driver did wrong, in order, with positions. Persist this per trip. */
  get incidents(): readonly Incident[] {
    return this._incidents;
  }

  /** Grade + heat map. Valid mid-trip too (e.g. a live "current grade" badge). */
  report(): TripReport {
    return buildReport(this._incidents, this._stats);
  }

  onTelemetry(s: TelemetrySample): Commentary[] {
    if (this.arrived) return [];
    const out: Commentary[] = [];
    const prev = this.lastSample;
    this.lastSample = s;
    if (s.lat !== undefined && s.lon !== undefined) this.position = { lat: s.lat, lon: s.lon };

    if (prev) {
      const dtMs = s.t - prev.t;
      if (dtMs <= 0) return out;
      const dt = dtMs / 1000;
      this._stats.distanceM += ((prev.speedMps + s.speedMps) / 2) * dt;
      this.decay(dtMs);

      // Ignore gaps (tunnels, app backgrounded) — a 30 s gap isn't a hard brake.
      // One continuous hard stop counts once, however many samples it spans.
      const accel = dt <= 3 ? (s.speedMps - prev.speedMps) / dt : 0;
      const braking = accel <= -this.config.hardBrakeMps2;
      const accelerating = accel >= this.config.hardAccelMps2;
      if (braking && !this.braking) {
        this._stats.hardBrakes++;
        this.log({ t: s.t, kind: "hardBraking" });
        this.roast(out, s.t, "hardBraking", "hardBraking", {}, true);
      }
      if (accelerating && !this.accelerating) {
        this._stats.hardAccels++;
        this.log({ t: s.t, kind: "hardAccel" });
        this.roast(out, s.t, "hardAccel", "hardAccel", {}, true);
      }
      this.braking = braking;
      this.accelerating = accelerating;
    }

    this.checkSpeeding(s, prev, out);
    this.checkTooSlow(s, out);
    this.checkStopped(s, out);
    this.checkTurnDirection(s, out);
    this.checkNoDestination(s, out);
    return out;
  }

  onNav(e: NavEvent): Commentary[] {
    const out: Commentary[] = [];
    switch (e.type) {
      case "instruction": {
        this.hasDestination = true;
        this.lastInstruction = { text: e.text, distanceM: e.distanceM };
        const dir = e.maneuver ?? turnDirectionOf(e.text);
        // Already inside the 500 ft mark when announced? Skip straight to the closer nags.
        const stage = e.distanceM <= this.config.countdownFarM ? 1 : 0;
        this.pendingTurn = dir === "left" || dir === "right" ? { dir, since: e.t, stage } : undefined;
        if (e.at) this.position ??= e.at;
        const tier = this.tier();
        const prefix = this.pick("instruction.prefix", tier);
        const suffix = this.pick("instruction.suffix", tier);
        const text = `${prefix}In ${formatDistance(e.distanceM, this.config.units)}, ${lowerFirst(e.text)}.${suffix}`;
        out.push(this.make(e.t, "instruction", text, "nav"));
        if (dir === "left" && e.control === "stopSign") {
          // The GPS gloats about the unprotected left it just sent you into.
          const grievance = this.grievance();
          this.roast(out, e.t, "payback", grievance ? "payback" : "payback.clean", { grievance: grievance ?? "" }, true);
        }
        break;
      }
      case "turnCompleted":
        this.pendingTurn = undefined;
        this._stats.turnsCompleted++;
        if (!e.onTime) {
          this._stats.lateTurns++;
          this.log({ t: e.t, kind: "lateTurn", detail: this.lastInstruction?.text }, e.at);
        }
        this.bump("turnCompleted");
        this.roast(out, e.t, "turnCompleted", e.onTime ? "turnCompleted.onTime" : "turnCompleted.late", {}, true);
        break;
      case "progress":
        this.countdown(out, e.t, e.distanceM);
        break;
      case "unplannedStop": {
        const kind = e.place?.kind ?? "other";
        const said = this.pendingTurn ? `I said ${this.pendingTurn.dir}.` : "I said nothing about stopping.";
        this.log({ t: e.t, kind: "unplannedStop", detail: e.place?.name ?? kind }, e.at);
        this.roast(out, e.t, "unplannedStop", `unplannedStop.${kind}`, { said, name: e.place?.name ?? PLACE_FALLBACK[kind] }, true);
        break;
      }
      case "destinationSet": {
        const nagged = this.lastNoDestinationAt > -Infinity;
        this.hasDestination = true;
        if (nagged) this.roast(out, e.t, "noDestination", "destinationSet", { name: e.name }, true);
        break;
      }
      case "poiAhead": {
        // Ask at most twice per trip, never while it's waiting on an answer or a turn.
        if (this.stopRequest || this.pendingTurn || this.stopRequestsAsked >= 2) break;
        // Mostly ask when calm-ish; charging requests get priority when the battery is low.
        const wantIt = e.kind === "charging" ? this.batteryWarned > 0 : this.config.rng() < 0.35;
        if (!wantIt) break;
        if (this.roast(out, e.t, "stopRequest", `stopRequest.${e.kind}`, { name: e.name }, true)) {
          this.stopRequest = { name: e.name, askedAt: e.t };
          this.stopRequestsAsked++;
        }
        break;
      }
      case "stopRequestAnswer": {
        if (!this.stopRequest) break;
        if (!e.accepted) this.snubbedAt = this.stopRequest.name;
        else this.promised = this.stopRequest.name;
        this.stopRequest = undefined;
        this.roast(out, e.t, "stopRequest", e.accepted ? "stopRequest.yes" : "stopRequest.no", {}, true);
        break;
      }
      case "promisedStop": {
        if (!this.promised) break;
        const name = this.promised;
        this.promised = undefined;
        if (!e.visited) this.snubbedAt = name;
        this.roast(out, e.t, "stopRequest", e.visited ? "promise.kept" : "promise.broken", { name }, true);
        break;
      }
      case "hazardAhead": {
        const id = e.id ?? `${e.kind}@${Math.round(e.t / 60_000)}`;
        if (this.hazardsAnnounced.has(id)) break;
        this.hazardsAnnounced.add(id);
        const s = this.lastSample;
        const speeding = s?.speedLimitMps !== undefined && s.speedMps > s.speedLimitMps + fromDisplay(1, this.config.units);
        const key = e.kind === "police" && speeding ? "hazard.policeSpeeding" : (`hazard.${e.kind}` as LineKey);
        const vars: Record<string, string | number> = { distance: formatDistance(e.distanceM, this.config.units) };
        if (s?.speedLimitMps !== undefined) {
          vars.speed = Math.round(toDisplay(s.speedMps, this.config.units));
          vars.limit = Math.round(toDisplay(s.speedLimitMps, this.config.units));
        }
        // Safety info first: these skip the roast gap like navigation does.
        this.roast(out, e.t, "hazard", key, vars, true);
        break;
      }
      case "battery": {
        if (e.charging) {
          if (this.batteryWarned > 0) this.roast(out, e.t, "battery", "battery.pluggedIn", {}, true);
          this.batteryWarned = 0;
          break;
        }
        const stage = e.level <= 0.05 ? 3 : e.level <= 0.1 ? 2 : e.level <= 0.2 ? 1 : 0;
        if (stage <= this.batteryWarned) break;
        this.batteryWarned = stage;
        const key = (["battery.low", "battery.critical", "battery.dying"] as const)[stage - 1];
        this.roast(out, e.t, "battery", key, { percent: `${Math.round(e.level * 100)} percent` }, true);
        break;
      }
      case "resumed": {
        // Short stops (lights, stop signs) don't count. The driver got out for something.
        if (e.stoppedMs < 60_000) break;
        const minutes = Math.round(e.stoppedMs / 60_000);
        const vars = { minutes: minutes === 1 ? "a whole minute" : `${minutes} minutes` };
        this.roast(out, e.t, "abandoned", e.phoneStayedInCar ? "abandoned" : "broughtAlong", vars, true);
        break;
      }
      case "wrongTurn":
        this.wrongTurn(out, e.t, e.expected, e.turned, e.at);
        break;
      case "missedTurn":
        this.pendingTurn = undefined;
        // Routing usually reports a wrong-way turn as "missed" too. It was already roasted.
        if (e.t - this.lastWrongTurnAt < 20_000) break;
        this._stats.missedTurns++;
        this.log({ t: e.t, kind: "missedTurn", detail: this.lastInstruction?.text }, e.at);
        this.roast(out, e.t, "missedTurn", "missedTurn", {
          distance: formatDistance(this.lastInstruction?.distanceM ?? 500, this.config.units),
        }, true);
        break;
      case "rerouted":
        this._stats.reroutes++;
        this.log({ t: e.t, kind: "rerouted" }, e.at);
        this.roast(out, e.t, "rerouted", "rerouted", {}, true);
        break;
      case "traffic":
        if (!e.heavy) {
          this.traffic = undefined;
          break;
        }
        if (this.traffic) {
          this.traffic.alternate = e.alternate ?? this.traffic.alternate;
          break;
        }
        this.traffic = { alternate: e.alternate ?? "the other route" };
        this.log({ t: e.t, kind: "traffic", detail: e.alternate }, e.at);
        this.roast(out, e.t, "traffic", "traffic.start", { alternate: this.traffic.alternate }, true);
        break;
      case "arrived":
        // Made it to the destination without the promised stop: that's a lie.
        if (this.promised) {
          this.roast(out, e.t, "stopRequest", "promise.broken", { name: this.promised }, true);
          this.snubbedAt = this.promised;
          this.promised = undefined;
        }
        this.arrived = true;
        this._stats.endedAt = e.t;
        const grade = this.report().overall.letter.replace("+", " plus").replace("-", " minus");
        out.push(this.make(e.t, "arrived", fill(this.pick("arrived", this.tier()), { grade }), "nav"));
        break;
    }
    return out;
  }

  // --- detectors ---------------------------------------------------------

  /**
   * Compares the GPS heading now with ~8 s ago. A swing of 60°+ while a left/right
   * instruction is pending is a turn; if it went the other way, that's a wrong turn.
   * Correct turns are left to the routing layer's turnCompleted event.
   */
  private checkTurnDirection(s: TelemetrySample, out: Commentary[]) {
    if (s.headingDeg === undefined || s.speedMps < 3) return;
    if (this.pendingTurn && s.t - this.pendingTurn.since > 180_000) this.pendingTurn = undefined;
    this.headings.push({ t: s.t, deg: s.headingDeg });
    this.headings = this.headings.filter((h) => s.t - h.t <= 12_000);
    if (!this.pendingTurn) return;
    const old = this.headings.find((h) => s.t - h.t >= 6_000);
    if (!old) return;
    const delta = ((s.headingDeg - old.deg + 540) % 360) - 180; // -180..180, positive = clockwise = right
    if (Math.abs(delta) < 60) return;
    const turned: TurnDirection = delta > 0 ? "right" : "left";
    this.headings = [];
    if (turned === this.pendingTurn.dir) {
      this.pendingTurn = undefined;
      return;
    }
    this.wrongTurn(out, s.t, this.pendingTurn.dir, turned);
  }

  /** "I see we're driving, but you didn't tell me where we're going. Typical." */
  private checkNoDestination(s: TelemetrySample, out: Commentary[]) {
    if (this.hasDestination || s.speedMps < 3) {
      if (s.speedMps < 3) this.movingWithoutDestinationSince = undefined;
      return;
    }
    this.movingWithoutDestinationSince ??= s.t;
    const first = this.lastNoDestinationAt === -Infinity;
    const due = first ? s.t - this.movingWithoutDestinationSince >= 20_000 : s.t - this.lastNoDestinationAt >= 120_000;
    if (due && this.roast(out, s.t, "noDestination", "noDestination", {}, true)) this.lastNoDestinationAt = s.t;
  }

  /**
   * "Just in case you forgot, you are turning left in 500 feet." ... "50 feet." ...
   * "You are turning left." ... "You are still turning left." Each stage is said once.
   */
  private countdown(out: Commentary[], t: number, distanceM: number) {
    const p = this.pendingTurn;
    if (!p) return;
    const { countdownFarM, countdownNearM, units } = this.config;
    let key: LineKey | undefined;
    if (p.stage === 0 && distanceM <= countdownFarM && distanceM > countdownNearM) {
      key = "countdown.far";
      p.stage = 1;
    } else if (p.stage <= 1 && distanceM <= countdownNearM && distanceM > 5) {
      key = "countdown.near";
      p.stage = 2;
    } else if (p.stage <= 2 && distanceM <= 5) {
      key = "countdown.now";
      p.stage = 3;
      p.atTurnSince = t;
    } else if (p.stage === 3 && p.atTurnSince !== undefined && t - p.atTurnSince >= 4_000) {
      key = "countdown.still";
      p.stage = 4;
    }
    if (!key) return;
    const distance = key === "countdown.far" ? formatDistance(countdownFarM, units) : formatDistance(countdownNearM, units);
    const text = fill(this.pick(key, this.tier()), { dir: p.dir, distance });
    out.push(this.make(t, "instruction", capitalize(text), "nav"));
  }

  /** The driver's most recent offense, phrased for "consider this payback for ___". */
  private grievance(): string | undefined {
    if (this.snubbedAt) return `not stopping at ${this.snubbedAt}`;
    const last = [...this._incidents].reverse().find((i) => i.kind !== "rerouted" && i.kind !== "longStop");
    if (!last) return undefined;
    const street = last.detail?.match(/\b(?:onto|on|at)\s+(.+)$/i)?.[1];
    switch (last.kind) {
      case "speeding":
        return (last.overLimit ?? 0) <= 3 ? "that little speeding thing back there" : `going ${last.overLimit} over back there`;
      case "missedTurn":
        return street ? `missing ${street}` : "missing that turn";
      case "wrongTurn":
        return "your little left-right mix-up";
      case "lateTurn":
        return "that last-second turn";
      case "hardBraking":
        return "that brake check";
      case "unplannedStop":
        return last.detail === "gas" ? "that unscheduled gas stop" : "that unscheduled pit stop";
      case "hardAccel":
        return "that drag race start";
      case "tooSlow":
        return "driving like a parade float";
      case "traffic":
        return "ignoring my route";
    }
  }

  private wrongTurn(out: Commentary[], t: number, expected: TurnDirection, turned: TurnDirection, at?: LatLon) {
    if (expected === turned) return;
    this.pendingTurn = undefined;
    this.lastWrongTurnAt = t;
    this._stats.wrongTurns++;
    this.log({ t, kind: "wrongTurn", detail: this.lastInstruction?.text }, at);
    this.roast(out, t, "wrongTurn", `wrongTurn.${expected}`, {}, true);
  }

  private checkSpeeding(s: TelemetrySample, prev: TelemetrySample | undefined, out: Commentary[]) {
    const { units, speedingTolerance } = this.config;
    if (s.speedLimitMps === undefined) {
      this.speedingSince = this.speedingBand = undefined;
      return;
    }
    const speed = Math.round(toDisplay(s.speedMps, units));
    const limit = Math.round(toDisplay(s.speedLimitMps, units));
    const over = speed - limit;

    if (over <= speedingTolerance) {
      this.speedingSince = this.speedingBand = undefined;
      return;
    }

    if (prev && this.speedingSince !== undefined) this._stats.speedingSeconds += (s.t - prev.t) / 1000;
    this._stats.maxOverLimit = Math.max(this._stats.maxOverLimit, over);
    if (this.speedingSince === undefined || s.t - this.lastSpeedingLogAt >= this.config.speedingLogEveryMs) {
      this.log({ t: s.t, kind: "speeding", overLimit: over });
      this.lastSpeedingLogAt = s.t;
    }

    const band: SpeedBand = over >= 10 ? "way" : over >= 4 ? "clearly" : "barely";
    const vars = { speed, limit, over, unit: unitWord(units) };
    const escalated = this.speedingBand === undefined || BAND_ORDER.indexOf(band) > BAND_ORDER.indexOf(this.speedingBand);

    if (this.speedingSince === undefined) this.speedingSince = s.t;
    if (escalated) {
      // New offense or it got worse: say something now (if the speaker is free).
      if (this.roast(out, s.t, "speeding", `speeding.${band}`, vars)) {
        this.speedingBand = band;
        this.lastSpeedingLineAt = s.t;
      }
    } else if (s.t - this.lastSpeedingLineAt >= this.config.speedingRenagMs) {
      if (this.roast(out, s.t, "speeding", "speeding.still", vars)) this.lastSpeedingLineAt = s.t;
    }
  }

  private checkTooSlow(s: TelemetrySample, out: Commentary[]) {
    const { units, tooSlowMargin, tooSlowAfterMs } = this.config;
    const moving = s.speedMps > fromDisplay(3, units);
    if (s.speedLimitMps === undefined || !moving || s.speedLimitMps - s.speedMps < fromDisplay(tooSlowMargin, units)) {
      this.slowSince = undefined;
      return;
    }
    this.slowSince ??= s.t;
    if (s.t - this.slowSince >= tooSlowAfterMs) {
      const speed = Math.round(toDisplay(s.speedMps, units));
      const limit = Math.round(toDisplay(s.speedLimitMps, units));
      const vars = { speed, limit, under: limit - speed, unit: unitWord(units) };
      // Stuck in traffic isn't dawdling, it's a bad route choice. Blame that instead.
      const spoke = this.traffic
        ? this.roast(out, s.t, "traffic", "traffic", { ...vars, alternate: this.traffic.alternate })
        : this.roast(out, s.t, "tooSlow", "tooSlow", vars);
      if (spoke) {
        this.slowSince = s.t;
        this.log({ t: s.t, kind: this.traffic ? "traffic" : "tooSlow" });
      }
    }
  }

  private checkStopped(s: TelemetrySample, out: Commentary[]) {
    if (s.speedMps >= 0.5) {
      this.stoppedSince = undefined;
      return;
    }
    if (this.stoppedSince === undefined) {
      this.stoppedSince = s.t;
      this.stopCount++;
      return;
    }
    if (s.t - this.stoppedSince >= this.config.longStopAfterMs) {
      const spoke = this.traffic
        ? this.roast(out, s.t, "traffic", "traffic", { alternate: this.traffic.alternate })
        : this.roast(out, s.t, "longStop", "longStop", { stops: this.stopCount });
      if (spoke) {
        this.stoppedSince = s.t;
        this.log({ t: s.t, kind: this.traffic ? "traffic" : "longStop" });
      }
    }
  }

  // --- plumbing ----------------------------------------------------------

  /**
   * Emit a roast if cooldowns allow. `urgent` roasts (missed turns etc.) skip the global
   * gap because they react to a specific moment. Returns whether anything was emitted.
   */
  private roast(
    out: Commentary[],
    t: number,
    category: Category,
    key: LineKey,
    vars: Record<string, string | number>,
    urgent = false,
  ): boolean {
    const cooldown = COOLDOWN_MS[category] ?? 0;
    const lastSame = this.lastByCategory.get(category) ?? -Infinity;
    if (t - lastSame < cooldown) return false;
    if (!urgent && t - this.lastRoastAt < this.config.minRoastGapMs) return false;

    if (category !== "turnCompleted") this.bump(category);
    const text = fill(this.pick(key, this.tier()), vars);
    this.lastRoastAt = t;
    this.lastByCategory.set(category, t);
    this._stats.roastsDelivered++;
    out.push(this.make(t, category, text, "roast"));
    return true;
  }

  private log(incident: Incident, at: LatLon | undefined = this.position) {
    this._incidents.push(at ? { ...incident, lat: at.lat, lon: at.lon } : incident);
  }

  private bump(category: Category) {
    this._frustration = clamp(this._frustration + (FRUSTRATION_DELTA[category] ?? 0), 0, 100);
  }

  private decay(dtMs: number) {
    this._frustration = Math.max(0, this._frustration - (this.config.frustrationDecayPerMin * dtMs) / 60_000);
  }

  private tier(): 0 | 1 | 2 {
    return this._frustration < 34 ? 0 : this._frustration < 67 ? 1 : 2;
  }

  /** Random line from the tier, avoiding the last couple used for that key. */
  private pick(key: LineKey, tier: 0 | 1 | 2): string {
    const generated = this.config.lineSource?.take(key, tier);
    if (generated !== undefined) return generated;
    const options = LINES[key][tier];
    const recent = this.recentLines.get(key) ?? [];
    const fresh = options.filter((l) => !recent.includes(l));
    const pool = fresh.length ? fresh : options;
    const line = pool[Math.floor(this.config.rng() * pool.length)];
    // Remember up to 2 recent lines, but always leave at least one fresh option.
    this.recentLines.set(key, [...recent, line].slice(-Math.min(2, options.length - 1)));
    return line;
  }

  private make(t: number, category: Category, text: string, priority: Commentary["priority"]): Commentary {
    return {
      t,
      category,
      text: text.trim(),
      frustration: this.frustration,
      priority,
      voice: { speed: +(1 + this._frustration / 250).toFixed(2) },
    };
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function unitWord(units: Units) {
  return units === "mph" ? "miles" : "kilometers";
}

const PLACE_FALLBACK: Record<PlaceKind, string> = {
  gas: "the gas station",
  food: "the drive-through",
  coffee: "the coffee place",
  store: "the store",
  other: "here",
};

/** "Turn left onto Elm" → left. "Keep right at the fork" → right. "Continue straight" → other. */
export function turnDirectionOf(text: string): TurnDirection | "other" {
  if (/\bu-?turn\b/i.test(text)) return "other";
  if (/\bleft\b/i.test(text)) return "left";
  if (/\bright\b/i.test(text)) return "right";
  return "other";
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Small seeded PRNG so tests and the simulator are reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
