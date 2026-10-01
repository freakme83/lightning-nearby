import assert from "node:assert/strict";
import test from "node:test";
import { nextForecastRefreshRevision } from "./forecast-refresh.ts";

test("forecast refresh advances one revision only when no request is in progress", () => {
  const idle = { loadingForecast: false, locating: false, refreshPending: false };
  assert.equal(nextForecastRefreshRevision(4, idle), 5);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, loadingForecast: true }), null);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, locating: true }), null);
  assert.equal(nextForecastRefreshRevision(4, { ...idle, refreshPending: true }), null);
});
