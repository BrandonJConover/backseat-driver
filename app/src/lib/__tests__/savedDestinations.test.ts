import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDestination, normalizeSpoken, SavedDestinationStore, type SavedDestination } from "../savedDestinations.ts";

const dest = (label: string, aliases: string[] = []): SavedDestination => ({
  id: label,
  label,
  aliases,
  name: label,
  address: "",
  lat: 0,
  lng: 0,
  createdAt: 0,
});
const saved = [dest("Home"), dest("Work", ["the office"]), dest("Mom's house", ["mom's"])];

test("strips spoken filler", () => {
  assert.equal(normalizeSpoken("Can you take me to my mom's house, please?"), "moms house");
  assert.equal(normalizeSpoken("Take me home"), "home");
});

test("matches what the driver says to a saved destination", () => {
  assert.equal(matchDestination("take me home", saved)?.label, "Home");
  assert.equal(matchDestination("navigate to the office", saved)?.label, "Work");
  assert.equal(matchDestination("drive to my mom's", saved)?.label, "Mom's house");
  assert.equal(matchDestination("go to mom's house on Elm", saved)?.label, "Mom's house");
  assert.equal(matchDestination("take me to Target", saved), undefined);
});

test("store saves, updates by label, and removes", async () => {
  const mem = new Map<string, string>();
  const store = new SavedDestinationStore({ getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v) });
  const home = await store.save({ label: "Home", aliases: [], name: "123 Main", address: "123 Main St", lat: 1, lng: 2 });
  await store.save({ label: "home", aliases: [], name: "456 Oak", address: "456 Oak St", lat: 3, lng: 4 });
  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, home.id);
  assert.equal(all[0].name, "456 Oak");
  const fresh = new SavedDestinationStore({ getItem: async (k) => mem.get(k) ?? null, setItem: async () => {} });
  assert.equal((await fresh.list()).length, 1, "persisted");
  await store.remove(home.id);
  assert.deepEqual(await store.list(), []);
});
