import { test } from "node:test";
import assert from "node:assert/strict";
import { CritiqueEngine, seededRng } from "../src/engine.ts";
import { LlmLineSource, buildPrompt, validateLine, type Generate } from "../src/llm.ts";
import { fromDisplay } from "../src/units.ts";

const mph = (v: number) => fromDisplay(v, "mph");

test("validator keeps good lines and strips list markers", () => {
  assert.equal(validateLine("speeding.barely", '1. "{speed}? In a {limit}? Who raised you?"'), "{speed}? In a {limit}? Who raised you?");
});

test("validator rejects made-up numbers, wrong placeholders and refusals", () => {
  assert.equal(validateLine("speeding.barely", "You're doing 55 in a 50!"), undefined);
  assert.equal(validateLine("hardBraking", "Take {alternate} next time."), undefined);
  assert.equal(validateLine("speeding.barely", "{speed in a {limit}"), undefined);
  assert.equal(validateLine("rerouted", "As an AI language model, I cannot judge."), undefined);
});

test("prompt names the placeholders and the mood", () => {
  const p = buildPrompt("traffic", 2, 4, []);
  assert.match(p.user, /\{alternate\}/);
  assert.match(p.user, /unhinged/);
  assert.match(p.system, /Never write digits/);
});

test("engine speaks LLM lines when ready, canned lines otherwise", async () => {
  const generate: Generate = async () =>
    ["{speed} in a {limit}. I'm telling your mother.", "You're doing 99!", "The number on the sign is {limit}. Read it."].join("\n");
  const source = new LlmLineSource(generate, { target: 2 });
  const engine = new CritiqueEngine({ rng: seededRng(1), lineSource: source });
  engine.onNav({ type: "destinationSet", t: -1, name: "work" });

  // Pool is empty: canned line.
  const [first] = [
    ...engine.onTelemetry({ t: 0, speedMps: mph(50), speedLimitMps: mph(50) }),
    ...engine.onTelemetry({ t: 1000, speedMps: mph(51), speedLimitMps: mph(50) }),
  ];
  assert.ok(first);

  await source.refill([{ key: "speeding.still", tier: 0 }]);
  assert.equal(source.available("speeding.still", 0), 2, "the line with a literal number was dropped");

  const later = [];
  for (let t = 2000; t <= 21_000; t += 1000) later.push(...engine.onTelemetry({ t, speedMps: mph(51), speedLimitMps: mph(50) }));
  assert.equal(later.at(-1)?.text, "51 in a 50. I'm telling your mother.");
});

test("a dead or slow model never breaks anything", async () => {
  const source = new LlmLineSource(async () => {
    throw new Error("model not loaded");
  });
  assert.equal(await source.refill(), 0);
  assert.equal(source.take("hardBraking", 0), undefined);
});
