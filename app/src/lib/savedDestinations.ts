// Saved destinations ("home", "work", "Mom's house") and matching what the driver says
// ("take me home") to one of them. Storage is injected so this stays testable.

export interface SavedDestination {
  id: string;
  /** What the driver calls it: "Home", "Work", "Mom's". */
  label: string;
  /** Other names that should match, e.g. ["the office"] for Work. */
  aliases: string[];
  /** Place name and address from Places search. */
  name: string;
  address: string;
  placeId?: string;
  lat: number;
  lng: number;
  createdAt: number;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const KEY = "backseat.savedDestinations.v1";

// Spoken filler around a destination: "can you take me to my mom's house please".
const FILLER = /\b(can you|could you|please|take me|bring me|drive me|navigate|directions|go|drive|head|get me|let's|lets|i want|i need|to go|to|the|my|back)\b/g;

export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best saved destination for what the driver said, or undefined so the app can fall
 * back to a Places search. Exact label/alias wins, then a whole-word match.
 */
export function matchDestination(spoken: string, saved: readonly SavedDestination[]): SavedDestination | undefined {
  const query = normalizeSpoken(spoken);
  if (!query) return undefined;
  const names = (d: SavedDestination) => [d.label, ...d.aliases].map(normalizeSpoken).filter(Boolean);

  const exact = saved.find((d) => names(d).includes(query));
  if (exact) return exact;

  const words = new Set(query.split(" "));
  let best: { d: SavedDestination; score: number } | undefined;
  for (const d of saved) {
    for (const n of names(d)) {
      const nWords = n.split(" ");
      const hits = nWords.filter((w) => words.has(w)).length;
      // Every word of the saved name must appear ("moms house" matches "moms house on elm").
      if (hits === nWords.length) {
        const score = hits / words.size;
        if (!best || score > best.score) best = { d, score };
      }
    }
  }
  return best?.d;
}

export class SavedDestinationStore {
  private cache?: SavedDestination[];
  private readonly storage: KeyValueStorage;

  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  async list(): Promise<SavedDestination[]> {
    if (!this.cache) {
      const raw = await this.storage.getItem(KEY);
      this.cache = raw ? (JSON.parse(raw) as SavedDestination[]) : [];
    }
    return [...this.cache];
  }

  async save(dest: Omit<SavedDestination, "id" | "createdAt"> & { id?: string }): Promise<SavedDestination> {
    const all = await this.list();
    const existing = all.findIndex((d) => d.id === dest.id || d.label.toLowerCase() === dest.label.toLowerCase());
    const record: SavedDestination = {
      ...dest,
      id: dest.id ?? (existing >= 0 ? all[existing].id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
      createdAt: existing >= 0 ? all[existing].createdAt : Date.now(),
    };
    if (existing >= 0) all[existing] = record;
    else all.push(record);
    await this.write(all);
    return record;
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.list()).filter((d) => d.id !== id));
  }

  private async write(all: SavedDestination[]) {
    this.cache = all;
    await this.storage.setItem(KEY, JSON.stringify(all));
  }
}
