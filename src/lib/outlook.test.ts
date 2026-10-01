import assert from "node:assert/strict";
import test from "node:test";
import { calculateStrongestSignalWindow, combineForecasts, deriveSignal, explainSignalDecision, fetchOutlook, isCurrentForecastRequest, mergeEnsembleEvidence, retainSelectedHour, summarizeSignal } from "./outlook.ts";
import { explainRiskDecision, selectNext24Hours, type Forecast, type ForecastHour } from "./weather.ts";
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
  assert.match(explainSignalDecision(positive.hours[0].evidence).qualitative, /signal unavailable/);
  assert.equal(combineForecasts(null, ensemble([support(start, 0)]))?.hours[0].signal.kind, "unavailable");
  assert.equal(combineForecasts(forecast([{ time: start }]), ensemble([support(start, 1)]))?.hours[0].signal.kind, "unavailable");
  assert.equal(combineForecasts(forecast([{ time: start }]), null)?.hours[0].signal.kind, "unavailable");
  assert.equal(summarizeSignal(null).includes("Local storms remain possible"), true);
});

test("debug explanation reports positive ensemble support as secondary without promoting Low", () => {
  const hour = combineForecasts(forecast([{ time: start, weatherCode: 0, risk: "low" }]), ensemble([support(start, 1)]))!.hours[0];
  const explanation = explainSignalDecision(hour.evidence);
  assert.deepEqual(hour.signal, { kind: "qualitative", risk: "low" });
  assert.equal(explanation.qualitative.includes("Low"), true);
  assert.match(explanation.ensemble, /1 \/ 40 model members/);
  assert.match(explanation.ensemble, /secondary evidence/);
  assert.match(explanation.ensemble, /does not change the qualitative level/);
});

test("debug explanation says zero ensemble support cannot override deterministic High", () => {
  const hour = combineForecasts(forecast([{ time: start, weatherCode: 95, risk: "high" }]), ensemble([support(start, 0)]))!.hours[0];
  const explanation = explainSignalDecision(hour.evidence);
  assert.match(explanation.qualitative, /High because deterministic WMO thunderstorm code 95/);
  assert.match(explanation.ensemble, /0 \/ 40/);
  assert.match(explanation.ensemble, /does not mean zero thunderstorm probability/);
});

test("debug explanation shares the classifier decision from normalized forecast inputs", () => {
  const hour = combineForecasts(forecast([{ time: start, weatherCode: 0, thunderstormProbability: 34, cape: 1_200, precipitationProbability: 70, risk: "elevated" }]), null)!.hours[0];
  const classifier = explainRiskDecision({ weatherCode: 0, thunderstormProbability: 34, cape: 1_200, precipitationProbability: 70 });
  const explanation = explainSignalDecision(hour.evidence);
  assert.deepEqual(hour.signal, { kind: "qualitative", risk: classifier.risk });
  assert.equal(explanation.qualitative, classifier.explanation);
});

test("source failures are isolated", async () => {
  const deterministic = forecast([{ time: start, weatherCode: 95, risk: "high" }]);
  const failedEnsemble = fetchOutlook(41.38, 2.17, undefined, async () => deterministic, async () => { throw new Error("ensemble-down"); });
  const primary = await failedEnsemble.primary;
  assert.deepEqual(primary.hours[0].signal, { kind: "qualitative", risk: "high" });
  assert.equal(await failedEnsemble.ensemble, null);

  const failedDeterministic = fetchOutlook(41.38, 2.17, undefined,
    async () => { throw new Error("forecast-down"); }, async () => ensemble([support(start, 1)]));
  await assert.rejects(failedDeterministic.primary, /forecast-down/);
  const ensembleOnly = combineForecasts(null, await failedDeterministic.ensemble);
  assert.deepEqual(ensembleOnly?.hours[0].signal, { kind: "unavailable" });
  assert.equal(ensembleOnly?.hours[0].evidence.ensemble?.supportingMembers, 1);

  const bothFailed = fetchOutlook(41.38, 2.17, undefined,
    async () => { throw new Error("forecast-down"); }, async () => { throw new Error("ensemble-down"); });
  await assert.rejects(bothFailed.primary, /forecast-down/);
  assert.equal(await bothFailed.ensemble, null);
});

test("a forecast refresh can re-run the existing pipeline with the same saved coordinates", async () => {
  const savedLocation = { latitude: 39.91, longitude: 32.84, label: "Selected coordinates", savedAt: 1 };
  const originalLocation = { ...savedLocation };
  const requestedPoints: Array<[number, number]> = [];
  const requests = fetchOutlook(savedLocation.latitude, savedLocation.longitude, undefined,
    async (latitude, longitude) => {
      requestedPoints.push([latitude, longitude]);
      return forecast([{ time: start, risk: "low" }]);
    },
    async (latitude, longitude) => {
      requestedPoints.push([latitude, longitude]);
      return ensemble([]);
    });
  await Promise.all([requests.primary, requests.ensemble]);
  assert.deepEqual(requestedPoints, [[39.91, 32.84], [39.91, 32.84]]);
  assert.deepEqual(savedLocation, originalLocation);
});

test("fast deterministic outlook resolves before slow ensemble; late evidence merges without changing risk or selection", async () => {
  let resolveEnsemble!: (value: EnsembleForecast) => void;
  let ensembleStarted = false;
  const requests = fetchOutlook(41.38, 2.17, undefined,
    async () => forecast([{ time: start, weatherCode: 0, risk: "low" }, { time: start + 3_600, risk: "elevated" }]),
    async () => { ensembleStarted = true; return new Promise<EnsembleForecast>((resolve) => { resolveEnsemble = resolve; }); });
  const primary = await requests.primary;
  assert.equal(ensembleStarted, true);
  assert.equal(primary.hours[0].signal.kind, "qualitative");
  assert.deepEqual(primary.hours[0].signal, { kind: "qualitative", risk: "low" });

  const selected = start + 3_600;
  resolveEnsemble(ensemble([support(start, 1), support(start + 3_600, 5)]));
  const result = mergeEnsembleEvidence(primary, (await requests.ensemble)!);
  assert.equal(result.hours[0].evidence.ensemble?.supportingMembers, 1);
  assert.deepEqual(result.hours[0].signal, { kind: "qualitative", risk: "low" });
  assert.equal(result.hours[1].evidence.ensemble?.supportingMembers, 5);
  assert.deepEqual(result.hours[1].signal, { kind: "qualitative", risk: "elevated" });
  assert.equal(result.fetchedAt, primary.fetchedAt);
  assert.equal(retainSelectedHour(selected, result.hours), selected);
});

test("an aborted previous-location ensemble result is discarded and request generations reject stale callbacks", async () => {
  const controller = new AbortController();
  let resolveOldEnsemble!: (value: EnsembleForecast) => void;
  const oldRequests = fetchOutlook(41.38, 2.17, controller.signal,
    async () => forecast([{ time: start, risk: "low" }]),
    async () => new Promise<EnsembleForecast>((resolve) => { resolveOldEnsemble = resolve; }));
  const oldPrimary = await oldRequests.primary;

  controller.abort(); // The page aborts both source requests when the confirmed location changes.
  resolveOldEnsemble(ensemble([support(start, 10)])); // Simulate a transport that resolves despite abort.
  assert.equal(await oldRequests.ensemble, null);
  assert.equal(isCurrentForecastRequest(1, 2, controller.signal), false);
  assert.equal(isCurrentForecastRequest(1, 1, controller.signal), false);
  assert.deepEqual(oldPrimary.hours[0].signal, { kind: "qualitative", risk: "low" });
});

test("alignment and next-24-hour window cross midnight; longest contiguous peak wins", () => {
  const shifted = combineForecasts(forecast([{ time: start, weatherCode: 0, risk: "low" }]),
    ensemble([support(start + 1_800, 4)]))!;
  assert.equal(shifted.hours.length, 1);
  assert.deepEqual(shifted.hours[0].signal, { kind: "qualitative", risk: "low" });
  const extended = combineForecasts(forecast(Array.from({ length: 30 }, (_, i) => ({
    time: start + i * 3_600, weatherCode: 0,
    ...(i === 1 || i === 2 ? { cape: 800, precipitationProbability: 60 } : {}),
    risk: i === 1 || i === 2 ? "elevated" : "low",
  }))), ensemble(Array.from({ length: 30 }, (_, i) =>
    support(start + i * 3_600, i === 5 ? 40 : 0))))!;
  const next24 = selectNext24Hours(extended.hours, start * 1_000 + 20 * 60_000);
  assert.equal(next24.length, 24);
  assert.equal(new Date(next24[1].time * 1000).toISOString(), "2026-09-30T00:00:00.000Z");
  assert.deepEqual(calculateStrongestSignalWindow(next24), { start: start + 3_600, end: start + 10_800, risk: "elevated" });
  assert.deepEqual(next24[5].signal, { kind: "qualitative", risk: "low" });
});
