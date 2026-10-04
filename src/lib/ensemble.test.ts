import assert from "node:assert/strict";
import test from "node:test";
import { fetchEnsembleForecast, localSamplePoints, parseEnsembleForecast } from "./ensemble.ts";

const target = Date.UTC(2026, 8, 29, 16) / 1000;
const times = Array.from({ length: 5 }, (_, i) => target + (i - 2) * 3_600);
const point = (members: Record<string, unknown>, hourlyTimes = times) => ({
  timezone: "Europe/Madrid", hourly: { time: hourlyTimes, ...members },
});
const clear = [0, 0, 0, 0, 0];
const read = (locations: unknown[], expectedLocations = 5) => parseEnsembleForecast(locations, "icon_eu_eps", 123, expectedLocations)!;
const atTarget = (locations: unknown[], expectedLocations = 5) => read(locations, expectedLocations).hours.find((hour) => hour.time === target)!;

test("center and cardinal points stay within one ICON grid spacing, including longitude wrap", () => {
  for (const [model, km] of [["icon_eu_eps", 13], ["icon_global_eps", 26]] as const) {
    const samples = localSamplePoints(41.3851, 2.1734, model);
    assert.equal(samples.length, 5);
    assert.deepEqual(samples[0], { latitude: 41.3851, longitude: 2.1734 });
    assert.ok(Math.abs((samples[1].latitude - samples[0].latitude) * 111.32 - km) < 0.01);
    assert.ok(Math.abs((samples[3].longitude - samples[0].longitude) * 111.32 * Math.cos(41.3851 * Math.PI / 180) - km) < 0.01);
  }
  assert.ok(localSamplePoints(20, 179.95, "icon_eu_eps")[3].longitude < 0);
});

test("center, nearby, and different members support the same target hour once per member", () => {
  const center = point({ weather_code: [0, 0, 95, 0, 0], weather_code_member01: clear, weather_code_member02: clear });
  const east = point({ weather_code: [0, 0, 99, 0, 0], weather_code_member01: [0, 0, 97, 0, 0] });
  assert.deepEqual([atTarget([center]), atTarget([point({ weather_code: clear }), east])]
    .map(({ supportingMembers, availableMembers }) => [supportingMembers, availableMembers]), [[1, 3], [2, 2]]);
  const both = atTarget([center, east]);
  assert.deepEqual([both.supportingMembers, both.availableMembers], [2, 3]);
  assert.equal(both.spatialWindowKm, 13);
  assert.equal(both.sampledLocations, 2);
  assert.equal(both.temporalWindowHours, 1);
  assert.equal(read([center, east]).fetchedAt, 123);
});

test("only the target hour and one hour on either side contribute, deduplicating a member across hours", () => {
  const before = point({ weather_code: [0, 95, 0, 0, 0] });
  const after = point({ weather_code: [0, 0, 0, 96, 0] });
  const outside = point({ weather_code: [95, 0, 0, 0, 99] });
  assert.equal(atTarget([before, after]).supportingMembers, 1);
  assert.equal(atTarget([outside]).supportingMembers, 0);
  assert.equal(atTarget([point({ weather_code: [0, 0, 97, 0, 0] })]).supportingMembers, 1);
  assert.equal(atTarget([point({ weather_code: clear, weather_code_member01: [0, 95, 0, 0, 0] }),
    point({ weather_code: clear, weather_code_member01: [0, 0, 0, 99, 0] })]).supportingMembers, 1);
});

test("unrequested spatial points cannot enter support, and malformed data is excluded", () => {
  const inside = point({ weather_code: clear });
  const outside = point({ weather_code: [0, 0, 95, 0, 0] });
  assert.equal(atTarget([inside, inside, inside, inside, inside, outside]).supportingMembers, 0);
  assert.equal(atTarget([inside, outside], 1).supportingMembers, 0);
  const partial = atTarget([null, point({ weather_code: [null, null, null, null, null],
    weather_code_member01: [null, null, 95, null, null], weather_code_member02: [null, 0, null, null, null],
    weather_code_member03: [null, "95", 200, null, null], weather_code_mean: [95, 95, 95, 95, 95] })]);
  assert.deepEqual([partial.supportingMembers, partial.availableMembers], [1, 2]);
  assert.equal(partial.sampledLocations, 1);
  assert.equal(parseEnsembleForecast([null, point({ weather_code: [null, null, null, null, null] })], "icon_eu_eps"), null);
  assert.equal(parseEnsembleForecast({ hourly: { time: times, weather_code: clear } }, "icon_eu_eps"), null);
});

test("one batched weather-code request covers five samples; model selection uses European or global grid", async () => {
  const requested: URL[] = [];
  const mockFetch: typeof fetch = async (input) => {
    requested.push(new URL(String(input)));
    return new Response(JSON.stringify(Array.from({ length: 5 }, () => point({ weather_code: clear }))), { status: 200 });
  };
  const barcelona = await fetchEnsembleForecast(41.3851, 2.1734, undefined, mockFetch);
  const miami = await fetchEnsembleForecast(25.79, -80.13, undefined, mockFetch);
  assert.equal(requested.length, 2);
  assert.deepEqual(requested.map((url) => url.searchParams.get("models")), ["icon_eu_eps", "icon_global_eps"]);
  for (const url of requested) {
    assert.equal(url.searchParams.get("latitude")?.split(",").length, 5);
    assert.equal(url.searchParams.get("longitude")?.split(",").length, 5);
    assert.equal(url.searchParams.get("hourly"), "weather_code");
    assert.equal(url.searchParams.get("forecast_hours"), "26");
    assert.equal(url.searchParams.get("past_hours"), "1");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
  }
  assert.equal(barcelona.hours[0].model, "ICON-EU EPS");
  assert.equal(miami.hours[0].spatialWindowKm, 26);
});

test("partial batch is usable; a failed batch tries regional center then global if needed", async () => {
  const partial = await fetchEnsembleForecast(41.3851, 2.1734, undefined,
    async () => new Response(JSON.stringify([point({ weather_code: clear }), null]), { status: 200 }));
  assert.equal(partial.hours[2].availableMembers, 1);

  const requests: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.searchParams.get("models")}:${url.searchParams.get("latitude")?.split(",").length}`);
    return requests.length === 1 ? new Response("bad regional edge", { status: 400 })
      : new Response(JSON.stringify(point({ weather_code: clear })), { status: 200 });
  };
  const center = await fetchEnsembleForecast(41.3851, 2.1734, undefined, mockFetch);
  assert.deepEqual(requests, ["icon_eu_eps:5", "icon_eu_eps:1"]);
  assert.equal(center.hours[2].supportingMembers, 0);
  assert.equal(center.hours[2].spatialWindowKm, 0);
  assert.equal(center.hours[2].sampledLocations, 1);

  await assert.rejects(fetchEnsembleForecast(25.79, -80.13, undefined,
    async () => new Response("down", { status: 503 })), /ensemble-unavailable/);
});

test("duplicate returned effective coordinates count once without changing support or sampledLocations", () => {
  const center = { ...point({ weather_code: clear }), latitude: 39.875, longitude: 32.875 };
  const duplicate = { ...point({ weather_code: [0, 0, 95, 0, 0] }), latitude: 39.875, longitude: 32.875 };
  const north = { ...center, latitude: 40 };
  const hour = atTarget([center, north, duplicate, { ...center, longitude: 33 }, { ...center, longitude: 32.75 }]);
  assert.equal(hour.sampledLocations, 5);
  assert.equal(hour.supportingMembers, 1);
  assert.equal(hour.availableMembers, 1);
  assert.equal(hour.sampleDiagnostics?.requestedLocations, 5);
  assert.equal(hour.sampleDiagnostics?.returnedLocations, 5);
  assert.equal(hour.sampleDiagnostics?.usableLocations, 5);
  assert.equal(hour.sampleDiagnostics?.uniqueEffectiveLocations, 4);
  assert.equal(hour.sampleDiagnostics?.effectiveCoordinateStatus, "complete");
  assert.equal(hour.sampleDiagnostics?.gridCellIdentity, "unconfirmed");
  assert.deepEqual(hour.sampleDiagnostics?.samples[2], { responseIndex: 2, effectiveCoordinates: { latitude: 39.875, longitude: 32.875 } });
});

test("malformed or absent effective coordinates retain usable weather but cannot establish full uniqueness", () => {
  const valid = { ...point({ weather_code: clear }), latitude: 0, longitude: 0 };
  for (const coords of [{ latitude: "0", longitude: 0 }, { latitude: NaN, longitude: 0 },
    { latitude: Infinity, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
    { latitude: 0 }, { latitude: 0, longitude: null }, {}]) {
    const hour = atTarget([valid, { ...point({ weather_code: clear }), ...coords }]);
    assert.equal(hour.sampledLocations, 2);
    assert.equal(hour.sampleDiagnostics?.locationsWithEffectiveCoordinates, 1);
    assert.equal(hour.sampleDiagnostics?.uniqueEffectiveLocations, undefined);
    assert.equal(hour.sampleDiagnostics?.effectiveCoordinateStatus, "partial");
    assert.equal(hour.sampleDiagnostics?.samples[1].effectiveCoordinates, undefined);
  }
  assert.equal(atTarget([point({ weather_code: clear })]).sampleDiagnostics?.effectiveCoordinateStatus, "unavailable");
});

test("response counts exclude unusable locations from effective uniqueness and record center-only requests", () => {
  const valid = { ...point({ weather_code: clear }), latitude: 39.875, longitude: 32.875 };
  const hour = atTarget([null, valid, { latitude: 40, longitude: 33 }]);
  assert.equal(hour.sampleDiagnostics?.returnedLocations, 3);
  assert.equal(hour.sampleDiagnostics?.usableLocations, 1);
  assert.equal(hour.sampleDiagnostics?.uniqueEffectiveLocations, 1);
  assert.equal(hour.sampleDiagnostics?.samples[0].responseIndex, 1);
  const center = parseEnsembleForecast(valid, "icon_eu_eps", 123, 1)!.hours[0];
  assert.equal(center.sampleDiagnostics?.requestedLocations, 1);
  assert.equal(center.sampleDiagnostics?.returnedLocations, 1);
  assert.equal(center.sampleDiagnostics?.uniqueEffectiveLocations, 1);
  assert.equal(center.spatialWindowKm, 0);
});
