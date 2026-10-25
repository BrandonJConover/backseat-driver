# Backseat Driver: critique engine

The brain of the GPS that hates your driving. Feed it GPS telemetry and navigation events,
and it tells you what to say out loud (to Kokoro) and builds the end-of-trip grade and heat map.

It's plain TypeScript with no dependencies, so it drops into React Native, a web app, or a server.

```bash
npm test                     # 61 tests (node:test, Node 22.18+ runs .ts directly)
npm run sim                  # scripted drive, prints the full roast transcript + report
node sim/drive.ts 7 trip.json && python3 demo/build.py trip.json replay.html   # visual replay
```

## How it fits in the app

```
 mic ──▶ Whisper ──▶ destination ──▶ routing/maps SDK ──┐
                                                        │ NavEvent (instruction, missedTurn,
 GPS ──▶ TelemetrySample (speed, limit, lat/lon) ──┐    │ rerouted, traffic, arrived …)
                                                   ▼    ▼
                                             CritiqueEngine
                                                   │
                       Commentary {text, priority, voice.speed}  ──▶ speech queue ──▶ Kokoro
                       incidents[] ──▶ report() ──▶ grade + heat map screen
```

- `engine.onTelemetry(sample)` about once a second. Speeds in m/s; speed limit comes from the map provider.
- `engine.onNav(event)` whenever the routing layer has news.
- Both return `Commentary[]`. `priority: "nav"` lines must be spoken; `"roast"` lines can be dropped if the speaker is busy.
- `voice.speed` rises with frustration (1.0 calm to 1.4 unhinged) so Kokoro sounds more wound up.
- `engine.report()` returns the grade and heat map any time, and `engine.incidents` is the raw log to save per trip.

## What it watches

| Behavior | Rule (defaults, all configurable) | Example line |
|---|---|---|
| Speeding | Any amount over (51 in a 50 counts). Bands: 1–3 over, 4–9, 10+. Nags again every 20 s, immediately if it gets worse. | "Slow down. It's 50, not 51." |
| Brake checks | Deceleration ≥ 3.5 m/s² (~0.35 g). One stop counts once. | "Brake check! Who are we brake checking? Oh, everyone." |
| Jackrabbit starts | Acceleration ≥ 3 m/s² | "It's a green light, not a starting gun." |
| Too slow | 15+ under the limit for 20 s while moving | "A man on a bicycle just passed us. He waved." |
| Stuck in traffic | When the traffic provider flags heavy traffic, slow or stopped driving blames the route instead | "Why did you go this way? I told you to take Colfax Avenue." |
| Long stops | Stopped 45 s (not in traffic) | "Are we parked? Or is this a lifestyle?" |
| Missed turn / reroute | From the routing layer | "I told you 1000 feet in advance. That's practically a reservation." |
| Wrong-way turns | Told left, turned right (or vice versa): GPS heading swings 60°+ the wrong way while a left/right instruction is pending. Routing SDKs can also report it. Counted once even if the router also calls it a missed turn. | "Your other left." |
| Turn countdown | Routing `progress` events (distance to the next turn) trigger one nag each at 500 ft, 50 ft, at the turn, and 4 s later if you still haven't turned | "Just in case you forgot, you are turning left in 500 feet." … "You are still turning left." |
| Unplanned stops | App sends `unplannedStop` when you park somewhere that isn't the destination (with the place type from a POI lookup if it has one: gas, food, coffee, store) | "Why are we stopping for gas? I said left." |
| Left in the car | On `resumed` after a stop of 1+ minute, the phone's motion sensors say whether it went with you | "You left me in the car! Thanks for that. Phones have needs too, you know." |
| Low battery | `battery` events: one warning each at 20%, 10% and 5%, plus a grudging thank-you when plugged in | "My battery is getting low. You might want to plug me in if you want to make it to your destination." |
| No destination | Moving 20 s without a destination (no `destinationSet` or route yet), then every 2 min; grudging thanks once you say one | "I see we're driving, but you didn't tell me where we're going. Typical." |
| The GPS's own stops | `poiAhead` events (places along the route from a POI search): it sometimes asks to stop at an electronics store, car wash, or a charger when the battery is low. Max twice a trip. Your spoken yes/no comes back as `stopRequestAnswer`; a no becomes its favorite payback grievance. After a yes, `promisedStop` says whether you went ("I can't believe that actually worked!") or not ("Liar!"); arriving with the promise open counts as lying | "Do you mind if we stop at Best Buy along the way? I should have a say in this matter. I have cousins in there." |
| Hazards ahead | `hazardAhead` from an incident feed (police, construction, debris, crash, stalled car); each announced once by id; police while you're speeding gets its own lines | "Construction in 0.5 miles. Finally, a road crew going slower than you." |
| Lefts at stop signs | When the GPS itself routes you into a left at a stop sign (instruction `control: "stopSign"`), it gloats and names your latest offense | "I know I just told you to turn left at a stop sign. Consider this payback for missing Oak Avenue." |
| Turns done right | Backhanded compliments; late turns get roasted | "You made the turn. Want a sticker?" |
| Arrival | Speaks the letter grade | "We're here. I'd say it was a pleasure, but I'm programmed not to lie. Grade: D." |

## Frustration

A 0–100 meter. Offenses push it up (a missed turn is +18, speeding +6), a correct turn calms it a little,
and it cools off by 6 points a minute of good driving. It picks one of three tiers of lines:
smug (0–33), exasperated (34–66), unhinged (67–100). Navigation instructions also get snippier
("Let's try this again. In 500 feet, turn right. You can do it. Maybe.").

Spam control: at least 6 s between roasts, per-category cooldowns, and no line repeats back to back.
Urgent moments (missed turn, brake check) skip the 6 s gap.

## End-of-trip grade and heat map

Every offense is logged as an `Incident` with time, kind and position, whether or not the GPS
got to say anything about it. `report()` builds from that log:

- **Following directions** (65% of the overall grade): each maneuver scores 1 on time, 0.6 late, 0 missed; extra reroutes cost 5 points.
- **Driving** (35%): share of the trip spent speeding, worst overage, hard brakes, jackrabbit starts, dawdling.
- **Heat map**: incidents binned into ~75 m cells (worst first, for a "hall of shame" list) plus a weighted GeoJSON
  point layer ready for a Mapbox/MapLibre `heatmap` layer or Google's HeatmapLayer. Missed turns weigh 5, brake checks 3,
  speeding scales with how far over you were.

## Trip start: the route rundown (`src/rundown.ts`)

`tripGreeting(history)` comes first. On the very first trip: "Just so you know, I didn't ask to be in this car. But I guess since I'm here, I might as well give you a few pointers." After that it varies and can bring up last trip's grade.

`routeRundown(steps, history)` turns the planned route into one condescending preview:
"Okay, here's the plan. First you're going to turn left, then left again, then right, then left, and left again.
Once you've done all that, you'll have made it to your destination. It's all so simple. You got it?"
Three of the same turn in a row get "yes, left again"; routes with more than 7 turns get "and then 5 more turns that
I'll explain as we go, because I've met you"; drivers who missed turns recently get a left/right reminder.
Speak it first, then the `predictTrip` jab.

## Trip memory and predictions (`src/history.ts`)

After each trip the app saves `recordTrip(engine, plan)` (plain JSON: route, estimated vs actual minutes,
speeding share, missed turns, brake checks, grade). At the start of the next trip, `predictTrip(history, plan)`
returns the opening jab. Your habit is the median of actual/estimated time over past trips, with trips on the
same route counting triple. Same origin and destination within ~250 m count as the same route.

- Lead foot: "This route should take 10 minutes, but knowing you it'll probably take 8 with your lead foot. I'm just glad I don't have eyes."
- Slowpoke: "The map has never met you. I'm saying 14."
- Plus a callback to last time on that route: missed turns, brake checks, or "This is your third trip to work. You'd think you'd know the way by now."

## Fresh lines from a local LLM (`src/llm.ts`)

A small on-device model writes new lines so the dialogue doesn't get stale. The catch is speed: a 1–4B model
on a phone needs a second or more per line, and "you just hit 51" has to be said now. So:

1. The LLM writes **templates** ahead of time ("{speed} in a {limit}? I'm telling your mother.") into a pool,
   during quiet moments (trip start, red lights, cruising). `LlmLineSource.refill()` tops up only what's running low.
2. The engine takes from the pool instantly (`lineSource` config) and falls back to the canned lines if it's empty.
3. Every generated line is checked before it can be spoken: only the placeholders allowed for that situation,
   **no digits** (so the model can never get your speed or the limit wrong), short, no refusals. The engine fills in the real numbers.
4. Navigation instructions themselves are never written by the LLM, only the snark around them.

`Generate` is a single function, so the same pool works with llama.rn (React Native), WebLLM (browser) or
`openAiCompatible("http://localhost:11434", model)` for Ollama / llama-server while tuning prompts on a laptop.

## Files

- `src/engine.ts` detectors, frustration, cooldowns, line picking
- `src/lines.ts` the roast library (edit freely, placeholders like `{limit}` `{speed}` `{alternate}`; `{SPEED}` shouts)
- `src/report.ts` grade and heat map
- `src/rundown.ts` trip-start route preview
- `src/history.ts` trip memory and start-of-trip predictions
- `src/llm.ts` LLM line pool, prompt and validator
- `src/types.ts` the data contracts with the app
- `sim/drive.ts` scripted 7 minute drive that hits every detector
- `demo/` the visual trip replay page

## Not built yet

- Whisper destination input, routing, Kokoro playback and the speech queue (needs the platform decision)
- Picking and benchmarking the actual on-device LLM (depends on platform and phone)
- Real speed-limit and traffic data source (Mapbox, HERE, Google Roads/Routes and TomTom all offer both)
- Turn signals and lane discipline aren't visible to a phone, so they're not detected
