import assert from "node:assert/strict";
import test from "node:test";
import { calculateHighestRiskWindow, classifyRisk, describeWeatherCode, explainRiskDecision, hasRiskEvidence, selectNext24Hours, type ForecastHour } from "./weather.ts";

const hour = (time: number, risk: ForecastHour["risk"]): ForecastHour => ({ time, risk });

test("direct thunderstorm weather codes classify as high", () => {
  for (const weatherCode of [95, 96, 97, 99]) {
    assert.equal(classifyRisk({ weatherCode }), "high");
    assert.equal(describeWeatherCode(weatherCode), "Thunderstorm signal");
  }
  assert.equal(classifyRisk({ weatherCode: 95, thunderstormProbability: 0 }), "high");
});

test("precipitation alone and CAPE alone do not imply thunderstorm risk", () => {
  assert.equal(classifyRisk({ precipitationProbability: 90 }), "low");
  assert.equal(classifyRisk({ cape: 1600 }), "low");
  assert.equal(classifyRisk({ cape: 1200, precipitationProbability: 20 }), "low");
});

test("direct thunderstorm probability classifies below, within, and above its thresholds", () => {
  assert.equal(classifyRisk({ thunderstormProbability: 19 }), "low");
  assert.equal(classifyRisk({ thunderstormProbability: 19, cape: 800, precipitationProbability: 60 }), "low");
  assert.equal(classifyRisk({ thunderstormProbability: 20 }), "elevated");
  assert.equal(classifyRisk({ thunderstormProbability: 49 }), "elevated");
  assert.equal(classifyRisk({ thunderstormProbability: 50 }), "high");
  assert.equal(classifyRisk({ thunderstormProbability: 55 }), "high");
});

test("CAPE and precipitation raise risk only when direct thunderstorm probability is missing", () => {
  assert.equal(classifyRisk({ cape: 800, precipitationProbability: 60 }), "elevated");
  assert.equal(classifyRisk({ thunderstormProbability: null, cape: 800, precipitationProbability: 60 }), "elevated");
});

test("missing optional forecast values safely fall back to low", () => {
  assert.equal(classifyRisk({ weatherCode: null, cape: null, precipitationProbability: null, thunderstormProbability: null }), "low");
  assert.equal(classifyRisk({ convectiveInhibition: 0 }), "low");
});

test("a qualitative level requires a usable deterministic signal", () => {
  assert.equal(hasRiskEvidence({}), false);
  assert.equal(hasRiskEvidence({ cape: 800 }), false);
  assert.equal(hasRiskEvidence({ precipitationProbability: 50 }), false);
  assert.equal(hasRiskEvidence({ cape: 800, precipitationProbability: 50 }), true);
  assert.equal(hasRiskEvidence({ weatherCode: 3 }), true);
  assert.equal(hasRiskEvidence({ thunderstormProbability: 0 }), true);
});

test("convective inhibition is informational and does not change the qualitative heuristic", () => {
  assert.equal(classifyRisk({ cape: 800, precipitationProbability: 60, convectiveInhibition: -500 }), "elevated");
  assert.equal(classifyRisk({ cape: 800, precipitationProbability: 60, convectiveInhibition: 0 }), "elevated");
});

test("shared risk decision explains thunderstorm WMO code precedence", () => {
  assert.deepEqual(explainRiskDecision({ weatherCode: 95, thunderstormProbability: 0 }), {
    risk: "high",
    explanation: "High because deterministic WMO thunderstorm code 95 is present.",
  });
});

test("shared risk decision explains provider probability high and Elevated bands", () => {
  assert.equal(explainRiskDecision({ thunderstormProbability: 63 }).risk, "high");
  assert.match(explainRiskDecision({ thunderstormProbability: 63 }).explanation, /63%.*50% High threshold/);
  assert.equal(explainRiskDecision({ thunderstormProbability: 34 }).risk, "elevated");
  assert.match(explainRiskDecision({ thunderstormProbability: 34 }).explanation, /34%.*20–49% Elevated range/);
});

test("low provider probability explanation says it takes precedence over CAPE and precipitation", () => {
  const decision = explainRiskDecision({ thunderstormProbability: 8, cape: 1320, precipitationProbability: 58 });
  assert.equal(decision.risk, "low");
  assert.match(decision.explanation, /8%/);
  assert.match(decision.explanation, /takes precedence over the CAPE \+ precipitation fallback/);
});

test("shared risk decision explains the deterministic CAPE plus precipitation fallback", () => {
  const decision = explainRiskDecision({ cape: 1320, precipitationProbability: 58 });
  assert.equal(decision.risk, "elevated");
  assert.match(decision.explanation, /CAPE is 1320 J\/kg/);
  assert.match(decision.explanation, /precipitation probability is 58%/);
  assert.match(decision.explanation, /qualitative fallback/);
});

test("shared risk decision explains when fallback thresholds are not both met", () => {
  const decision = explainRiskDecision({ weatherCode: 61, cape: 600, precipitationProbability: 70 });
  assert.equal(decision.risk, "low");
  assert.match(decision.explanation, /thresholds .* were not both met/);
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
