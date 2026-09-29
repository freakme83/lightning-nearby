import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentForecastRequest } from "./outlook.ts";
import { formatForecastLocalTime, isGenericFixedOffsetTimezone, resolveDisplayTimezone } from "./timezone.ts";

test("normal civil provider timezones pass through without another request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls += 1; throw new Error("should-not-fetch"); };
  assert.equal(await resolveDisplayTimezone(39.93, 32.86, "Europe/Istanbul", undefined, undefined, fetcher), "Europe/Istanbul");
  assert.equal(await resolveDisplayTimezone(40.71, -74.01, "America/New_York", undefined, undefined, fetcher), "America/New_York");
  assert.equal(calls, 0);
});

test("generic Etc/GMT fixed offsets are detected", () => {
  assert.equal(isGenericFixedOffsetTimezone("Etc/GMT+6"), true);
  assert.equal(isGenericFixedOffsetTimezone("Etc/GMT-3"), true);
  assert.equal(isGenericFixedOffsetTimezone("Etc/GMT"), true);
  assert.equal(isGenericFixedOffsetTimezone("Europe/Istanbul"), false);
  assert.equal(isGenericFixedOffsetTimezone("America/New_York"), false);
});

test("generic timezone uses the exact coordinate result when it is civil", async () => {
  let requestedUrl = "";
  let requestMode = "";
  const timezone = await resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, undefined, async (input, init) => {
    requestedUrl = String(input);
    requestMode = init?.mode ?? "";
    return new Response(JSON.stringify({ iana_timezone: "America/New_York" }), { status: 200 });
  });
  const url = new URL(requestedUrl);
  assert.equal(url.origin, "https://api.geotimezone.com");
  assert.equal(url.pathname, "/public/timezone");
  assert.equal(url.searchParams.get("latitude"), "26.77");
  assert.equal(url.searchParams.get("longitude"), "-83.86");
  assert.equal(requestMode, "cors");
  assert.equal(timezone, "America/New_York");
});

test("selected place timezone is preferred and invalid or nautical lookup values are ignored", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ iana_timezone: "Etc/GMT+6" }), { status: 200 });
  };
  assert.equal(await resolveDisplayTimezone(39.93, 32.86, "Etc/GMT+3", "Europe/Istanbul", undefined, fetcher), "Europe/Istanbul");
  assert.equal(calls, 0);
  assert.equal(await resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, undefined, fetcher), "Etc/GMT+6");
  assert.equal(calls, 5);
});

test("Florida offshore regression probes nearby coordinates and resolves a civil zone", async () => {
  const requestedCoordinates: Array<[number, number]> = [];
  const timezone = await resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, undefined, async (input) => {
    const url = new URL(String(input));
    const latitude = Number(url.searchParams.get("latitude"));
    const longitude = Number(url.searchParams.get("longitude"));
    requestedCoordinates.push([latitude, longitude]);
    if (requestedCoordinates.length === 3) {
      assert.ok(latitude > 26.7 && latitude < 26.9);
      assert.ok(longitude > -82.4 && longitude < -82.3);
      return new Response(JSON.stringify({ iana_timezone: "America/New_York" }), { status: 200 });
    }
    return new Response(JSON.stringify({ iana_timezone: "Etc/GMT+6" }), { status: 200 });
  });
  assert.equal(timezone, "America/New_York");
  assert.equal(requestedCoordinates.length, 3);
});

test("far-ocean probes can remain on the provider fixed offset", async () => {
  let calls = 0;
  const timezone = await resolveDisplayTimezone(36.95, -130.87, "Etc/GMT", undefined, undefined, async () => {
    calls += 1;
    return new Response(JSON.stringify({ iana_timezone: "Etc/GMT" }), { status: 200 });
  });
  assert.equal(timezone, "Etc/GMT");
  assert.equal(calls, 5);
});

test("lookup failure preserves the forecast provider timezone", async () => {
  let calls = 0;
  const timezone = await resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, undefined, async () => {
    calls += 1;
    throw new Error("network-down");
  });
  assert.equal(timezone, "Etc/GMT+6");
  assert.equal(calls, 1);
  const malformed = await resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, undefined, async () =>
    new Response(JSON.stringify({ iana_timezone: "not/a-zone" }), { status: 200 }));
  assert.equal(malformed, "Etc/GMT+6");
});

test("Unix forecast timestamps stay unchanged and format with civil DST rules", () => {
  const beforeDst = Date.UTC(2026, 2, 8, 6) / 1000;
  const afterDst = Date.UTC(2026, 2, 8, 7) / 1000;
  assert.equal(formatForecastLocalTime(beforeDst, "America/New_York"), "01:00");
  assert.equal(formatForecastLocalTime(afterDst, "America/New_York"), "03:00");
  assert.equal(afterDst - beforeDst, 3_600);
});

test("timezone resolution from a previous confirmed location is discarded after location change", async () => {
  const oldController = new AbortController();
  let releaseOldLookup!: (response: Response) => void;
  let currentRequestId = 1;
  const oldLookup = resolveDisplayTimezone(26.77, -83.86, "Etc/GMT+6", undefined, oldController.signal,
    async () => new Promise<Response>((resolve) => { releaseOldLookup = resolve; }));

  oldController.abort();
  currentRequestId += 1;
  const newTimezone = await resolveDisplayTimezone(39.93, 32.86, "Etc/GMT+3", "Europe/Istanbul");
  releaseOldLookup(new Response(JSON.stringify({ iana_timezone: "America/New_York" }), { status: 200 }));
  const staleTimezone = await oldLookup;
  assert.equal(isCurrentForecastRequest(1, currentRequestId, oldController.signal), false);
  assert.equal(newTimezone, "Europe/Istanbul");
  assert.equal(staleTimezone, "Etc/GMT+6");
});
