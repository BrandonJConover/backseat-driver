// Core data types shared by the engine, the line library and whatever app hosts it.

export type Units = "mph" | "kmh";

/** One GPS/telemetry reading. Speeds are always meters per second internally. */
export interface TelemetrySample {
  /** Milliseconds since some fixed epoch (Date.now() in the app, sim clock in tests). */
  t: number;
  speedMps: number;
  /** Posted limit for the current road, if the map provider knows it. */
  speedLimitMps?: number;
  /** Position, used to place incidents on the end-of-trip heat map. */
  lat?: number;
  lon?: number;
  /** GPS course over ground, degrees clockwise from north. Used to catch wrong-way turns. */
  headingDeg?: number;
}

export type TurnDirection = "left" | "right";

export type HazardKind = "police" | "construction" | "debris" | "crash" | "stalledCar";

/** Places the GPS itself wants to visit. */
export type StopWish = "electronics" | "carWash" | "charging" | "other";

export type PlaceKind = "gas" | "food" | "coffee" | "store" | "other";

export interface LatLon {
  lat: number;
  lon: number;
}

/** Events coming from the navigation/routing layer (not derived from telemetry). */
// `at` is where the maneuver was (e.g. the intersection that got missed); if omitted the
// engine uses the last telemetry position.
export type NavEvent =
  // `maneuver` is the turn direction if the routing SDK provides it; otherwise it's read from the text.
  // `control` is what governs the intersection (most routing SDKs expose stop signs and signals).
  | {
      type: "instruction";
      t: number;
      text: string;
      distanceM: number;
      maneuver?: TurnDirection | "other";
      control?: "stopSign" | "trafficLight" | "none";
      at?: LatLon;
    }
  | { type: "turnCompleted"; t: number; onTime: boolean; at?: LatLon }
  // Routing progress: distance left to the next maneuver. Send it every second or so.
  | { type: "progress"; t: number; distanceM: number }
  | { type: "missedTurn"; t: number; at?: LatLon }
  // For routing SDKs that detect it themselves. The engine also detects it from headingDeg.
  | { type: "wrongTurn"; t: number; expected: TurnDirection; turned: TurnDirection; at?: LatLon }
  | { type: "rerouted"; t: number; at?: LatLon }
  // A reported hazard on the route ahead (from a traffic-incident feed).
  | { type: "hazardAhead"; t: number; kind: HazardKind; distanceM: number; id?: string }
  // A place coming up along the route (from a POI search). The GPS may ask to stop there.
  | { type: "poiAhead"; t: number; name: string; kind: StopWish }
  // The driver's spoken answer (via Whisper) to the GPS's request to stop.
  | { type: "stopRequestAnswer"; t: number; accepted: boolean }
  // Whether the driver actually went to the stop they agreed to (the app knows from the
  // route: they arrived at the stopover waypoint, or drove past it / it got dropped).
  | { type: "promisedStop"; t: number; visited: boolean }
  // The driver told Whisper where to go and a route exists.
  | { type: "destinationSet"; t: number; name: string }
  // Phone battery status (level 0..1). Send it whenever the OS reports a change.
  | { type: "battery"; t: number; level: number; charging: boolean }
  // Driving again after a stop. `phoneStayedInCar` comes from the phone's motion/activity
  // sensors: no walking detected during the stop means you left it in the car.
  | { type: "resumed"; t: number; stoppedMs: number; phoneStayedInCar: boolean }
  // The car stopped somewhere that isn't the destination (app decides: off-route + parked a while).
  // `place` comes from reverse geocoding / POI lookup if available.
  | { type: "unplannedStop"; t: number; place?: { kind: PlaceKind; name?: string }; at?: LatLon }
  // From the traffic provider. `alternate` is the route the GPS suggested (or would have),
  // e.g. "Colfax Avenue", so it can say "I told you to take Colfax Avenue".
  | { type: "traffic"; t: number; heavy: boolean; alternate?: string; at?: LatLon }
  | { type: "arrived"; t: number; at?: LatLon };

/**
 * One thing the driver did wrong. Speeding, hard brakes/starts and turn mistakes are
 * logged whether or not the GPS got to roast them; dawdling and long stops are logged
 * when they get called out.
 * The trip report (grade + heat map) is built entirely from these, so the app can
 * persist the log and rebuild the report later.
 */
export interface Incident {
  t: number;
  kind:
    | "speeding"
    | "tooSlow"
    | "traffic"
    | "hardBraking"
    | "hardAccel"
    | "longStop"
    | "missedTurn"
    | "wrongTurn"
    | "lateTurn"
    | "unplannedStop"
    | "rerouted";
  lat?: number;
  lon?: number;
  /** For speeding: display units over the limit at that moment. */
  overLimit?: number;
  /** Instruction text for turn-related incidents. */
  detail?: string;
}

export type Category =
  | "speeding"
  | "tooSlow"
  | "traffic"
  | "hardBraking"
  | "hardAccel"
  | "longStop"
  | "missedTurn"
  | "wrongTurn"
  | "payback"
  | "unplannedStop"
  | "abandoned"
  | "hazard"
  | "stopRequest"
  | "noDestination"
  | "battery"
  | "rerouted"
  | "turnCompleted"
  | "instruction"
  | "arrived";

/** What the engine wants spoken. The host app sends `text` to Kokoro. */
export interface Commentary {
  t: number;
  category: Category;
  text: string;
  /** 0..100 — how fed up the GPS is right now. */
  frustration: number;
  /** Navigation lines must be spoken; roasts can be dropped if the speaker is busy. */
  priority: "nav" | "roast";
  /** Suggested Kokoro settings: angrier = a bit faster. */
  voice: { speed: number };
}

export interface TripStats {
  startedAt: number;
  endedAt?: number;
  distanceM: number;
  speedingSeconds: number;
  maxOverLimit: number; // in display units
  hardBrakes: number;
  hardAccels: number;
  missedTurns: number;
  wrongTurns: number;
  lateTurns: number;
  reroutes: number;
  turnsCompleted: number;
  roastsDelivered: number;
}
