// The Maps key is inlined at build time from EXPO_PUBLIC_GOOGLE_MAPS_API_KEY (see .env.example).
// The native SDKs get theirs from GOOGLE_MAPS_API_KEY via plugins/withGoogleNavigation.js.
export const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
