// Speed limits from OpenStreetMap, because Google's Navigation SDK doesn't give apps the
// posted limit (it only draws it on its own map). Swap in HERE/TomTom later behind the
// same interface if OSM coverage is too thin.
//
// The engine needs the limit synchronously on every GPS fix, so `current()` answers from
// a cache and quietly fetches in the background when the car enters a new area.

export interface SpeedLimitProvider {
  /** Limit in m/s for the road at this point, if known yet. */
  current(lat: number, lng: number): number | undefined;
}

const MPH = 0.44704;
const KMH = 1 / 3.6;

/** OSM `maxspeed` tag → m/s. Handles "35 mph", "50", "50 km/h"; ignores "signals", "none", zone codes. */
export function parseMaxspeed(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  const m = tag.trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i);
  if (!m) return undefined;
  const value = Number(m[1]);
  return (m[2]?.toLowerCase() === "mph" ? MPH : KMH) * value;
}

interface OverpassWay {
  tags?: { maxspeed?: string; highway?: string };
  center?: { lat: number; lon: number };
}

/** Picks the nearest tagged way's limit from an Overpass `out tags center` response. */
export function pickLimit(ways: OverpassWay[], lat: number, lng: number): number | undefined {
  let best: { limit: number; d: number } | undefined;
  for (const w of ways) {
    const limit = parseMaxspeed(w.tags?.maxspeed);
    if (limit === undefined || !w.center) continue;
    const d = (w.center.lat - lat) ** 2 + ((w.center.lon - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (!best || d < best.d) best = { limit, d };
  }
  return best?.limit;
}

type Fetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class OsmSpeedLimits implements SpeedLimitProvider {
  /** ~110 m cells. */
  private readonly cell = 0.001;
  private cache = new Map<string, number | null>();
  private inflight = new Map<string, Promise<void>>();
  /** Cells whose lookup failed, so we don't hit Overpass on every GPS fix. */
  private failedAt = new Map<string, number>();
  private readonly fetchFn: Fetch;
  private readonly endpoint: string;

  constructor(fetchFn: Fetch = fetch as unknown as Fetch, endpoint = "https://overpass-api.de/api/interpreter") {
    this.fetchFn = fetchFn;
    this.endpoint = endpoint;
  }

  current(lat: number, lng: number): number | undefined {
    const key = this.key(lat, lng);
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    void this.load(key, lat, lng);
    return undefined;
  }

  /** Resolves once the cell for this point is loaded (handy for tests and prefetching). */
  load(key: string, lat: number, lng: number): Promise<void> {
    if (this.cache.has(key)) return Promise.resolve();
    if (Date.now() - (this.failedAt.get(key) ?? -Infinity) < 60_000) return Promise.resolve();
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetchCell(key, lat, lng).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async fetchCell(key: string, lat: number, lng: number): Promise<void> {
    try {
      const query = `[out:json][timeout:10];way(around:30,${lat},${lng})[highway][maxspeed];out tags center;`;
      const res = await this.fetchFn(this.endpoint, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      if (!res.ok) {
        this.failedAt.set(key, Date.now()); // retry this cell in a minute
        return;
      }
      const json = (await res.json()) as { elements?: OverpassWay[] };
      this.cache.set(key, pickLimit(json.elements ?? [], lat, lng) ?? null);
    } catch {
      // Offline: the engine just skips speed checks here until a retry works.
      this.failedAt.set(key, Date.now());
    }
  }

  key(lat: number, lng: number): string {
    return `${Math.round(lat / this.cell)}:${Math.round(lng / this.cell)}`;
  }
}
