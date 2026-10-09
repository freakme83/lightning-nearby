import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextForecastRefreshRevision } from "./forecast-refresh.ts";
import { requestLiveCheck } from "./live-observation.ts";

test("forecast refresh advances one revision only when no request is in progress", () => {
  const idle = { loadingForecast: false, locating: false, refreshPending: false };
  assert.equal(nextForecastRefreshRevision(4, idle), 5);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, loadingForecast: true }), null);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, locating: true }), null);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, refreshPending: true }), null);
});

test("manual Live refresh reuses the guarded Forecast refresh path", async () => {
  let revision = 0;
  let refreshPending = false;
  let forecastStarts = 0;
  const refreshForecast = () => {
    const next = nextForecastRefreshRevision(revision, { loadingForecast: false, locating: false, refreshPending });
    if (next === null) return;
    refreshPending = true;
    revision = next;
    forecastStarts++;
  };
  await requestLiveCheck("manual-refresh", async () => {}, refreshForecast);
  await requestLiveCheck("manual-refresh", async () => {}, refreshForecast);
  assert.equal(forecastStarts, 1);
  assert.equal(revision, 1);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../app/live-observation.tsx", import.meta.url), "utf8");
  assert.match(page, /onManualRefresh=\{refreshForecast\}/);
  assert.match(component, /checkedAt === null \? "manual-check" : "manual-refresh"/);
});
