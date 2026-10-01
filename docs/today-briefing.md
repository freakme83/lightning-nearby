# Today briefing

The compact TODAY block is ordinary deterministic weather context, below the current/live hero and next-24-hour lightning context and above the hourly outlook. It is not a lightning classification or a rolling 24-hour summary.

## Data and calendar day

The existing no-store Open-Meteo deterministic request requests `current=temperature_2m` and daily `weather_code`, `temperature_2m_max`, `temperature_2m_min`, `precipitation_probability_max`, and `precipitation_sum`. Current temperature is optional and independent from hourly thunderstorm evidence/classification. Hourly variables, `forecast_hours=48`, `timezone=auto`, Unix timestamps, abort ownership, optional ensemble calls and timezone resolution are unchanged. No additional weather request is introduced.

Daily Unix timestamps are decoded to provider calendar-date keys using the documented `utc_offset_seconds`; hourly epochs are never shifted. The displayed forecast timezone determines the current local date. Only the daily record matching that date is used, including the entire day's aggregate, from 00:00 through 23:59. Selection does not advance as afternoon/evening passes. A one-shot local-midnight timer (including DST) and tab visibility resynchronization switch the date without fetching. If that date has no usable record, the block is omitted rather than showing tomorrow or stale yesterday data.

Open-Meteo defines daily weather code as the day's most severe condition. Daily aggregates retain the provider's timezone/day boundaries; the existing nearby-civil timezone display correction offshore does not recompute those aggregates. This provider-boundary limitation also applies near timezone borders.

## Deterministic wording

- Broad ordinary conditions: clear, mostly clear, partly cloudy, overcast, fog, drizzle, rain, showers, snow, or thunderstorms. Thunderstorm wording comes only from daily weather code.
- Current temperature, high and low are rounded to whole degrees Celsius. When present, copy begins `Now 13°C · high 16°C, low 10°C.` Missing current temperature omits only the `Now` fragment; high and low are omitted independently when unavailable.
- Daily precipitation probability at least 60%: precipitation likely. At least 20%, or precipitation sum at least 0.1 mm: precipitation possible.
- Little/no precipitation wording requires both available low probability and low sum, with no wet daily code. Missing fields or wet-code contradictions never produce a dry claim.
- “Precipitation” includes snow; counts, CAPE, CIN, ensemble support and lightning risk are not inputs.

Examples: “Clear skies · high 25°C, low 12°C. Little or no precipitation is expected today.” “Rain showers · high 18°C, low 11°C. Precipitation is likely today.” Partial example: “Fog · low 4°C.”

Optional daily failures never invalidate hourly data. Primary conversion and late ensemble merge preserve daily records. Forecast refresh uses the existing pipeline; this block does not alter location storage or live-check/session behavior.

## Verification

Fixture tests cover current-temperature parsing (including negative and malformed/missing values), current-temperature wording, daily conditions, temperature rounding and missing fields, conservative precipitation boundaries/conflicts, multiple dates and location timezones, local midnight/DST, malformed daily arrays, one deterministic request with unchanged hourly configuration, and preservation through outlook/ensemble conversion. No test calls live providers.
