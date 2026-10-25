import { test } from "node:test";
import assert from "node:assert/strict";
import { OsmSpeedLimits, parseMaxspeed, pickLimit } from "../speedLimits.ts";

const mph = (v: number) => v * 0.44704;

test("parses OSM maxspeed tags", () => {
  assert.equal(parseMaxspeed("35 mph"), mph(35));
  assert.ok(Math.abs(parseMaxspeed("50")! - 50 / 3.6) < 1e-9);
  assert.equal(parseMaxspeed("none"), undefined);
  assert.equal(parseMaxspeed("RU:urban"), undefined);
});

test("picks the nearest tagged road", () => {
  const ways = [
    { tags: { maxspeed: "65 mph" }, center: { lat: 39.75, lon: -104.99 } },
    { tags: { maxspeed: "25 mph" }, center: { lat: 39.7401, lon: -104.9901 } },
  ];
  assert.equal(pickLimit(ways, 39.74, -104.99), mph(25));
});

test("answers from cache and fetches in the background", async () => {
  let calls = 0;
  const provider = new OsmSpeedLimits(async () => {
    calls++;
    return { ok: true, json: async () => ({ elements: [{ tags: { maxspeed: "30 mph" }, center: { lat: 39.74, lon: -104.99 } }] }) };
  });
  assert.equal(provider.current(39.74, -104.99), undefined, "first call: not loaded yet");
  await provider.load(provider.key(39.74, -104.99), 39.74, -104.99);
  assert.equal(provider.current(39.74, -104.99), mph(30));
  assert.equal(calls, 1);
});
