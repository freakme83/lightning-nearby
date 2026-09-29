import assert from "node:assert/strict";
import test from "node:test";
import { calculateHighestRiskWindow, classifyRisk, selectNext24Hours, type ForecastHour } from "./weather.ts";

const hour = (time: number, risk: ForecastHour["risk"]): ForecastHour => ({ time, risk });

test("direct thunderstorm weather codes classify as high", () => {
  for (const weatherCode of [95, 96, 99]) assert.equal(classifyRisk({ weatherCode }), "high");
});

test("precipitation alone and CAPE alone do not imply thunderstorm risk", () => {
  assert.equal(classifyRisk({ precipitationProbability: 90 }), "low");
  assert.equal(classifyRisk({ cape: 1600 }), "low");
  assert.equal(classifyRisk({ cape: 1200, precipitationProbability: 20 }), "low");
});

test("direct thunderstorm probability takes precedence when present", () => {
  assert.equal(classifyRisk({ thunderstormProbability: 55 }), "high");
  assert.equal(classifyRisk({ thunderstormProbability: 25 }), "elevated");
  assert.equal(classifyRisk({ thunderstormProbability: 5, cape: 800, precipitationProbability: 60 }), "elevated");
});

test("missing optional forecast values safely fall back to low", () => {
  assert.equal(classifyRisk({ weatherCode: null, cape: null, precipitationProbability: null, thunderstormProbability: null }), "low");
  assert.equal(classifyRisk({ convectiveInhibition: 0 }), "low");
});

test("next 24 hourly buckets cross midnight using chronological timestamps", () => {
  const now = Date.UTC(2026, 8, 29, 23, 35);
  const start = Math.floor(now / 3_600_000) * 3_600;
  const forecast = Array.from({ length: 48 }, (_, i) => hour(start + i * 3_600, "low"));
  const selected = selectNext24Hours(forecast, now);
  assert.equal(selected.length, 24);
  assert.equal(new Date(selected[0].time * 1000).toISOString(), "2026-09-29T23:00:00.000Z");
  assert.equal(new Date(selected[1].time * 1000).toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(selected.at(-1)?.time, start + 23 * 3_600);
});

test("highest-risk window selects the longest contiguous run at the peak level", () => {
  const start = 1_800_000_000;
  const hours = [hour(start, "elevated"), hour(start + 3_600, "high"), hour(start + 7_200, "high"), hour(start + 10_800, "low"), hour(start + 14_400, "high")];
  assert.deepEqual(calculateHighestRiskWindow(hours), { start: start + 3_600, end: start + 10_800, level: "high" });
  assert.equal(calculateHighestRiskWindow([hour(start, "low")]), null);
});
