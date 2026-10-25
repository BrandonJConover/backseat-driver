# backseat-driver

A GPS that talks back. Google Maps does the navigating; Backseat Driver does the judging.

It watches your speed (51 in a 50 counts), braking, turns and stops, and roasts you out loud
with a frustration meter that makes it angrier the worse you drive. At the end of the trip
you get a grade and a hall of shame.

## Layout

| Folder | What it is |
|---|---|
| [`engine/`](engine/README.md) | The critique engine: plain TypeScript, no dependencies. Detectors, roast lines, frustration, trip grade, heat map, trip memory, local-LLM line pool. Fully unit-tested. |
| `app/` | The Expo (React Native) app. Google's Navigation SDK for maps and turn-by-turn, the engine for commentary, saved destinations, trip reports. |

## Running the app

The app uses native modules (Google Navigation SDK), so it needs a development build, not Expo Go.

1. Create a Google Maps Platform key with **Navigation SDK**, **Maps SDK for Android**, **Maps SDK for iOS**
   and **Places API (New)** enabled. Google requires a billing account on the project, but personal use
   stays inside the free monthly caps (see [Data sources](#data-sources)). To make sure you never get a
   bill, set daily quotas in the Cloud Console (APIs & Services → each API → Quotas), for example
   30 navigation requests and 150 Places searches a day.
2. `cp app/.env.example app/.env.local` and fill in both variables (the same key works for both).
3. From the repo root: `npm install`
4. `cd app && npx expo run:ios` or `npx expo run:android` (or `npx eas-cli@latest build --profile development`).

To try it without driving: long-press a destination on the home screen. Google's simulator drives the
route at 3x speed and the GPS roasts the simulated you.

## Development

```bash
npm install
npm test          # engine + app logic tests (Node 22.18+)
npm run typecheck
npm run sim -w engine   # print a full simulated trip transcript
```

## Data sources

Everything has to stay free. This app is a reskin on top of existing map data, so it only uses free
sources or free tiers.

| What | Source | Cost |
|---|---|---|
| Map, turns, reroutes, arrival, location | Google Navigation SDK | Free up to 1,000 trips a month |
| Destination search | Google Places API (New) Text Search | Free up to 5,000 a month; saved destinations skip it |
| "What did we stop at" | Google Places API (New) Nearby Search | Free up to 5,000 a month; only on unplanned stops |
| Speed limits | OpenStreetMap via Overpass (Google doesn't give apps the posted limit) | Free |
| Voice | The phone's built-in voice now; Kokoro next (EpubToM4B's port on iOS, sherpa-onnx on Android) | Free, on device |

Planned: construction and crashes from TomTom's free tier and state 511 open-data feeds, road
closures and construction tags from OpenStreetMap, and police as voice reports from the driver
(Waze's police data is partner-only).

Free caps are from [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) as of October 2026.
