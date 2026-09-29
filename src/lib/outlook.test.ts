import assert from "node:assert/strict";
import test from "node:test";
import { calculateStrongestSignalWindow, combineForecasts, deriveSignal, fetchOutlook, summarizeSignal } from "./outlook.ts";
import { selectNext24Hours, type Forecast, type ForecastHour } from "./weather.ts";
import type { EnsembleForecast, LocalEnsembleThunderstormSupport } from "./ensemble.ts";

const start = Date.UTC(2026, 8, 29, 23) / 1000;
const forecast = (hours: ForecastHour[]): Forecast => ({ timezone: "Europe/Madrid", latitude: 41.3851, longitude: 2.1734, fetchedAt: 100, hours });
const support = (time: number, supportingMembers: number, availableMembers = 40): LocalEnsembleThunderstormSupport => ({
  time, supportingMembers, availableMembers, model: "ICON-EU EPS", spatialWindowKm: 13, temporalWindowHours: 1, sampledLocations: 5,
});
const ensemble = (hours: LocalEnsembleThunderstormSupport[]): EnsembleForecast => ({ timezone: "Europe/Madrid", fetchedAt: 200, hours });

test("Barcelona regression: WMO thunderstorm stays High with zero local ensemble support", () => {
  const result = combineForecasts(forecast([{ time: start, weatherCode: 95, precipitationProbability: 90, risk: "high" }]),
    ensemble([support(start, 0)]))!;
  assert.deepEqual(result.hours[0].signal, { kind: "qualitative", risk: "high" });
  assert.equal(result.hours[0].evidence.ensemble?.supportingMembers, 0);
  assert.equal(result.hours[0].evidence.deterministic?.weatherCode, 95);
  const window = calculateStrongestSignalWindow(result.hours);
  assert.equal(window?.risk, "high");
  const summary = summarizeSignal(window, "16:00–17:00");
  assert.match(summary, /Thunderstorm conditions are indicated/);
  assert.doesNotMatch(summary, /zero|0%|No .*thunderstorm/i);
});

test("explicit code wins over low provider probability and ensemble zero while both remain evidence", () => {
  const result = combineForecasts(forecast([{ time: start, weatherCode: 97, thunderstormProbability: 0, risk: "high" }]),
    ensemble([support(start, 0)]))!;
  assert.deepEqual(result.hours[0].signal, { kind: "qualitative", risk: "high" });
  assert.equal(result.hours[0].evidence.providerProbability, 0);
  assert.equal(result.hours[0].evidence.ensemble?.availableMembers, 40);
  assert.deepEqual(deriveSignal({ deterministic: { weatherCode: 99, risk: "low" }, providerProbability: 0 }), { kind: "qualitative", risk: "high" });
});

test("local ensemble evidence remains secondary to the qualitative level", () => {
  const result = combineForecasts(forecast([
    { time: start, weatherCode: 0, risk: "low" },
    { time: start + 3_600, weatherCode: 95, risk: "high" },
    { time: start + 7_200, thunderstormProbability: 5, risk: "low" },
  ]), ensemble([support(start, 1), support(start + 3_600, 2), support(start + 7_200, 1)]))!;
  assert.deepEqual(result.hours.map((hour) => hour.signal), [
    { kind: "qualitative", risk: "low" },
    { kind: "qualitative", risk: "high" },
    { kind: "qualitative", risk: "low" },
  ]);
  assert.equal(result.hours[2].evidence.providerProbability, 5);
  assert.equal(result.hours[2].evidence.ensemble?.supportingMembers, 1);
  assert.equal(result.hours[0].evidence.ensemble?.supportingMembers, 1);
  assert.equal(calculateStrongestSignalWindow(result.hours)?.start, start + 3_600);
});

test("5% provider probability with one of 40 supporting members stays Low", () => {
  const hour = combineForecasts(forecast([{ time: start, thunderstormProbability: 5, risk: "low" }]),
    ensemble([support(start, 1)]))!.hours[0];
  assert.deepEqual(hour.signal, { kind: "qualitative", risk: "low" });
  assert.equal(hour.evidence.providerProbability, 5);
  assert.deepEqual([hour.evidence.ensemble?.supportingMembers, hour.evidence.ensemble?.availableMembers], [1, 40]);
});

test("provider probability and deterministic fallback remain distinct with ensemble evidence retained", () => {
  const result = combineForecasts(forecast([
    { time: start, weatherCode: 0, thunderstormProbability: 45, risk: "elevated" },
    { time: start + 3_600, cape: 800, precipitationProbability: 60, risk: "elevated" },
    { time: start + 7_200, thunderstormProbability: 55, risk: "high" },
  ]), ensemble([support(start, 8), support(start + 3_600, 0)]))!;
  assert.equal(result.hours[0].evidence.providerProbability, 45);
  assert.equal(result.hours[0].evidence.ensemble?.supportingMembers, 8);
  assert.deepEqual(result.hours.map((hour) => hour.signal.kind === "qualitative" ? hour.signal.risk : null), ["elevated", "elevated", "high"]);
  assert.equal(combineForecasts(forecast([{ time: start, cape: 800, precipitationProbability: 60, risk: "elevated" }]), null)?.hours[0].signal.kind, "qualitative");
});

test("ensemble-only positive remains secondary with an unavailable qualitative level", () => {
  const positive = combineForecasts(null, ensemble([support(start, 1)]))!;
  assert.deepEqual(positive.hours[0].signal, { kind: "unavailable" });
  assert.equal(positive.hours[0].evidence.ensemble?.supportingMembers, 1);
  assert.equal(combineForecasts(null, ensemble([support(start, 0)]))?.hours[0].signal.kind, "unavailable");
  assert.equal(combineForecasts(forecast([{ time: start }]), ensemble([support(start, 1)]))?.hours[0].signal.kind, "unavailable");
  assert.equal(combineForecasts(forecast([{ time: start }]), null)?.hours[0].signal.kind, "unavailable");
  assert.equal(summarizeSignal(null).includes("Local storms remain possible"), true);
});

test("source failures are isolated", async () => {
  const deterministic = forecast([{ time: start, weatherCode: 95, risk: "high" }]);
  const fallback = await fetchOutlook(41.38, 2.17, undefined, async () => deterministic, async () => { throw new Error("ensemble-down"); });
  assert.equal(fallback.hours[0].signal.kind, "qualitative");
  const ensembleOnly = await fetchOutlook(41.38, 2.17, undefined, async () => { throw new Error("forecast-down"); }, async () => ensemble([support(start, 1)]));
  assert.deepEqual(ensembleOnly.hours[0].signal, { kind: "unavailable" });
  assert.equal(ensembleOnly.hours[0].evidence.ensemble?.supportingMembers, 1);
  await assert.rejects(fetchOutlook(41.38, 2.17, undefined,
    async () => { throw new Error("forecast-down"); }, async () => { throw new Error("ensemble-down"); }), /forecast-insufficient/);
});

test("alignment and next-24-hour window cross midnight; longest contiguous peak wins", () => {
  const shifted = combineForecasts(forecast([{ time: start, weatherCode: 0, risk: "low" }]),
    ensemble([support(start + 1_800, 4)]))!;
  assert.equal(shifted.hours.length, 1);
  assert.deepEqual(shifted.hours[0].signal, { kind: "qualitative", risk: "low" });
  const extended = combineForecasts(forecast(Array.from({ length: 30 }, (_, i) => ({
    time: start + i * 3_600, weatherCode: 0, risk: i === 1 || i === 2 ? "elevated" : "low",
  }))), ensemble(Array.from({ length: 30 }, (_, i) =>
    support(start + i * 3_600, i === 5 ? 40 : 0))))!;
  const next24 = selectNext24Hours(extended.hours, start * 1_000 + 20 * 60_000);
  assert.equal(next24.length, 24);
  assert.equal(new Date(next24[1].time * 1000).toISOString(), "2026-09-30T00:00:00.000Z");
  assert.deepEqual(calculateStrongestSignalWindow(next24), { start: start + 3_600, end: start + 10_800, risk: "elevated" });
  assert.deepEqual(next24[5].signal, { kind: "qualitative", risk: "low" });
});
