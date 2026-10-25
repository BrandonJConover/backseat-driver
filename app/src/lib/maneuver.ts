// Maps the Navigation SDK's numeric Maneuver enum onto what the engine cares about.
// Values copied from @googlemaps/react-native-navigation-sdk's `Maneuver` enum so this
// file (and its tests) don't load the native module.

export type EngineManeuver = "left" | "right" | "uturn" | "other";

const LEFT = new Set([6 /* TURN_LEFT */, 10 /* TURN_SLIGHT_LEFT */, 12 /* TURN_SHARP_LEFT */]);
const RIGHT = new Set([7 /* TURN_RIGHT */, 11 /* TURN_SLIGHT_RIGHT */, 13 /* TURN_SHARP_RIGHT */]);
const UTURN = new Set([14 /* TURN_U_TURN_CLOCKWISE */, 15 /* TURN_U_TURN_COUNTERCLOCKWISE */]);

export function toEngineManeuver(maneuver: number): EngineManeuver {
  if (LEFT.has(maneuver)) return "left";
  if (RIGHT.has(maneuver)) return "right";
  if (UTURN.has(maneuver)) return "uturn";
  return "other";
}
