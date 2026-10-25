import type { Units } from "./types.ts";

const MPS_PER_MPH = 0.44704;
const MPS_PER_KMH = 1 / 3.6;

export function toDisplay(mps: number, units: Units): number {
  return mps / (units === "mph" ? MPS_PER_MPH : MPS_PER_KMH);
}

export function fromDisplay(value: number, units: Units): number {
  return value * (units === "mph" ? MPS_PER_MPH : MPS_PER_KMH);
}

/** Feet for mph users, meters otherwise, rounded to something a GPS would say. */
export function formatDistance(meters: number, units: Units): string {
  if (units === "mph") {
    const feet = meters * 3.28084;
    if (feet >= 1000) return `${(feet / 5280).toFixed(1).replace(/\.0$/, "")} miles`;
    return `${Math.round(feet / 50) * 50} feet`;
  }
  if (meters >= 1000) return `${(meters / 1000).toFixed(1).replace(/\.0$/, "")} kilometers`;
  return `${Math.round(meters / 10) * 10} meters`;
}
