# Lightning Nearby

A privacy-conscious progressive web app for local lightning awareness and short-term thunderstorm risk.

The app combines:

- user-selected location data
- 24-hour thunderstorm / lightning risk forecasts
- future live lightning detection data
- browser notifications

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

The initial forecast provider will be **Open-Meteo**.

The app should evaluate hourly thunderstorm risk using the most suitable available forecast fields, potentially including:

- thunderstorm probability
- lightning potential
- lightning density
- precipitation probability
- CAPE
- lifted index
- convective inhibition

Direct thunderstorm / lightning forecast parameters should be preferred over deriving risk from CAPE alone.

The weather-provider implementation should be isolated from the UI so that other providers can be added later.

---

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

For the initial version:

- location permission is optional
- users may select their current location
- one monitored location is stored locally
- continuous background tracking is not required
- precise location should not be sent or stored unnecessarily

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
