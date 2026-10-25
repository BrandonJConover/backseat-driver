// One voice, many things to say. Navigation lines always get spoken, in order; roasts are
// nice-to-have, so stale ones are dropped and only the newest waiting roast is kept.
// The Speaker is the actual voice: the phone's built-in TTS now, Kokoro later.

import type { Commentary } from "@backseat/engine";

export interface Speaker {
  speak(text: string, opts: { rate: number }): Promise<void>;
  stop(): void;
}

export interface SpeechQueueOptions {
  /** Drop a roast that has waited longer than this. */
  maxRoastAgeMs?: number;
  now?: () => number;
}

interface Item {
  c: Commentary;
  queuedAt: number;
}

export class SpeechQueue {
  private nav: Item[] = [];
  private roast?: Item;
  private speaking = false;
  private readonly maxRoastAgeMs: number;
  private readonly now: () => number;
  private readonly speaker: Speaker;
  /** Called with each line as it starts, for the on-screen caption. */
  onSpeak?: (c: Commentary) => void;

  constructor(speaker: Speaker, opts: SpeechQueueOptions = {}) {
    this.speaker = speaker;
    this.maxRoastAgeMs = opts.maxRoastAgeMs ?? 8_000;
    this.now = opts.now ?? Date.now;
  }

  push(lines: Commentary[]) {
    for (const c of lines) {
      const item = { c, queuedAt: this.now() };
      if (c.priority === "nav") this.nav.push(item);
      else this.roast = item; // newest roast wins
    }
    void this.pump();
  }

  clear() {
    this.nav = [];
    this.roast = undefined;
    this.speaker.stop();
  }

  /** What would be spoken next, without speaking it. */
  next(): Commentary | undefined {
    if (this.nav.length) return this.nav[0].c;
    if (this.roast && this.now() - this.roast.queuedAt <= this.maxRoastAgeMs) return this.roast.c;
    return undefined;
  }

  private async pump() {
    if (this.speaking) return;
    this.speaking = true;
    try {
      for (;;) {
        let item = this.nav.shift();
        if (!item && this.roast) {
          item = this.roast;
          this.roast = undefined;
          if (this.now() - item.queuedAt > this.maxRoastAgeMs) continue;
        }
        if (!item) break;
        this.onSpeak?.(item.c);
        try {
          await this.speaker.speak(item.c.text, { rate: item.c.voice.speed });
        } catch {
          // A failed utterance shouldn't jam the queue.
        }
      }
    } finally {
      this.speaking = false;
    }
  }
}
