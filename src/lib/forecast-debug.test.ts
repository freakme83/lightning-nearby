import assert from "node:assert/strict";
import test from "node:test";
import { combineForecasts } from "./outlook.ts";
import { createForecastDebugSnapshot } from "./forecast-debug.ts";
import type { Forecast } from "./weather.ts";
import type { EnsembleForecast } from "./ensemble.ts";

const time = Date.UTC(2026, 8, 29, 16) / 1_000;
const forecast: Forecast = {
  timezone: "Etc/GMT+6",
  latitude: 26.77,
  longitude: -83.83,
  fetchedAt: 1_800_000_000_000,
  hours: [{
    time,
    weatherCode: 61,
    thunderstormProbability: 8,
    precipitationProbability: 58,
    cape: 1_320,
    convectiveInhibition: -25,
    risk: "low",
  }],
};
const ensemble: EnsembleForecast = {
  timezone: "Etc/GMT+6",
  fetchedAt: 1_800_000_000_100,
  hours: [{
    time,
    supportingMembers: 1,
    availableMembers: 40,
    model: "ICON-EU EPS",
    spatialWindowKm: 13,
    temporalWindowHours: 1,
    sampledLocations: 5,
  }],
};

test("diagnostic snapshot contains coordinates, UTC and local time, evidence, final signal, and explanation", () => {
  const outlook = combineForecasts(forecast, ensemble)!;
  const snapshot = JSON.parse(createForecastDebugSnapshot({
    latitude: 26.77,
    longitude: -83.83,
    hour: outlook.hours[0],
    providerTimezone: "Etc/GMT+6",
    displayTimezone: "America/New_York",
    ensembleStatus: "available",
    ensembleFetchedAt: outlook.ensembleFetchedAt,
  }));
  assert.deepEqual(snapshot.coordinates, { latitude: 26.77, longitude: -83.83 });
  assert.equal(snapshot.selectedTime.unixTimestamp, time);
  assert.equal(snapshot.selectedTime.utcIso, "2026-09-29T16:00:00.000Z");
  assert.equal(snapshot.selectedTime.localTime, "12:00");
  assert.equal(snapshot.timezones.provider, "Etc/GMT+6");
  assert.equal(snapshot.timezones.resolvedDisplay, "America/New_York");
  assert.equal(snapshot.deterministic.thunderstormProbabilityPercent, 8);
  assert.equal(snapshot.deterministic.precipitationProbabilityPercent, 58);
  assert.equal(snapshot.deterministic.capeJPerKg, 1_320);
  assert.equal(snapshot.deterministic.convectiveInhibitionJPerKg, -25);
  assert.equal(snapshot.ensemble.model, "ICON-EU EPS");
  assert.equal(snapshot.ensemble.supportingMembers, 1);
  assert.equal(snapshot.ensemble.availableMembers, 40);
  assert.equal(snapshot.finalOutlook.qualitativeLevel, "low");
  assert.match(snapshot.decision.qualitativeExplanation, /provider thunderstorm probability is 8%/);
  assert.match(snapshot.decision.ensembleExplanation, /secondary evidence/);
  assert.equal(snapshot.deterministic.evidenceSource, "direct-provider-probability");
  assert.equal(snapshot.deterministic.evidenceQuality, "direct");
  assert.deepEqual(snapshot.evidenceSummary.conflictFlags, [
    "low-direct-probability-vs-strong-fallback", "low-deterministic-vs-positive-ensemble",
  ]);
  assert.equal(snapshot.evidenceSummary.exactPointVsEnsembleAgreement, "low-with-positive-ensemble");
  assert.equal(snapshot.evidenceSummary.ensembleSupportPresent, true);
});

test("snapshot represents missing deterministic and ensemble data as unavailable, never zero", () => {
  const noInputs: Forecast = {
    timezone: "Europe/Istanbul",
    latitude: 39.93,
    longitude: 32.86,
    fetchedAt: 1_800_000_000_000,
    hours: [{ time }],
  };
  const hour = combineForecasts(noInputs, null)!.hours[0];
  const snapshot = JSON.parse(createForecastDebugSnapshot({
    latitude: 39.93,
    longitude: 32.86,
    hour,
    providerTimezone: "Europe/Istanbul",
    displayTimezone: "Europe/Istanbul",
    ensembleStatus: "unavailable",
  }));
  assert.equal(snapshot.deterministic.weatherCode, "unavailable");
  assert.equal(snapshot.deterministic.thunderstormProbabilityPercent, "unavailable");
  assert.equal(snapshot.deterministic.precipitationProbabilityPercent, "unavailable");
  assert.equal(snapshot.deterministic.capeJPerKg, "unavailable");
  assert.equal(snapshot.deterministic.convectiveInhibitionJPerKg, "unavailable");
  assert.equal(snapshot.ensemble.supportingMembers, "unavailable");
  assert.equal(snapshot.ensemble.availableMembers, "unavailable");
  assert.equal(snapshot.finalOutlook.signalKind, "unavailable");
  assert.match(snapshot.decision.qualitativeExplanation, /signal unavailable/);
  assert.equal(snapshot.evidenceSummary.deterministicEvidenceSource, "insufficient");
  assert.equal(snapshot.evidenceSummary.exactPointVsEnsembleAgreement, "ensemble-unavailable");
  assert.equal(snapshot.evidenceSummary.ensembleSupportAbsent, null);
  assert.equal(snapshot.ensemble.sampleDiagnostics, "unavailable");
});

test("snapshot includes effective sample counts and returned coordinates without provider credentials", () => {
  const support = { ...ensemble.hours[0], sampleDiagnostics: {
    requestedLocations: 5, returnedLocations: 5, usableLocations: 5, locationsWithEffectiveCoordinates: 5,
    uniqueEffectiveLocations: 4, effectiveCoordinateStatus: "complete" as const, gridCellIdentity: "unconfirmed" as const,
    samples: [{ responseIndex: 0, effectiveCoordinates: { latitude: 39.875, longitude: 32.875 } }],
  } };
  const hour = combineForecasts(forecast, { ...ensemble, hours: [support] })!.hours[0];
  const text = createForecastDebugSnapshot({ latitude: 39.93, longitude: 32.86, hour, ensembleStatus: "available" });
  const snapshot = JSON.parse(text);
  assert.deepEqual(snapshot.ensemble.sampleDiagnostics, support.sampleDiagnostics);
  assert.doesNotMatch(text, /client_secret|client_id|api_key|token|https:\/\//i);
});
