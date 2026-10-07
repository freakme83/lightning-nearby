import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { activityMapData, formatActivityPlace, liveActivityView, lookupActivityPlace, parseActivityPlace } from "./live-activity.ts";
import { EMPTY_PROVIDER_DIAGNOSTICS, LIVE_CURRENT_EVENT_LIMIT, type CurrentLightningAvailable, type CurrentLightningEvent } from "./lightning/types.ts";

const nearest: CurrentLightningEvent = { latitude: 39.9, longitude: 32.82, observedAtMs: 1_000_000, type: "CG" };
function active(events = [nearest]): CurrentLightningAvailable {
  return { status: "active", events, windowMinutes: 5, radiusKm: 40, latestEventAt: nearest.observedAtMs,
    nearestKm: 8.2, nearestDirection: "SW", nearestAgeMinutes: 2,
    counts: { within5Km: 0, within10Km: 18, within25Km: 20, within40Km: 24 },
    totalFlashes: 24, rejectedEventCount: 0, mayBeTruncated: false, diagnostics: EMPTY_PROVIDER_DIAGNOSTICS };
}
const placePayload = { address: { suburb: "Aşağı Ayrancı", city_district: "Çankaya", city: "Ankara", state: "Ankara", country: "Türkiye" } };

test("active view supplies headline, nearest summary and a map independently of place context", () => {
  const current = active();
  const view = liveActivityView(current, 39.92, 32.85, "tr");
  assert.equal(view?.headline, "Yakında yıldırım aktivitesi var");
  assert.equal(view?.nearestLine, "8,2 km güneybatı · 2 dk önce");
  assert.equal(view?.placeContext, null);
  assert.equal(view?.map?.events[0].event, nearest);
  assert.equal(view?.map?.events[0].nearest, true);
  assert.equal(current.totalFlashes, 24);
  assert.equal(view?.map?.events.length, 1);
});

test("generic land hierarchy is concise, approximate and localized without exact-address claims", () => {
  const place = parseActivityPlace(placePayload, nearest.latitude, nearest.longitude);
  assert.deepEqual(place, { displayLabel: "Aşağı Ayrancı", parentLabel: "Çankaya", offshore: false });
  assert.equal(liveActivityView(active(), 39.92, 32.85, "tr", place)?.placeContext, "Aşağı Ayrancı / Çankaya civarı");
  assert.equal(formatActivityPlace(place, "en"), "Around Aşağı Ayrancı / Çankaya");
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { city_district: "Kadıköy", city: "İstanbul" } }, 0, 0), "tr"), "Kadıköy / İstanbul civarı");
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { village: "Yenipeçenek", municipality: "Sincan", state: "Ankara" } }, 0, 0), "tr"), "Yenipeçenek / Sincan civarı");
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { town: "San Blas", state: "Nayarit" } }, 0, 0), "tr"), "San Blas / Nayarit civarı");
});

test("explicit water context may say offshore; absent roads do not establish offshore", () => {
  const coastal = parseActivityPlace({ address: { town: "San Blas", state: "Nayarit", sea: "Pacific Ocean" } }, 0, 0);
  assert.equal(formatActivityPlace(coastal, "tr"), "San Blas açıkları / Nayarit civarı");
  assert.equal(formatActivityPlace(coastal, "en"), "Offshore from San Blas / Around Nayarit");
  assert.equal(parseActivityPlace({ address: { town: "San Blas", state: "Nayarit" } }, 0, 0)?.offshore, false);
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { sea: "Black Sea" } }, 0, 0), "en"), "Around Black Sea");
});

test("partial metadata degrades gracefully; weak metadata and distant feature localities are suppressed", () => {
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { state: "Nayarit" } }, 0, 0), "tr"), "Nayarit civarı");
  assert.equal(formatActivityPlace(parseActivityPlace({ address: { city: "Berlin", state: "Berlin" } }, 0, 0), "en"), "Around Berlin");
  for (const value of [null, {}, { address: [] }, { address: { road: "A street", house_number: "12", country: "Türkiye" } }]) {
    assert.equal(parseActivityPlace(value, 0, 0), null);
  }
  assert.deepEqual(parseActivityPlace({ lat: "1", lon: "1", address: { suburb: "Distant suburb", county: "Coastal county", state: "Region" } }, 0, 0),
    { displayLabel: "Coastal county", parentLabel: "Region", offshore: false });
});

test("multiple API events stay bounded, retain nearest identity, and fit with the monitored point", () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ ...nearest, latitude: 39.9 + i * .001 }));
  const data = activityMapData(active(events), 39.89, 32.85)!;
  assert.equal(LIVE_CURRENT_EVENT_LIMIT, 12);
  assert.equal(data.events.length, 12);
  assert.deepEqual(data.events.map(item => item.event), events.slice(0, 12));
  assert.equal(data.events.filter(item => item.nearest).length, 1);
  assert.equal(data.events[0].event, events[0]);
  assert.deepEqual(data.bounds[0], [39.89, data.events[0].point[1]]);
  assert.deepEqual(data.bounds[1], [events[11].latitude, 32.85]);
});

test("one event, tightly coincident points and antimeridian crossings have useful bounds", () => {
  const one = activityMapData(active(), 39.92, 32.85)!;
  assert.deepEqual(one.monitored, [39.92, 32.85]);
  assert.equal(one.bounds[0][0], nearest.latitude);
  assert.equal(one.bounds[1][0], 39.92);
  const coincident = activityMapData(active(), nearest.latitude, nearest.longitude)!;
  assert.deepEqual(coincident.bounds[0], coincident.bounds[1]);
  const crossing = activityMapData(active([{ ...nearest, latitude: 0, longitude: -179.9 }]), 0, 179.9)!;
  assert.ok(crossing.bounds[1][1] - crossing.bounds[0][1] < .3);
});

test("clear, unavailable, Summary-clear and empty active data never create a map", () => {
  assert.equal(liveActivityView({ ...active(), status: "clear" }, 0, 0, "tr"), null);
  assert.equal(activityMapData({ ...active(), status: "clear" }, 0, 0), null);
  assert.equal(activityMapData({ status: "unavailable", windowMinutes: 5, radiusKm: 40, failureStatus: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS }, 0, 0), null);
  assert.equal(activityMapData({ status: "not-requested", windowMinutes: 5, radiusKm: 40 }, 0, 0), null);
  assert.equal(activityMapData(active([]), 0, 0), null);
  assert.equal(activityMapData(undefined, 0, 0), null);
  assert.equal(liveActivityView(active([]), 0, 0, "tr")?.headline, "Yakında yıldırım aktivitesi var");
});

test("UI guards never invent coordinates or invalid-time map points", () => {
  assert.equal(activityMapData(active([{ ...nearest, latitude: 999 }]), 0, 0), null);
  assert.equal(activityMapData(active([{ ...nearest, observedAtMs: NaN }]), 0, 0), null);
  assert.equal(activityMapData(active(), NaN, 0), null);
});

test("reverse lookup makes one request for the representative point using existing production request shape", async () => {
  const urls: URL[] = [];
  const context = await lookupActivityPlace(nearest, new AbortController().signal, "tr", async (input, init) => {
    urls.push(new URL(String(input)));
    assert.equal(init?.referrerPolicy, "strict-origin");
    assert.ok(init?.signal);
    return new Response(JSON.stringify(placePayload));
  });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].origin, "https://nominatim.openstreetmap.org");
  assert.equal(urls[0].searchParams.get("lat"), String(nearest.latitude));
  assert.equal(urls[0].searchParams.get("lon"), String(nearest.longitude));
  assert.equal(urls[0].searchParams.get("zoom"), "14");
  assert.equal(urls[0].searchParams.get("accept-language"), "tr");
  assert.equal(formatActivityPlace(context, "tr"), "Aşağı Ayrancı / Çankaya civarı");
});

test("failed, rate-limited, weak and malformed lookup results leave active text and map usable", async () => {
  for (const fetcher of [
    async () => { throw Error("network"); },
    async () => new Response("limited", { status: 429 }),
    async () => new Response("not json"),
    async () => new Response(JSON.stringify({ address: { country: "Türkiye" } })),
  ]) {
    const place = await lookupActivityPlace(nearest, new AbortController().signal, "tr", fetcher);
    const view = liveActivityView(active(), 39.92, 32.85, "tr", place)!;
    assert.equal(view.placeContext, null);
    assert.equal(view.nearestLine, "8,2 km güneybatı · 2 dk önce");
    assert.ok(view.map);
  }
});

test("a timed-out or superseded place lookup cannot return a stale label", async () => {
  const controller = new AbortController();
  const pending = lookupActivityPlace(nearest, controller.signal, "tr", async () => {
    controller.abort();
    return new Response(JSON.stringify(placePayload));
  });
  assert.equal(await pending, null);
  const context = await lookupActivityPlace(nearest, new AbortController().signal, "tr", async (_input, init) => {
    await new Promise<void>(resolve => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return new Response(JSON.stringify(placePayload));
  }, 10);
  assert.equal(context, null);
});

test("pre-aborted lookups make zero requests", async () => {
  let calls = 0;
  const signal = AbortSignal.abort();
  assert.equal(await lookupActivityPlace(nearest, signal, "tr", async () => { calls++; return new Response(); }), null);
  assert.equal(calls, 0);
});

test("production imports stay separate from research-only modules", () => {
  function inspect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) inspect(path);
      else if (/\.tsx?$/.test(path)) assert.doesNotMatch(readFileSync(path, "utf8"), /(?:from\s*|import\s*\()["'][^"']*(?:scripts\/|lightning-location-naming|lightning-incident-lifecycle|live-lightning-listener)/, path);
    }
  }
  inspect("src");
});
