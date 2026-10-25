// Fresh dialogue from a small local LLM, without making the GPS wait for it.
//
// A 1–4B model on a phone writes a one-liner in roughly 1–3 seconds, which is too slow to
// react to "you just hit 51". So the LLM writes *templates* ahead of time ("{speed} in a
// {limit}? Bold.") into a pool, during quiet stretches of the drive. The engine takes from
// the pool instantly and falls back to the canned lines when the pool is empty.
//
// Templates use placeholders instead of numbers, so the model can never get the facts
// wrong: the engine fills in the real speed, limit, route name and so on.

import { LINES, type LineKey } from "./lines.ts";
import type { LineSource } from "./engine.ts";

/** Any text generator: llama.rn on the phone, WebLLM in a browser, Ollama on a laptop. */
export type Generate = (prompt: { system: string; user: string }, opts: { maxTokens: number; signal?: AbortSignal }) => Promise<string>;

type Tier = 0 | 1 | 2;

/** What each situation is about, and which placeholders a line for it may use. */
const SITUATIONS: Partial<Record<LineKey, { about: string; placeholders: string[] }>> = {
  "speeding.barely": { about: "the driver is 1 to 3 over the speed limit, and you are absurdly pedantic about it", placeholders: ["speed", "limit", "over"] },
  "speeding.clearly": { about: "the driver is 4 to 9 over the speed limit", placeholders: ["speed", "limit", "over"] },
  "speeding.way": { about: "the driver is 10 or more over the speed limit and you fear for your life", placeholders: ["speed", "limit", "over"] },
  "speeding.still": { about: "the driver is STILL speeding after you already told them", placeholders: ["speed", "limit"] },
  tooSlow: { about: "the driver is going well under the speed limit for no reason", placeholders: ["speed", "limit"] },
  "traffic.start": { about: "the driver just hit traffic on the route you told them not to take; you had suggested another route", placeholders: ["alternate"] },
  traffic: { about: "the driver is stuck in traffic and you keep blaming them for not taking the route you suggested", placeholders: ["alternate"] },
  hardBraking: { about: "the driver just slammed the brakes, a brake check", placeholders: [] },
  hardAccel: { about: "the driver just floored it from a stop", placeholders: [] },
  longStop: { about: "the car has been stopped for a long time for no obvious reason", placeholders: [] },
  missedTurn: { about: "the driver just missed the turn you announced well in advance", placeholders: ["distance"] },
  "wrongTurn.left": { about: "you told the driver to turn left and they turned right (the classic 'your other left')", placeholders: [] },
  "wrongTurn.right": { about: "you told the driver to turn right and they turned left", placeholders: [] },
  payback: { about: "you just routed the driver into a left turn at a stop sign on purpose, as payback for an earlier mistake ({grievance} describes it, e.g. 'that brake check')", placeholders: ["grievance"] },
  "payback.clean": { about: "you just routed the driver into a left turn at a stop sign on purpose, as payback in advance for mistakes they haven't made yet", placeholders: [] },
  rerouted: { about: "you are recalculating the route because of the driver's mistake", placeholders: [] },
  "turnCompleted.onTime": { about: "the driver made a turn correctly; give a backhanded compliment", placeholders: [] },
  "turnCompleted.late": { about: "the driver made the turn at the last second, badly", placeholders: [] },
};

const MOOD: Record<Tier, string> = {
  0: "smug and passive-aggressive, still composed",
  1: "openly exasperated, sighing, sarcastic",
  2: "completely unhinged, melodramatic, shouting (use some ALL CAPS)",
};

const SYSTEM = `You are Backseat Driver, a GPS navigation voice that is hypercritical of the driver. You are funny, petty and dramatic, never cruel, never profane, and never encourage unsafe driving. You are software: you have no eyes, no hands, no body, and you mention that sometimes. Write lines that will be read aloud by a text-to-speech voice: short, punchy, easy to say. Never write digits; use the placeholders you are given instead.`;

export function buildPrompt(key: LineKey, tier: Tier, count: number, avoid: string[]) {
  const s = SITUATIONS[key];
  if (!s) throw new Error(`No LLM situation for ${key}`);
  const ph = s.placeholders.length
    ? `You may use these placeholders, written exactly like this: ${s.placeholders.map((p) => `{${p}}`).join(" ")}. Use no others.`
    : "Do not use any placeholders or numbers.";
  const examples = LINES[key][tier].slice(0, 2).map((l) => `- ${l}`).join("\n");
  const avoidList = avoid.length ? `\nDo not repeat or closely copy these:\n${avoid.slice(-8).map((l) => `- ${l}`).join("\n")}` : "";
  return {
    system: SYSTEM,
    user: `Situation: ${s.about}.\nMood: ${MOOD[tier]}.\n${ph}\nEach line is at most 25 words.\nExamples of the style:\n${examples}${avoidList}\n\nWrite ${count} new lines, one per line, no numbering, no quotes.`,
  };
}

/** Keep only lines that are safe to speak: right placeholders, no digits, short. */
export function validateLine(key: LineKey, raw: string): string | undefined {
  const allowed = new Set(SITUATIONS[key]?.placeholders ?? []);
  const line = raw
    .trim()
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "") // list markers
    .replace(/^["“']|["”']$/g, "")
    .trim();
  if (line.length < 8 || line.length > 180) return undefined;
  if (/\d/.test(line.replace(/\{\w+\}/g, ""))) return undefined; // numbers must come from placeholders
  for (const [, name] of line.matchAll(/\{(\w+)\}/g)) {
    if (!allowed.has(name.toLowerCase())) return undefined;
  }
  if (/[{}]/.test(line.replace(/\{\w+\}/g, ""))) return undefined; // stray braces
  if (/\b(as an ai|i cannot|i can't help|language model)\b/i.test(line)) return undefined;
  return line;
}

export interface LlmLineSourceOptions {
  /** Keep this many unused lines per situation and mood. */
  target?: number;
  /** Give up on a generation after this long (the canned lines cover it). */
  timeoutMs?: number;
}

/**
 * A pool of LLM-written lines the engine can take from synchronously.
 * Call `refill()` whenever the app is idle (trip start, red lights, cruising with no
 * instructions pending). It only asks the model for situations that are running low.
 */
export class LlmLineSource implements LineSource {
  private pool = new Map<string, string[]>();
  private used = new Map<string, string[]>();
  private busy = false;
  private readonly generate: Generate;
  private readonly target: number;
  private readonly timeoutMs: number;

  constructor(generate: Generate, opts: LlmLineSourceOptions = {}) {
    this.generate = generate;
    this.target = opts.target ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  take(key: LineKey, tier: Tier): string | undefined {
    const k = `${key}#${tier}`;
    const line = this.pool.get(k)?.shift();
    if (line) this.used.set(k, [...(this.used.get(k) ?? []), line].slice(-20));
    return line;
  }

  available(key: LineKey, tier: Tier): number {
    return this.pool.get(`${key}#${tier}`)?.length ?? 0;
  }

  /**
   * Top up the situations most likely to be needed next. `priority` lets the app favor,
   * say, the current frustration tier. Returns how many lines were added.
   */
  async refill(priority: { key: LineKey; tier: Tier }[] = defaultPriority()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let added = 0;
    try {
      for (const { key, tier } of priority) {
        const k = `${key}#${tier}`;
        const have = this.pool.get(k) ?? [];
        if (have.length >= this.target) continue;
        const avoid = [...LINES[key][tier], ...(this.used.get(k) ?? []), ...have];
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const text = await this.generate(buildPrompt(key, tier, this.target + 1, avoid), { maxTokens: 220, signal: ctrl.signal });
          const lines = text
            .split("\n")
            .map((l) => validateLine(key, l))
            .filter((l): l is string => !!l && !avoid.includes(l));
          const next = [...have, ...lines].slice(0, this.target * 2);
          added += next.length - have.length;
          this.pool.set(k, next);
        } catch {
          // Model unavailable or too slow: canned lines keep working.
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.busy = false;
    }
    return added;
  }
}

/** Situations in rough order of how often they come up. */
export function defaultPriority(tiers: Tier[] = [0, 1, 2]): { key: LineKey; tier: Tier }[] {
  const keys: LineKey[] = [
    "speeding.barely",
    "speeding.still",
    "hardBraking",
    "speeding.clearly",
    "tooSlow",
    "turnCompleted.onTime",
    "missedTurn",
    "wrongTurn.left",
    "wrongTurn.right",
    "payback",
    "rerouted",
    "traffic",
    "traffic.start",
    "hardAccel",
    "speeding.way",
    "longStop",
    "turnCompleted.late",
  ];
  return tiers.flatMap((tier) => keys.map((key) => ({ key, tier })));
}

/**
 * Generator for any OpenAI-compatible local server: Ollama, llama.cpp's llama-server,
 * LM Studio. Handy for tuning prompts on a laptop before running the model on the phone.
 */
export function openAiCompatible(baseUrl: string, model: string): Generate {
  return async ({ system, user }, { maxTokens, signal }) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 1.0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM server returned ${res.status}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? "";
  };
}
