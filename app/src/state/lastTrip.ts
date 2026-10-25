// The finished trip's report, handed from the drive screen to the report screen.
import type { Incident, TripReport } from "@backseat/engine";

let last: { report: TripReport; incidents: readonly Incident[]; destination: string } | undefined;

export const lastTrip = {
  set(v: NonNullable<typeof last>) {
    last = v;
  },
  get() {
    return last;
  },
};
