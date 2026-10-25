import { useColorScheme } from "react-native";

const light = {
  bg: "#eef0ee",
  panel: "#ffffff",
  ink: "#1d2320",
  muted: "#5d6762",
  line: "#d5dad7",
  accent: "#1f6f5c",
  roast: "#b8361f",
};
const dark: typeof light = {
  bg: "#141816",
  panel: "#1c211f",
  ink: "#e6ebe8",
  muted: "#94a09a",
  line: "#2e3532",
  accent: "#58c3a6",
  roast: "#ff7b5f",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
