import assert from "node:assert/strict";
import test from "node:test";
import { fetchEnsembleForecast, parseEnsembleForecast } from "./ensemble.ts";

const start = Date.UTC(2026, 8, 29, 23) / 1000;
const payload = (codes: Record<string, unknown>, times = [start, start + 3_600, start + 7_200]) => ({
  timezone: "Europe/Istanbul", hourly: { time: times, ...codes },
});

test("member counts use all available control and perturbed weather-code series", () => {
  const forecast = parseEnsembleForecast(payload({
    weather_code: [0, 95, 99],
    weather_code_member01: [1, 97, 96],
    weather_code_member02: [2, 3, 95],
  }), "icon_eu_eps", 123);
  assert.deepEqual(forecast?.hours.map(({ supportingMembers, availableMembers }) => [supportingMembers, availableMembers]), [
    [0, 3], [2, 3], [3, 3],
  ]);
  assert.equal(forecast?.hours[1].model, "ICON-EU EPS");
  assert.equal(forecast?.hours[1].time, start + 3_600);
  assert.equal(forecast?.fetchedAt, 123);
});

test("missing and malformed member values reduce the denominator for that hour", () => {
  const forecast = parseEnsembleForecast(payload({
    weather_code: [95, null, null],
    weather_code_member01: [null, 0, null],
    weather_code_member02: ["95", 99, null],
    weather_code_member03: "not-a-series",
    weather_code_mean: [95, 95, 95],
  }), "icon_global_eps");
  assert.deepEqual(forecast?.hours.map(({ supportingMembers, availableMembers }) => [supportingMembers, availableMembers]), [
    [1, 1], [1, 2],
  ]);
  assert.equal(forecast?.hours[1].model, "ICON global EPS");
  assert.equal(parseEnsembleForecast(payload({ weather_code: [null, null, null] }), "icon_eu_eps"), null);
  assert.equal(parseEnsembleForecast(payload({ weather_code: "bad" }), "icon_eu_eps"), null);
  assert.equal(parseEnsembleForecast({ hourly: { time: [start], weather_code: [95] } }, "icon_eu_eps"), null);
});

test("regional model is used in Ankara; global model covers North America", async () => {
  const requested: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const model = new URL(String(input)).searchParams.get("models") ?? "";
    requested.push(model);
    return new Response(JSON.stringify(payload({ weather_code: [0, 95, 0] })), { status: 200 });
  };
  const ankara = await fetchEnsembleForecast(39.9334, 32.8597, undefined, mockFetch);
  const miami = await fetchEnsembleForecast(25.79, -80.13, undefined, mockFetch);
  assert.deepEqual(requested, ["icon_eu_eps", "icon_global_eps"]);
  assert.equal(ankara.hours[1].supportingMembers, 1);
  assert.equal(miami.hours[1].model, "ICON global EPS");
});

test("unavailable regional data tries global, and all unavailable responses fail", async () => {
  const requested: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const model = new URL(String(input)).searchParams.get("models") ?? "";
    requested.push(model);
    return model === "icon_eu_eps" ? new Response("unavailable", { status: 400 })
      : new Response(JSON.stringify(payload({ weather_code: [0, 0, 0] })), { status: 200 });
  };
  const result = await fetchEnsembleForecast(39.9334, 32.8597, undefined, mockFetch);
  assert.deepEqual(requested, ["icon_eu_eps", "icon_global_eps"]);
  assert.equal(result.hours[0].supportingMembers, 0);
  await assert.rejects(fetchEnsembleForecast(25.79, -80.13, undefined, async () => new Response("error", { status: 503 })), /ensemble-unavailable/);
});
