// The phone's built-in voice. Kokoro (from EpubToM4B) replaces this in the next PR; it
// implements the same Speaker interface.
import * as Speech from "expo-speech";
import type { Speaker } from "./speechQueue";

export const systemSpeaker: Speaker = {
  speak: (text, { rate }) =>
    new Promise<void>((resolve) => {
      Speech.speak(text, { rate, onDone: resolve, onStopped: resolve, onError: () => resolve() });
    }),
  stop: () => void Speech.stop(),
};
