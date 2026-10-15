---
name: ambree-mauritius
description: Plan and re-plan days in Mauritius with Ambree's MCP tools (verified places, the live forecast, cyclone alerts and weather-aware re-planning). Use it whenever a traveller in Mauritius asks where to go, what the weather is doing, or what to do instead because of rain, wind or heat.
---

# Ambree: Mauritius travel tools

Ambree is a Mauritius travel guide. Its MCP server gives you four read-only tools backed by a verified
places dataset and live public feeds (MET Norway forecasts, GDACS cyclone alerts).

## Connect

- URL: `https://alexa.ambree.ai/mcp`
- Transport: Streamable HTTP, stateless, protocol version 2025-11-25. No authentication.
- Claude Code: `claude mcp add --transport http ambree https://alexa.ambree.ai/mcp`

## Which tool, when

| The traveller says | Call | Notes |
|---|---|---|
| "It's raining, what now?", "Re-plan my afternoon", "Too windy for the boat" | `replan_day` | The headline tool. Pass `area`, `window` (morning, afternoon, evening, rest_of_day), `reported_weather` (rain, dry, wind, heat) and their `plan` if you know it. |
| "What's the weather in Flic en Flac?", "Will it rain?" | `weather_now` | Hourly forecast for 3 to 12 hours, rain timing, and any cyclone alert near the island. |
| "Find a covered market near Port Louis", "Any museums?" | `find_places` | Filter by `area`, `kind`, `rain_ok` (true for indoor or covered) and a short `query`. |
| "Tell me about the Blue Penny Museum" | `place_details` | The full verified record: what it is, how long to allow, whether it works in the rain, its source. |

Areas can be named loosely: "Mahebourg", "Mahébourg" and "Blue Bay" all work, and so do small typos.

## How to answer

- **Read `speech` aloud as it is.** Every successful result has a `speech` field of at most 2 sentences,
  written for the ear. On a voice device, it is the whole answer.
- **Recommend only places the tools return.** They come from Ambree's verified dataset; don't add others
  from memory.
- **Trust the traveller about rain.** If they say it's raining, pass `reported_weather: "rain"`, even when
  the forecast looks dry.
- **Cyclones.** When `replan_day` returns `decision: "stay_safe"`, say only what its speech says: stay put
  and follow the official cyclone bulletins from the Mauritius Meteorological Services.
- **Feeds can be down.** If `status` is `"unavailable"`, say so briefly; `replan_day` then decides from
  what the traveller reported.
- **Errors.** A result with `isError: true` has a short, readable message (for example, a list of known
  areas). Fix the argument and try once more, or read the message to the traveller.
- Travel times are approximate ("about 20 minutes") and measured from the area's centre.

## Credit

Weather: Data from MET Norway (CC BY 4.0). Cyclone alerts: GDACS. Each weather result carries this in
`attribution`.
