import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TripRecord } from "@backseat/engine";
import { SavedDestinationStore } from "./savedDestinations";

export const savedDestinations = new SavedDestinationStore(AsyncStorage);

const HISTORY_KEY = "backseat.tripHistory.v1";
/** Enough history for habits; older trips stop mattering. */
const MAX_TRIPS = 200;

export async function loadHistory(): Promise<TripRecord[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  return raw ? (JSON.parse(raw) as TripRecord[]) : [];
}

export async function appendTrip(record: TripRecord): Promise<void> {
  const all = [...(await loadHistory()), record].slice(-MAX_TRIPS);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}
