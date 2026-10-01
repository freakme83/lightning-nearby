import test from "node:test";
import assert from "node:assert/strict";
import { buildTodayBriefing, localCalendarDate, nextLocalMidnight, parseDailyWeather, type DailyWeather } from "./today-briefing.ts";
import { fetchForecast } from "./weather.ts";
import { combineForecasts, mergeEnsembleEvidence } from "./outlook.ts";
const now = Date.UTC(2026, 9, 1, 12);
const day: DailyWeather = { date: "2026-10-01", weatherCode: 0, highC: 24.6, lowC: 12.2, precipitationProbability: 5, precipitationMm: 0 };
const text = (changes: Partial<DailyWeather>) => buildTodayBriefing([{ ...day, ...changes }], "UTC", now)!;

test("whole-degree temperatures and partial/missing daily data", () => {
  assert.equal(text({}), "Clear skies · high 25°C, low 12°C. Little or no precipitation is expected today.");
  assert.match(text({ highC: undefined, lowC: -2.6 }), /low -3°C/);
  assert.doesNotMatch(text({ highC: undefined, lowC: undefined }), /°C/);
  assert.equal(buildTodayBriefing(undefined, "UTC", now), null);
  assert.equal(text({ weatherCode: undefined, highC: undefined, lowC: undefined, precipitationProbability: undefined, precipitationMm: undefined }), null);
});
test("ordinary daily conditions including thunderstorm codes only", () => {
  for (const [code, phrase] of [[1, "Mostly clear"], [2, "Partly cloudy"], [3, "Overcast"], [45, "Fog"], [51, "Drizzle"], [61, "Rain"], [80, "Rain showers"], [71, "Snow"], [95, "Thunderstorms"]] as const) assert.match(text({ weatherCode: code }), new RegExp(phrase));
  assert.doesNotMatch(text({ weatherCode: 61 }), /Thunderstorm|Little or no/);
});
test("conservative precipitation thresholds and contradictory inputs", () => {
  assert.match(text({ precipitationProbability: 19 }), /Little or no/);
  assert.match(text({ precipitationProbability: 20 }), /possible/);
  assert.match(text({ precipitationProbability: 59 }), /possible/);
  assert.match(text({ precipitationProbability: 60 }), /likely/);
  assert.match(text({ precipitationMm: 0.1 }), /possible/);
  assert.doesNotMatch(text({ precipitationProbability: undefined }), /Little or no/);
  assert.doesNotMatch(text({ precipitationMm: undefined }), /Little or no/);
  assert.doesNotMatch(text({ weatherCode: 95, precipitationProbability: 0, precipitationMm: 0 }), /Little or no/);
});
test("today stays on location calendar date until midnight, not next24h", () => {
  const days = [day, { ...day, date: "2026-10-02", weatherCode: 61 }];
  const before = Date.UTC(2026, 9, 1, 20, 59, 59, 999);
  assert.equal(localCalendarDate(before, "Europe/Istanbul"), "2026-10-01");
  assert.match(buildTodayBriefing(days, "Europe/Istanbul", before)!, /Clear/);
  assert.match(buildTodayBriefing(days, "Europe/Istanbul", before + 1)!, /Rain/);
  assert.equal(nextLocalMidnight(before, "Europe/Istanbul"), before + 1);
  assert.equal(localCalendarDate(Date.UTC(2026, 9, 2, 2), "America/New_York"), "2026-10-01");
  assert.equal(buildTodayBriefing([day], "UTC", Date.UTC(2026, 9, 2)), null);
  assert.equal(nextLocalMidnight(Date.UTC(2026, 10, 1, 4), "America/New_York"), Date.UTC(2026, 10, 2, 5));
});
test("daily Unix dates use provider offset without shifting hourly epochs", () => {
  const daily = parseDailyWeather({ time: [Date.UTC(2026, 8, 30, 21) / 1000], temperature_2m_max: [25], weather_code: [0], precipitation_probability_max: [101], precipitation_sum: [-1] }, 10800);
  assert.equal(daily[0].date, "2026-10-01");
  assert.equal(daily[0].precipitationProbability, undefined);
  assert.equal(daily[0].precipitationMm, undefined);
  for (const malformed of [null, {}, { time: "bad" }, { time: [null, "bad", Infinity] }]) assert.deepEqual(parseDailyWeather(malformed, 0), []);
  assert.deepEqual(parseDailyWeather({ time: [now / 1000] }, undefined), []);
  assert.equal(parseDailyWeather({ time: [now / 1000], weather_code: "bad", temperature_2m_max: [null] }, 0)[0].highC, undefined);
});
test("same single no-store forecast request; optional daily cannot break hourly or merges", async () => {
  for (const daily of [undefined, { time: "bad" }, { time: [now / 1000], weather_code: [0] }]) {
    let calls = 0;
    const controller = new AbortController();
    const forecast = await fetchForecast(39.91, 32.84, controller.signal, (async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("forecast_hours"), "48");
      assert.equal(url.searchParams.get("timezone"), "auto");
      assert.equal(url.searchParams.get("timeformat"), "unixtime");
      assert.equal(url.searchParams.get("daily"), "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum");
      assert.match(url.searchParams.get("hourly")!, /cape,convective_inhibition,thunderstorm_probability/);
      assert.equal(init?.cache, "no-store"); assert.equal(init?.signal, controller.signal);
      return new Response(JSON.stringify({ timezone: "UTC", utc_offset_seconds: 0, hourly: { time: [now / 1000], weather_code: [0] }, daily }));
    }) as typeof fetch);
    assert.equal(calls, 1); assert.equal(forecast.hours[0].time, now / 1000); assert.equal(forecast.hours[0].risk, "low");
    const outlook = combineForecasts(forecast, null)!;
    assert.equal(outlook.daily, forecast.daily);
    const merged = mergeEnsembleEvidence(outlook, { timezone: "UTC", fetchedAt: 1, hours: [] });
    assert.equal(merged.daily, forecast.daily); assert.deepEqual(merged.hours, outlook.hours);
  }
});
