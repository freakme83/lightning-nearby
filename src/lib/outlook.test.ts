import assert from "node:assert/strict";
import test from "node:test";
import { calculateStrongestSignalWindow, combineForecasts, fetchOutlook } from "./outlook.ts";
import { selectNext24Hours, type Forecast } from "./weather.ts";
import type { EnsembleForecast } from "./ensemble.ts";

const start = Date.UTC(2026, 8, 29, 23) / 1000;
const deterministic: Forecast = {
  timezone: "Europe/Istanbul", latitude: 39.9, longitude: 32.8, fetchedAt: 100,
  hours: [
    { time: start, risk: "low", weatherCode: 0 },
    { time: start + 3_600, risk: "elevated", cape: 800, precipitationProbability: 60 },
    { time: start + 7_200, risk: "high", weatherCode: 97, thunderstormProbability: 20 },
  ],
};
const ensemble: EnsembleForecast = {
  timezone: "Europe/Istanbul", fetchedAt: 200,
  hours: [
    { time: start, supportingMembers: 0, availableMembers: 40, model: "ICON-EU EPS" },
    { time: start + 3_600, supportingMembers: 8, availableMembers: 40, model: "ICON-EU EPS" },
    { time: start + 7_200, supportingMembers: 40, availableMembers: 40, model: "ICON-EU EPS" },
  ],
};

test("direct probability takes precedence over aligned ensemble support; ensemble precedes heuristic", () => {
  const result = combineForecasts(deterministic, ensemble)!;
  assert.equal(result.hours[0].signal.kind, "ensemble-support");
  assert.equal(result.hours[1].signal.kind, "ensemble-support");
  assert.equal(result.hours[2].signal.kind, "provider-probability");
  assert.equal(result.hours[2].risk, "high"); // The direct WMO code still leads the deterministic badge.
  assert.equal(result.hours[2].ensembleSupport?.supportingMembers, 40);
  assert.equal(result.ensembleFetchedAt, 200);
  assert.equal(combineForecasts(deterministic, null)?.hours[1].signal.kind, "derived");
});

test("missing deterministic fields use ensemble; wholly insufficient inputs are unavailable", () => {
  const sparse: Forecast = { ...deterministic, hours: [{ time: start }] };
  assert.equal(combineForecasts(sparse, ensemble)?.hours[0].signal.kind, "ensemble-support");
  assert.equal(combineForecasts(sparse, null), null);
});

test("source fetches fail independently", async () => {
  const fallback = await fetchOutlook(39.9, 32.8, undefined, async () => deterministic, async () => { throw new Error("ensemble-down"); });
  assert.equal(fallback.hours[0].signal.kind, "derived");
  const ensembleOnly = await fetchOutlook(39.9, 32.8, undefined, async () => { throw new Error("forecast-down"); }, async () => ensemble);
  assert.equal(ensembleOnly.hours[1].signal.kind, "ensemble-support");
  await assert.rejects(fetchOutlook(39.9, 32.8, undefined,
    async () => { throw new Error("forecast-down"); }, async () => { throw new Error("ensemble-down"); }), /forecast-insufficient/);
});

test("strongest window respects source hierarchy and compares ensemble shares by denominator", () => {
  const combined = combineForecasts(deterministic, ensemble)!;
  const direct = calculateStrongestSignalWindow(combined.hours);
  assert.equal(direct?.signal.kind, "provider-probability");
  assert.equal(direct?.start, start + 7_200);

  const withoutProbability = combineForecasts({ ...deterministic, hours: deterministic.hours.slice(0, 2) }, ensemble)!;
  const peak = calculateStrongestSignalWindow(withoutProbability.hours);
  assert.equal(peak?.signal.kind, "ensemble-support");
  assert.equal(peak?.start, start + 7_200);

  const varying = combineForecasts(null, { ...ensemble, hours: [
    { time: start, supportingMembers: 2, availableMembers: 5, model: "ICON-EU EPS" },
    { time: start + 3_600, supportingMembers: 1, availableMembers: 2, model: "ICON-EU EPS" },
  ] })!;
  assert.equal(calculateStrongestSignalWindow(varying.hours)?.start, start + 3_600);
});

test("exact Unix-hour alignment and next-24-hour selection cross midnight", () => {
  const shifted = combineForecasts(deterministic, { ...ensemble, hours: [
    { time: start + 1_800, supportingMembers: 4, availableMembers: 40, model: "ICON-EU EPS" },
  ] })!;
  assert.equal(shifted.hours[0].signal.kind, "derived");
  assert.equal(shifted.hours.length, deterministic.hours.length);
  const extended = combineForecasts(null, { ...ensemble, hours: Array.from({ length: 30 }, (_, i) => ({
    time: start + i * 3_600, supportingMembers: i === 1 ? 3 : 0, availableMembers: 40, model: "ICON-EU EPS",
  })) })!;
  const next24 = selectNext24Hours(extended.hours, start * 1_000 + 20 * 60_000);
  assert.equal(next24.length, 24);
  assert.equal(new Date(next24[1].time * 1000).toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(calculateStrongestSignalWindow(next24)?.start, start + 3_600);
});
