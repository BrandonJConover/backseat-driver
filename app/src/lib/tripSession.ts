// The bridge between Google's Navigation SDK and the critique engine for one trip.
// It translates SDK callbacks (locations, turn-by-turn updates, reroutes, arrival) into
// engine events, notices things the SDK doesn't report (unplanned stops, leaving the
// phone in the car), and hands everything the engine says to the speech queue.
//
// SDK payloads are typed structurally here so this file runs in plain Node tests
// without loading the native module.

import {
  CritiqueEngine,
  predictTrip,
  recordTrip,
  routeRundown,
  tripGreeting,
  type Commentary,
  type EngineConfig,
  type NavEvent,
  type TripPlan,
  type TripRecord,
  type TripReport,
} from "@backseat/engine";
import { toEngineManeuver } from "./maneuver.ts";
import type { SpeedLimitProvider } from "./speedLimits.ts";

export interface SdkLocation {
  lat: number;
  lng: number;
  speed: number;
  bearing?: number;
  time: number;
}

export interface SdkStep {
  instruction?: string;
  fullRoadName?: string;
  maneuver: number;
  stepNumber?: number;
}

export interface SdkTurnByTurn {
  navState: number; // 1 = ENROUTE, 2 = REROUTING, 3 = STOPPED
  routeChanged: boolean;
  distanceToCurrentStepMeters?: number;
  distanceToFinalDestinationMeters?: number;
  timeToFinalDestinationSeconds?: number;
  currentStep?: SdkStep;
  getRemainingSteps: SdkStep[];
}

export interface TripSessionDeps {
  speak: (lines: Commentary[]) => void;
  speedLimits?: SpeedLimitProvider;
  history?: readonly TripRecord[];
  /** Where the car stopped, if a nearby-place lookup knows (gas station, drive-through...). */
  lookupPlace?: (lat: number, lng: number) => Promise<{ kind: "gas" | "food" | "coffee" | "store" | "other"; name?: string } | undefined>;
  onFinished?: (result: { report: TripReport; record: TripRecord }) => void;
  now?: () => number;
  engine?: Partial<EngineConfig>;
}

/** Parked this long, away from the destination, counts as an unplanned stop. */
const UNPLANNED_STOP_MS = 120_000;
/** Fewer steps than this during a stop means the phone never left the car. */
const WALKING_STEPS = 15;

export class TripSession {
  readonly engine: CritiqueEngine;
  private readonly deps: TripSessionDeps;
  private readonly now: () => number;
  private destination: { name: string; lat: number; lng: number };
  private origin?: { lat: number; lng: number };
  private expectedMinutes?: number;
  private introduced = false;
  private stepNumber?: number;
  private lastStepDistance?: number;
  private rerouting = false;
  private remainingToDestination?: number;
  private stoppedSince?: number;
  private unplannedStop?: { since: number; stepsAtStart: number };
  private movingSamples = 0;
  private steps = 0;
  private finished = false;

  constructor(destination: { name: string; lat: number; lng: number }, deps: TripSessionDeps) {
    this.destination = destination;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.engine = new CritiqueEngine(deps.engine, this.now());
    const t = this.now();
    this.say([this.navLine(t, tripGreeting(deps.history ?? []))]);
    this.nav({ type: "destinationSet", t, name: destination.name });
  }

  onLocation(loc: SdkLocation) {
    if (this.finished) return;
    this.origin ??= { lat: loc.lat, lng: loc.lng };
    this.say(
      this.engine.onTelemetry({
        t: loc.time,
        speedMps: Math.max(0, loc.speed),
        speedLimitMps: this.deps.speedLimits?.current(loc.lat, loc.lng),
        lat: loc.lat,
        lon: loc.lng,
        headingDeg: loc.bearing,
      }),
    );
    this.trackStops(loc);
  }

  onTurnByTurn(ev: SdkTurnByTurn) {
    if (this.finished) return;
    const t = this.now();
    this.remainingToDestination = ev.distanceToFinalDestinationMeters;
    if (!this.introduced && ev.currentStep) {
      this.introduced = true;
      this.expectedMinutes = ev.timeToFinalDestinationSeconds !== undefined ? ev.timeToFinalDestinationSeconds / 60 : undefined;
      this.introduce(t, [ev.currentStep, ...ev.getRemainingSteps]);
    }
    if (ev.navState === 2) {
      this.rerouting = true;
      return;
    }
    const step = ev.currentStep;
    if (!step) return;
    const distance = ev.distanceToCurrentStepMeters ?? 0;
    const number = step.stepNumber ?? -1;

    if (number !== this.stepNumber) {
      // Moving on to a new step means the last one was done, unless we got here by rerouting.
      if (this.stepNumber !== undefined && !this.rerouting) this.nav({ type: "turnCompleted", t, onTime: true });
      this.rerouting = false;
      this.stepNumber = number;
      const maneuver = toEngineManeuver(step.maneuver);
      this.nav({
        type: "instruction",
        t,
        text: step.instruction ?? step.fullRoadName ?? "Continue",
        distanceM: distance,
        maneuver: maneuver === "uturn" ? "other" : maneuver,
      });
    } else {
      this.nav({ type: "progress", t, distanceM: distance });
    }
    this.lastStepDistance = distance;
  }

  /** SDK: onReroutingRequestedByOffRoute. */
  onOffRoute() {
    if (this.finished) return;
    const t = this.now();
    // Off route right at the turn = missed it. Off route mid-block = wandered off; the
    // engine's heading check already caught wrong-way turns.
    if (this.lastStepDistance !== undefined && this.lastStepDistance < 80) this.nav({ type: "missedTurn", t });
    this.nav({ type: "rerouted", t });
    this.rerouting = true;
  }

  /** SDK: onArrival. Stopover arrivals are the GPS's own requested stops. */
  onArrival(isFinalDestination: boolean) {
    if (this.finished) return;
    const t = this.now();
    if (!isFinalDestination) {
      this.nav({ type: "promisedStop", t, visited: true });
      return;
    }
    this.nav({ type: "arrived", t });
    this.finished = true;
    const record = recordTrip(this.engine, this.plan());
    this.deps.onFinished?.({ report: this.engine.report(), record });
  }

  onBattery(level: number, charging: boolean) {
    this.nav({ type: "battery", t: this.now(), level, charging });
  }

  /** Feed pedometer step counts (cumulative or incremental deltas both fine via addSteps). */
  addSteps(n: number) {
    this.steps += n;
  }

  /** Forwards events the app gets from elsewhere (hazard feed, spoken answers). */
  nav(e: NavEvent) {
    this.say(this.engine.onNav(e));
  }

  private introduce(t: number, steps: SdkStep[]) {
    const history = this.deps.history ?? [];
    const routeSteps = steps.map((s) => {
      const m = toEngineManeuver(s.maneuver);
      return { text: s.instruction ?? "", maneuver: m === "other" ? undefined : m };
    });
    const lines = [routeRundown(routeSteps, history)];
    if (this.expectedMinutes !== undefined && this.origin) lines.push(predictTrip(history, this.plan()).text);
    this.say(lines.map((text) => this.navLine(t, text)));
  }

  private plan(): TripPlan {
    return {
      origin: this.origin ? { lat: this.origin.lat, lon: this.origin.lng } : { lat: this.destination.lat, lon: this.destination.lng },
      destination: { lat: this.destination.lat, lon: this.destination.lng },
      destinationName: this.destination.name,
      expectedMinutes: this.expectedMinutes ?? 0,
    };
  }

  private trackStops(loc: SdkLocation) {
    const t = loc.time;
    if (loc.speed < 0.5) {
      this.movingSamples = 0;
      this.stoppedSince ??= t;
      const farFromDestination = (this.remainingToDestination ?? Infinity) > 200;
      if (!this.unplannedStop && farFromDestination && t - this.stoppedSince >= UNPLANNED_STOP_MS) {
        this.unplannedStop = { since: this.stoppedSince, stepsAtStart: this.steps };
        void this.announceUnplannedStop(loc);
      }
      return;
    }
    if (loc.speed > 3) this.movingSamples++;
    // A few solid moving fixes in a row before calling it "driving again" (GPS jitter).
    if (this.movingSamples >= 3) {
      if (this.unplannedStop) {
        const walked = this.steps - this.unplannedStop.stepsAtStart;
        this.nav({ type: "resumed", t: this.now(), stoppedMs: t - this.unplannedStop.since, phoneStayedInCar: walked < WALKING_STEPS });
        this.unplannedStop = undefined;
      }
      this.stoppedSince = undefined;
    }
  }

  private async announceUnplannedStop(loc: SdkLocation) {
    let place: Awaited<ReturnType<NonNullable<TripSessionDeps["lookupPlace"]>>>;
    try {
      place = await this.deps.lookupPlace?.(loc.lat, loc.lng);
    } catch {
      place = undefined;
    }
    this.nav({ type: "unplannedStop", t: this.now(), place, at: { lat: loc.lat, lon: loc.lng } });
  }

  private say(lines: Commentary[]) {
    if (lines.length) this.deps.speak(lines);
  }

  private navLine(t: number, text: string): Commentary {
    return { t, category: "instruction", text, frustration: this.engine.frustration, priority: "nav", voice: { speed: 1 } };
  }
}
