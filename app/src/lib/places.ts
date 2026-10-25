// Google Places API (New): finding destinations by name, and figuring out what kind of
// place the car stopped at ("Why are we stopping for gas?").

import { GOOGLE_MAPS_API_KEY } from "./config";

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export type StopPlaceKind = "gas" | "food" | "coffee" | "store" | "other";

interface ApiPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
}

async function call(endpoint: string, fieldMask: string, body: object): Promise<ApiPlace[]> {
  const res = await fetch(`https://places.googleapis.com/v1/places:${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places ${endpoint} failed: ${res.status}`);
  const json = (await res.json()) as { places?: ApiPlace[] };
  return json.places ?? [];
}

/** "Target", "123 Main St", "Mom's work" → places, biased toward where you are. */
export async function searchPlaces(query: string, near?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  const places = await call("searchText", "places.id,places.displayName,places.formattedAddress,places.location", {
    textQuery: query,
    maxResultCount: 5,
    ...(near && { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 20_000 } } }),
  });
  return places
    .filter((p) => p.location)
    .map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? p.formattedAddress ?? "Unknown place",
      address: p.formattedAddress ?? "",
      lat: p.location!.latitude,
      lng: p.location!.longitude,
    }));
}

export function kindFromTypes(types: readonly string[]): StopPlaceKind {
  if (types.includes("gas_station")) return "gas";
  if (types.some((t) => t === "cafe" || t === "coffee_shop")) return "coffee";
  if (types.some((t) => t.endsWith("restaurant") || t === "meal_takeaway" || t === "bakery")) return "food";
  if (types.some((t) => t.endsWith("store") || t === "supermarket" || t === "shopping_mall")) return "store";
  return "other";
}

/** The closest place to where the car is parked, for the unplanned-stop roast. */
export async function placeAt(lat: number, lng: number): Promise<{ kind: StopPlaceKind; name?: string } | undefined> {
  const [p] = await call("searchNearby", "places.displayName,places.types", {
    maxResultCount: 1,
    rankPreference: "DISTANCE",
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 60 } },
  });
  return p ? { kind: kindFromTypes(p.types ?? []), name: p.displayName?.text } : undefined;
}
