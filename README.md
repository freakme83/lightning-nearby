# Lightning Nearby

A privacy-conscious progressive web app for local lightning awareness and short-term thunderstorm risk.

Milestone 1 combines a user-approved location, a local 24-hour thunderstorm outlook, and a qualitative hourly risk display. Live lightning detection and notifications are future milestones.

The project is intended for informational and hobby use only. It is not an official severe-weather warning system.

---

## Project Goals

Lightning Nearby should answer two simple questions:

1. **Is there a meaningful lightning / thunderstorm risk near my location in the next 24 hours?**
2. **Is lightning activity currently occurring near my monitored location?**

The long-term goal is to combine forecast data with live lightning observations in a simple mobile-first interface.

Example:

> Thunderstorm risk increases tomorrow between 16:00 and 20:00.  
> Highest risk around 18:00.

Later, when live strike data is integrated:

> ⚡ Lightning activity detected nearby  
> 7 strikes were detected within 20 km during the last 10 minutes.  
> Nearest detected strike: 6.4 km.

---

## Initial MVP

The first version should remain deliberately small.

### Included

- Progressive Web App
- Mobile-first interface
- User-selected location by browser geolocation, place search, or map point
- Ability to save one monitored location
- Location stored locally on the device
- 24-hour hourly weather forecast
- Thunderstorm / lightning risk timeline
- Highlighted highest-risk period
- Basic installability on iOS and Android
- Graceful handling of denied location permission
- Informational disclaimer

### Not included yet

- User accounts
- Cloud-synced locations
- Background location tracking
- Web Push notifications
- Blitzortung live lightning integration
- Native iOS / Android apps
- Paid features
- Advertising

---

## Forecast Data

The initial forecast provider is **Open-Meteo’s generic Weather Forecast API**, requested directly by the browser at `https://api.open-meteo.com/v1/forecast` (see [Open-Meteo](https://open-meteo.com/) for provider information). It uses Open-Meteo’s Best Match model selection for global coverage, `timezone=auto`, `timeformat=unixtime`, and a 48-hour hourly response so the app can select the next 24 chronological hourly buckets in the returned location timezone. No API key or backend is used.

Milestone 1 requests these hourly fields:

- `weather_code` (WMO code)
- `precipitation_probability` (upstream precipitation probability)
- `cape` (J/kg)
- `convective_inhibition` (J/kg)
- `thunderstorm_probability` (used only if a selected model provides a value)

Open-Meteo defines precipitation probability for the preceding hour; the classifier compares it with instability and other values at the matching hourly timestamp. Direct thunderstorm probability is model-limited and is often absent near Ankara. Direct thunderstorm weather codes 95, 96, 97, and 99 are treated as High in the deterministic classifier. The UI distinguishes provider probability, ensemble member support, and derived qualitative risk.

The ensemble request asks only for `weather_code` at `https://ensemble-api.open-meteo.com/v1/ensemble`, with `forecast_hours=26`, `past_hours=1`, `timeformat=unixtime`, and `cell_selection=nearest`. It prefers `icon_eu_eps` within its broad European footprint, including Ankara, and uses `icon_global_eps` elsewhere or on a regional miss. [Open-Meteo's Ensemble API documentation](https://open-meteo.com/en/docs/ensemble-api) gives approximately **13 km** ICON-EU EPS and **26 km** global ICON EPS grids and supports comma-separated coordinate lists. Exact-point/exact-hour thunderstorm codes can miss nearby, slightly displaced convection: Barcelona testing on 29 September 2026 showed a deterministic thunderstorm code alongside zero exact-point member support. This is a regression case, not hard-coded weather data.

For each model, one batched request samples the monitored point plus north, south, east, and west points, each approximately **one model grid spacing** away (13 or 26 km). Each target hour examines the same ensemble member across these five points at **target hour ±1 hour**. A member with any usable weather code in that window enters the denominator once; one or many codes 95, 96, 97, or 99 make it a supporting member once. Missing values and missing sample points are not negative votes. The control `weather_code` and numbered member series retain their identities across points. Exact Unix timestamps align the forecasts across midnight. This is a local model-support indicator, **not a calibrated thunderstorm probability**, and it is not displayed as a raw member fraction in the ordinary UI.

Each hour retains provider-supplied `thunderstorm_probability`, deterministic fields, and local ensemble support separately. An explicit deterministic thunderstorm code remains **High** regardless of zero ensemble support or a conflicting low provider value; the provider percentage still appears as its own value in selected-hour details. The qualitative Low/Elevated/High level comes only from the provider probability, deterministic thunderstorm code, or existing CAPE + precipitation rule. Ensemble support is secondary evidence: even a positive member count cannot promote Low or an unavailable qualitative hour to Elevated. Zero support cannot lower deterministic evidence or become a zero-probability claim. Ensemble-only data retains its evidence but cannot establish a qualitative level. If no qualitative source is usable, the page reports the forecast unavailable. The strongest period uses the highest qualitative level and then the longest contiguous run, without ranking member fractions as probabilities.

The app fetches the five-point neighborhood once per saved-location load/refresh and derives all hourly windows locally. A failed regional batch can retry the regional center, then the global batch; the requests fail independently of the deterministic forecast. The normalized result records how many locations actually returned usable data; center-only fallback has a zero spatial window. There is no polling, per-interaction refetch, backend, or persistent forecast cache. A 27-hour five-point Barcelona probe returned about 28 KB of JSON (3.4 KB compressed) in one request; size and latency vary. Open-Meteo weights usage by factors including the number of locations, so this costs more than one exact-point query even though it is one HTTP request. A small neighborhood and ±1 hour can still miss, or shift the apparent timing of, local convection; it is a qualitative aid rather than a measured event probability. [Lightning-density verification](./docs/lightning-density-verification.md) records why the ECMWF field was deferred.

The risk classifier is intentionally simple and conservative:

- WMO thunderstorm codes 95, 96, 97, or 99 → **High**.
- When a provider-supplied `thunderstorm_probability` is available, 20–49 → **Elevated**, 50 or more → **High**, and below 20 → **Low**. The direct value blocks the weaker CAPE + precipitation fallback; its percentage remains an upstream value, while these are app classification cutoffs.
- Only when direct thunderstorm probability is unavailable, CAPE of at least 700 J/kg together with precipitation probability of at least 40% → **Elevated**.
- Otherwise → **Low** when sufficient deterministic inputs exist. Precipitation or CAPE alone never raises the level; missing required inputs are unavailable.

The thresholds are qualitative product heuristics, not a calibrated risk probability or official warning. They are grouped in `src/lib/weather.ts` for easy replacement. `cape` and `convective_inhibition` (CIN) remain internal forecast ingredients; CIN does not affect classification because availability varies by model and this small heuristic has no model-independent CIN cutoff. The UI omits these technical fields. Weather-provider parsing, normalized forecast data, time selection, and the classifier are separate from presentation logic.

---

## Milestone 1 Implementation

The app is a small Next.js / TypeScript PWA with a native web manifest and service worker. The service worker may cache the app shell for reopening offline, but does not cache weather responses. With no network, the app reports that current forecast data is unavailable. A compact node test suite covers classification, missing fields, midnight selection, and highest-risk windows; manual device checks are listed in [QA.md](./QA.md).

Known limits: Open-Meteo provides gridded model forecasts rather than street-level observations. Thunderstorm-related fields vary by model and region. The qualitative level is a simple aid for reading forecast ingredients, not a probability, detection feed, or safety alert. Place labels are optional display metadata and do not affect forecasts.

## Live Lightning Data

Live lightning detection is planned for a later milestone.

**Blitzortung** is currently being evaluated as a possible data source.

Important constraints:

- Blitzortung data must not be treated as an official warning service.
- Usage must comply with Blitzortung project rules.
- Public or project-specific permission may be required before using live data.
- The app should remain informational rather than presenting itself as a safety-critical warning system.
- Live strike data should eventually be consumed by the backend rather than by every client directly.

Potential future logic:

- first strike within 25 km → nearby activity state
- strike within 10 km → elevated nearby activity
- no new nearby strikes for 30–45 minutes → activity ending

Exact thresholds are not final.

---

## Notifications

Web Push is planned for a later milestone.

The goal is to support notifications such as:

> ⚡ Nearby lightning activity  
> Lightning has been detected within 10 km of your monitored location.

Notification logic should avoid sending one notification per strike.

Notifications should instead use storm/activity states and cooldown periods.

---

## Location and Privacy

Privacy should be a core design principle.

For Milestone 1:

- location permission is optional and requested only after a tap
- one monitored point can be selected from device location, Open-Meteo place search, or a map tap
- typed place queries are sent to Open-Meteo's public Geocoding API after a short debounce; map tiles are requested from OpenStreetMap
- when the user confirms a map-selected point, its coordinates may be sent to the public OpenStreetMap Nominatim reverse-geocoding service to find a display label; this is one bounded lookup per confirmation, not per map movement
- confirmed coordinates are rounded to four decimal places and stored in local browser storage; optional place label, country, administrative context, and selection source are display metadata
- the same rounded coordinates are sent to Open-Meteo for the forecast
- no location or forecast is sent to an app backend; confirmed location metadata stays in local browser storage, no location history is created, and forecast responses are not cached

Search and map choices remain candidates until confirmed; cancelling preserves the previously monitored point. Coordinates remain the authority for forecasts, while place labels are optional display metadata. Device location is requested only after a user tap. Search queries go to Open-Meteo Geocoding. Confirming a map point can send those coordinates to Nominatim; reverse lookup failure does not prevent saving. Search fallback may try comma-separated place components and show the broader context when the exact combined query has no result. Map tiles and reverse-geocoded place labels use OpenStreetMap data, attributed to [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). These providers receive requests directly from the browser; neither is an app backend.

A future server-side notification system may require storing a monitored coordinate or reduced-precision location.

If that is introduced, the privacy model should be documented clearly.

---

## Technical Direction

Preferred initial stack:

- TypeScript
- Next.js
- React
- PWA / Service Worker
- Open-Meteo
- simple server-side API routes where useful

The architecture should remain intentionally small.

Avoid adding infrastructure such as:

- databases
- authentication
- Redis
- queues
- complex geospatial services

until they are genuinely needed.

The codebase should make it easy to add later:

- weather-provider abstraction
- live lightning provider
- Web Push
- multiple monitored locations
- server-side geospatial distance checks

---

## Product Principles

### Simple

The user should understand the local lightning situation within a few seconds.

### Mobile First

The primary use case is checking the app from a phone.

### Privacy Conscious

Avoid unnecessary tracking and data retention.

### Informational

The app must not imply that it replaces official meteorological warnings.

### Calm Notifications

Do not overwhelm users during highly active thunderstorms.

---

## Possible Future Features

- live lightning map
- nearest detected strike
- strike count within 5 / 10 / 25 / 50 km
- activity trend
- storm approach / retreat detection
- multiple saved locations
- Web Push
- forecast confidence
- radar overlay
- official meteorological warning integration
- native apps if required later

---

## Development Milestones

### Milestone 1

Build the installable PWA with:

- geolocation
- saved monitored location
- Open-Meteo integration
- 24-hour lightning / thunderstorm forecast
- hourly risk interface

### Milestone 2

Add:

- backend service
- Web Push
- saved notification preferences
- basic storm-state logic

### Milestone 3

Add:

- approved live lightning data source
- strike-distance calculations
- live activity states
- notification triggering

### Milestone 4

Evaluate:

- native mobile applications
- background location support
- official meteorological data sources
- broader geographic coverage

---

## Disclaimer

Lightning Nearby is an informational project and must not be relied upon as an official severe-weather or emergency warning service.

Users should follow warnings and guidance issued by official meteorological and emergency authorities.
