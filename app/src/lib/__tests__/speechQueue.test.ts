import { test } from "node:test";
import assert from "node:assert/strict";
import type { Commentary } from "@backseat/engine";
import { SpeechQueue, type Speaker } from "../speechQueue.ts";

const line = (text: string, priority: "nav" | "roast"): Commentary => ({ t: 0, category: "instruction", text, frustration: 0, priority, voice: { speed: 1 } });

function fakeSpeaker() {
  const spoken: string[] = [];
  let release: (() => void) | undefined;
  const speaker: Speaker = {
    speak: (text) => {
      spoken.push(text);
      return new Promise<void>((r) => (release = r));
    },
    stop: () => {},
  };
  return { speaker, spoken, finish: () => release?.() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("nav lines all get spoken in order; only the newest roast survives", async () => {
  const { speaker, spoken, finish } = fakeSpeaker();
  const q = new SpeechQueue(speaker);
  q.push([line("nav 1", "nav")]);
  q.push([line("roast A", "roast"), line("nav 2", "nav"), line("roast B", "roast")]);
  for (let i = 0; i < 4; i++) {
    await tick();
    finish();
  }
  await tick();
  assert.deepEqual(spoken, ["nav 1", "nav 2", "roast B"]);
});

test("stale roasts are dropped", async () => {
  let now = 0;
  const { speaker, spoken, finish } = fakeSpeaker();
  const q = new SpeechQueue(speaker, { now: () => now, maxRoastAgeMs: 5000 });
  q.push([line("long nav", "nav"), line("old roast", "roast")]);
  now = 10_000;
  await tick();
  finish();
  await tick();
  assert.deepEqual(spoken, ["long nav"]);
});
