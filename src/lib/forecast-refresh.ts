/** Return a new refresh trigger only when no location or forecast request is in progress. */
export function nextForecastRefreshRevision(
  currentRevision: number,
  state: { loadingForecast: boolean; locating: boolean; refreshPending: boolean },
): number | null {
  if (state.loadingForecast || state.locating || state.refreshPending) return null;
  return currentRevision + 1;
}
