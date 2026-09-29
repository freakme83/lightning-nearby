# Milestone 1 manual QA

- [ ] Fresh load: location is not requested until **Use my location** is tapped.
- [ ] Accept geolocation: rounded coordinates are saved on-device and a current forecast loads.
- [ ] Deny geolocation: a clear message appears; retry remains available.
- [ ] Retry location after changing browser/device permission.
- [ ] Update location: the newly chosen location replaces the single saved location.
- [ ] Search suggestions: type Ankara, Berlin, and Miami Beach; verify suggestions appear after a short pause, show available region/country context, and do not save before confirmation.
- [ ] Search fallback: type `Ayrancı, Ankara`; verify any broader-context fallback is explained and an unrelated Ayrancı result is not labeled as being in Ankara. Also try `Ayrancı` alone.
- [ ] Keyboard search: press Enter while typing a query and verify the current query is searched.
- [ ] Search loading, no-results, and network-error states are understandable; older results do not replace results for a newer query.
- [ ] Search selection: choose a result, verify the map opens centered with one marker, then confirm and verify the forecast uses the saved coordinates.
- [ ] Map selection: pan/zoom and tap a point; verify only the candidate marker changes until **Use this location** is tapped.
- [ ] Confirm map points in Samsun/Ankara and another country; verify a useful place label appears when reverse lookup succeeds.
- [ ] Move a searched result's marker and confirm: verify its old search label is replaced by a label for the new point when available.
- [ ] Simulate reverse-geocoding failure; verify the point still saves and coordinates are shown as fallback.
- [ ] Cancel the picker after search/map changes; verify the previous saved location and forecast remain unchanged.
- [ ] Reload after confirming a searched or map-selected point; verify coordinates and optional display label persist.
- [ ] Mobile Safari and Chrome mobile: verify map pan, pinch zoom, tap-to-place, confirmation, keyboard behavior, and that suggestions do not obscure key controls.
- [ ] Chrome desktop: verify map drag/zoom/click, place search, and saved-location reload.
- [ ] Forecast fetch failure: block `api.open-meteo.com`; verify an explicit unavailable state and no stale forecast.
- [ ] Mobile viewport: check 320 px and 390 px widths, touch targets, timeline scrolling, and details.
- [ ] Midnight/time zone: use coordinates in another time zone and verify local date changes.
- [ ] DST: test around spring-forward/fall-back; timeline order should remain chronological.
- [ ] PWA installability: serve over HTTPS, inspect manifest/service worker, and try installation on Android and iOS.
- [ ] Reload with saved location: forecast reloads without another permission prompt.
- [ ] No network: cached shell may reopen, but the forecast must report unavailable rather than show old values.

## Milestone 1.5 forecast signal

- [ ] Ankara, Türkiye; Barcelona, Spain; Berlin, Germany; Miami Beach, USA: confirm the timeline and selected-hour details load for ICON-EU EPS or ICON global EPS as appropriate, without exposing a member fraction as probability.
- [ ] Where direct `thunderstorm_probability` is populated, verify the actual provider percentage is displayed separately; an explicit deterministic thunderstorm code remains High even if the provider value is low.
- [ ] With all-zero local support, verify a deterministic thunderstorm code remains High and the summary still acknowledges a thunderstorm signal. Missing members remain unavailable rather than negative votes.
- [ ] With nonzero local support, verify it appears only as neutral secondary detail; Low stays Low and an unavailable qualitative hour stays unavailable. Check 5% provider probability plus 1/40 model support; use fixture tests if current live conditions have no such period.
- [ ] Block the ensemble request: the deterministic outlook continues. Block the deterministic request: ensemble evidence is retained internally but the qualitative outlook is unavailable. Block both: an unavailable state appears.
- [ ] Switch a saved location and reload: each confirmed point receives its own fresh outlook; tapping hours or moving a candidate map marker causes no ensemble refetch.
- [ ] Check midnight, mobile Safari, Chrome mobile and desktop: selected-hour support remains readable without changing the timeline layout.
- [ ] In Barcelona, compare current forecast and local model guidance as a live smoke test only; do not expect the historical 29 September 2026 conditions to recur. Confirm location selection and mobile layout still work.
