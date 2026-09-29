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
- Browser geolocation permission
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

Open-Meteo defines precipitation probability for the preceding hour; the classifier compares it with instability and other values at the matching hourly timestamp. The current Open-Meteo API schema also lists direct lightning fields, but model and geographic availability varies. A live request for coordinates near Ankara returned null values for `thunderstorm_probability`, `lightning_potential`, and `lightning_density`; those fields are not treated as globally available. Direct thunderstorm weather codes (95, 96, 99) are the strongest signal when supplied. Open-Meteo documents thunderstorm probability as model-limited (for example, its GFS documentation lists it for NBM only). The UI displays provider values separately from the app’s derived qualitative risk.

The risk classifier is intentionally simple and conservative:

- WMO thunderstorm codes 95, 96, or 99 → **High**.
- Provider-supplied `thunderstorm_probability` of 20–49 → **Elevated**, 50 or more → **High**. These are app classification cutoffs; the underlying percentage remains an upstream value.
- Otherwise, CAPE of at least 700 J/kg together with precipitation probability of at least 40% → **Elevated**.
- Otherwise → **Low**. Precipitation or CAPE alone never raises the level.

The thresholds are qualitative product heuristics, not a calibrated risk probability or official warning. They are grouped in `src/lib/weather.ts` for easy replacement. Missing optional values are ignored. Weather-provider parsing, normalized forecast data, time selection, and the classifier are separate from presentation logic.

---

## Milestone 1 Implementation

The app is a small Next.js / TypeScript PWA with a native web manifest and service worker. The service worker may cache the app shell for reopening offline, but does not cache weather responses. With no network, the app reports that current forecast data is unavailable. A compact node test suite covers classification, missing fields, midnight selection, and highest-risk windows; manual device checks are listed in [QA.md](./QA.md).

Known limits: Open-Meteo provides gridded model forecasts rather than street-level observations. Thunderstorm-related fields vary by model and region. The qualitative level is a simple aid for reading forecast ingredients, not a probability, detection feed, or safety alert. The selected location is a rounded coordinate only; no place name is reverse-geocoded.

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
- the current location can be saved as the one monitored location
- rounded coordinates (three decimal places) are stored in local browser storage
- the same rounded coordinates are sent to Open-Meteo for the forecast
- no location or forecast is sent to an app backend; forecast responses are not cached

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
