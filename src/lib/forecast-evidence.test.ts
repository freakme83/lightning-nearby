import assert from "node:assert/strict";
import test from "node:test";
import { describeDeterministicEvidence, summarizeForecastEvidence } from "./forecast-evidence.ts";
import { combineForecasts, mergeEnsembleEvidence } from "./outlook.ts";
import { classifyRisk, hasRiskEvidence, type Forecast, type RiskInputs, type RiskLevel } from "./weather.ts";
import type { EnsembleForecast, LocalEnsembleThunderstormSupport } from "./ensemble.ts";

const time = Date.UTC(2026, 9, 2, 13) / 1000;
const support = (supportingMembers: number, availableMembers = 40): LocalEnsembleThunderstormSupport => ({
  time, supportingMembers, availableMembers, model: "ICON-EU EPS",
  spatialWindowKm: 13, temporalWindowHours: 1, sampledLocations: 5,
});

test("evidence source preserves direct precedence and distinguishes ingredient coverage from weak Low", () => {
  const cases: Array<[RiskInputs, string, string]> = [
    ...[95, 96, 97, 99].map((weatherCode): [RiskInputs, string, string] =>
      [{ weatherCode, thunderstormProbability: 8 }, "direct-thunderstorm-code", "direct"]),
    [{ thunderstormProbability: 0, cape: 1300, precipitationProbability: 60 }, "direct-provider-probability", "direct"],
    [{ thunderstormProbability: 34 }, "direct-provider-probability", "direct"],
    [{ cape: 800, precipitationProbability: 60 }, "cape-precip-fallback", "ingredients"],
    [{ cape: 0, precipitationProbability: 0 }, "cape-precip-fallback", "ingredients"],
    [{ weatherCode: 3 }, "weather-code-only", "weak"],
    [{ weatherCode: 3, convectiveInhibition: -25 }, "weather-code-only", "weak"],
    [{ weatherCode: 3, cape: 800 }, "partial-deterministic", "partial"],
    [{ cape: 800 }, "partial-deterministic", "partial"],
    [{ precipitationProbability: 60 }, "partial-deterministic", "partial"],
    [{}, "insufficient", "insufficient"],
    [{ convectiveInhibition: -25 }, "insufficient", "insufficient"],
  ];
  for (const [input, source, quality] of cases) assert.deepEqual(describeDeterministicEvidence(input), {
    deterministicEvidenceSource: source, deterministicEvidenceQuality: quality,
  });
});

test("invalid fields cannot create direct evidence or diagnostic conflicts", () => {
  for (const thunderstormProbability of [NaN, Infinity, -1, 101]) {
    const summary = summarizeForecastEvidence({ thunderstormProbability, cape: 800, precipitationProbability: 60 }, "elevated");
    assert.equal(summary.deterministicEvidenceSource, "cape-precip-fallback");
    assert.deepEqual(summary.conflictFlags, []);
  }
  assert.equal(describeDeterministicEvidence({ weatherCode: 100, cape: NaN, precipitationProbability: 101 }).deterministicEvidenceSource, "insufficient");
  assert.equal(describeDeterministicEvidence({ cape: -1, precipitationProbability: 60 }).deterministicEvidenceSource, "partial-deterministic");
  assert.equal(summarizeForecastEvidence({ thunderstormProbability: 8, cape: Infinity, precipitationProbability: 60 }, "low").conflictFlags.length, 0);
});

test("low direct probability conflicting with fallback is observable without promotion", () => {
  const input = { thunderstormProbability: 8, cape: 1300, precipitationProbability: 60 };
  const summary = summarizeForecastEvidence(input, classifyRisk(input));
  assert.equal(classifyRisk(input), "low");
  assert.deepEqual(summary.conflictFlags, ["low-direct-probability-vs-strong-fallback"]);
  assert.equal(summary.deterministicEvidenceSource, "direct-provider-probability");
  assert.deepEqual(summarizeForecastEvidence({ thunderstormProbability: 20, cape: 700, precipitationProbability: 40 }, "elevated").conflictFlags, []);
  assert.equal(summarizeForecastEvidence({ thunderstormProbability: 19, cape: 700, precipitationProbability: 40 }, "low").conflictFlags.length, 1);
  assert.equal(summarizeForecastEvidence({ thunderstormProbability: 8, cape: 699, precipitationProbability: 60 }, "low").conflictFlags.length, 0);
  assert.equal(summarizeForecastEvidence({ thunderstormProbability: 8, cape: 800, precipitationProbability: 39 }, "low").conflictFlags.length, 0);
});

test("thunderstorm codes conflicting with low probability stay High and can carry multiple flags", () => {
  for (const weatherCode of [95, 96, 97, 99]) {
    const input = { weatherCode, thunderstormProbability: 8, cape: 1300, precipitationProbability: 60 };
    assert.equal(classifyRisk(input), "high");
    assert.deepEqual(summarizeForecastEvidence(input, "high", support(0)).conflictFlags, [
      "low-direct-probability-vs-strong-fallback",
      "thunderstorm-code-vs-low-direct-probability",
      "high-elevated-deterministic-vs-zero-ensemble",
    ]);
  }
});

test("cross-source disagreements distinguish Low/positive and High/Elevated/zero", () => {
  const low = summarizeForecastEvidence({ weatherCode: 3 }, "low", support(1));
  assert.equal(low.exactPointVsEnsembleAgreement, "low-with-positive-ensemble");
  assert.deepEqual(low.conflictFlags, ["low-deterministic-vs-positive-ensemble"]);
  assert.equal(low.ensembleSupportPresent, true);
  assert.equal(low.ensembleSupportAbsent, false);
  for (const risk of ["high", "elevated"] as const) {
    const summary = summarizeForecastEvidence({}, risk, support(0));
    assert.equal(summary.exactPointVsEnsembleAgreement, "high-elevated-with-zero-ensemble");
    assert.deepEqual(summary.conflictFlags, ["high-elevated-deterministic-vs-zero-ensemble"]);
    assert.equal(summary.ensembleSupportAbsent, true);
  }
});

test("broad agreement is only a qualitative diagnostic, with no conflict", () => {
  for (const [risk, members] of [["low", 0], ["elevated", 1], ["high", 40]] as const) {
    const summary = summarizeForecastEvidence({}, risk, support(members));
    assert.equal(summary.exactPointVsEnsembleAgreement, "broad-agreement");
    assert.deepEqual(summary.conflictFlags, []);
  }
});

test("absent or invalid ensemble counts never become zero support; missing deterministic remains unavailable", () => {
  for (const ensemble of [undefined, support(0, 0), support(-1), support(41), support(1.5), support(0, NaN)]) {
    const summary = summarizeForecastEvidence({ weatherCode: 95 }, "high", ensemble);
    assert.equal(summary.exactPointVsEnsembleAgreement, "ensemble-unavailable");
    assert.equal(summary.ensembleSupportPresent, null);
    assert.equal(summary.ensembleSupportAbsent, null);
    assert.deepEqual(summary.conflictFlags, []);
  }
  const missing = summarizeForecastEvidence({ cape: 800 }, undefined, support(1));
  assert.equal(missing.exactPointVsEnsembleAgreement, "deterministic-unavailable");
  assert.equal(missing.ensembleSupportPresent, true);
  assert.deepEqual(missing.conflictFlags, []);
});

test("production classification and availability remain unchanged through combined and late ensemble diagnostics", () => {
  const cases: Array<[RiskInputs, RiskLevel | undefined]> = [
    ...[95, 96, 97, 99].map((weatherCode): [RiskInputs, RiskLevel] => [{ weatherCode, thunderstormProbability: 8 }, "high"]),
    [{ thunderstormProbability: 8, cape: 1300, precipitationProbability: 60 }, "low"],
    [{ thunderstormProbability: 19, cape: 800, precipitationProbability: 60 }, "low"],
    [{ thunderstormProbability: 20 }, "elevated"],
    [{ thunderstormProbability: 49 }, "elevated"],
    [{ thunderstormProbability: 50 }, "high"],
    [{ cape: 800, precipitationProbability: 60 }, "elevated"],
    [{ cape: 700, precipitationProbability: 40 }, "elevated"],
    [{ cape: 699, precipitationProbability: 60 }, "low"],
    [{ cape: 800, precipitationProbability: 39 }, "low"],
    [{ weatherCode: 3 }, "low"],
    [{ cape: 800 }, undefined],
    [{ precipitationProbability: 60 }, undefined],
    [{ convectiveInhibition: -25 }, undefined],
    [{}, undefined],
  ];
  for (const [input, expected] of cases) {
    const risk = hasRiskEvidence(input) ? classifyRisk(input) : undefined;
    assert.equal(risk, expected);
    const forecast: Forecast = { latitude: 39.93, longitude: 32.86, timezone: "Europe/Istanbul", fetchedAt: 1,
      hours: [{ time, ...input, risk } as Forecast["hours"][number]] };
    const primary = combineForecasts(forecast, null)!;
    const signal = expected ? { kind: "qualitative", risk: expected } : { kind: "unavailable" };
    assert.deepEqual(primary.hours[0].signal, signal);
    for (const members of [0, 1, 40]) {
      const ensemble: EnsembleForecast = { timezone: forecast.timezone, fetchedAt: 2, hours: [support(members)] };
      const combined = combineForecasts(forecast, ensemble)!;
      const late = mergeEnsembleEvidence(primary, ensemble);
      assert.deepEqual(combined.hours[0].signal, signal);
      assert.deepEqual(late.hours[0].signal, signal);
      assert.equal(combined.hours[0].risk, expected);
      assert.deepEqual(late.hours[0].diagnostics, combined.hours[0].diagnostics);
      assert.ok(combined.hours[0].diagnostics);
    }
    assert.equal(primary.hours[0].diagnostics?.exactPointVsEnsembleAgreement, "ensemble-unavailable");
  }
  const ensembleOnly = combineForecasts(null, { timezone: "UTC", fetchedAt: 2, hours: [support(40)] })!;
  assert.deepEqual(ensembleOnly.hours[0].signal, { kind: "unavailable" });
  assert.equal(ensembleOnly.hours[0].diagnostics?.deterministicEvidenceSource, "insufficient");
});
