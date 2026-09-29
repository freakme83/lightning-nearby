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

## Timezone fallback

- [ ] Ankara and Barcelona: normal provider civil IANA timezones remain unchanged; displayed hours and date labels match them.
- [ ] Mainland Florida: provider `America/New_York` remains unchanged, and no timezone lookup request is made.
- [ ] Offshore Gulf point near 26.77 N, 83.86 W: if Open-Meteo returns `Etc/GMT…`, verify one batched Open-Meteo timezone lookup for four nearby points resolves a civil IANA zone, and update only displayed local times/labels; Unix forecast timestamps remain unchanged.
- [ ] Vandenberg-area offshore point: confirm a nearby civil zone is used when one of the bounded probes resolves it.
- [ ] Far-open-ocean point near 36.95 N, 130.87 W: confirm it may retain the provider's fixed offset when all bounded probes remain non-civil.
- [ ] Search and confirm a place with an Open-Meteo timezone; reload and verify the saved IANA metadata is used if the forecast later returns a generic fixed offset.
- [ ] Block or fail the auxiliary Open-Meteo timezone lookup, or return malformed/fixed-offset data: forecast remains usable and keeps the provider timezone.
- [ ] Switch confirmed locations while a timezone request is pending; verify a late response from the old location cannot update the new location's labels.
- [ ] Check both sides of a DST transition in a civil zone; timeline timestamps remain chronological and displayed time follows the zone's DST rules.
- [ ] Florida follow-up acceptance: test 26.77 N, 83.86 W in the live preview and verify the displayed zone is civil (expected nearby Florida zone), local time is sensible, and forecast epoch hours are unchanged. This live check remains pending until verified in a browser.

## Forecast diagnostics route

- [ ] Open `/debug/forecast` directly; verify the normal `/` page layout and behavior are unchanged and there is no new prominent navigation link.
- [ ] Enter Florida offshore coordinates `26.77` and `-83.86`; load without device geolocation and inspect deterministic plus ensemble results.
- [ ] Invalid latitude/longitude values show validation and do not start a request.
- [ ] Use the saved-location shortcut when a monitored point exists.
- [ ] Verify deterministic data appears while ensemble remains loading; late ensemble evidence updates the selected hour without resetting it.
- [ ] Change coordinates while requests are pending; verify abort/stale guards keep old responses out of the new inspection.
- [ ] Select another hour; verify timestamps, timezone-formatted time, raw inputs, decision trace, and ensemble fields all update without a fetch.
- [ ] Compare the decision explanation with the production classifier for WMO code, provider probability bands, CAPE + precipitation fallback, and missing inputs.
- [ ] Verify ensemble-only positive support remains qualitative unavailable and positive/zero support is described as secondary evidence rather than probability.
- [ ] Copy the diagnostic snapshot and verify coordinates, epoch/UTC/local time, both timezones, deterministic values, ensemble metadata, final signal, and explanations are present; missing inputs say `unavailable`.

## Milestone 1.5 forecast signal

- [ ] Ankara, Türkiye; Barcelona, Spain; Berlin, Germany; Miami Beach, USA: confirm the timeline and selected-hour details load for ICON-EU EPS or ICON global EPS as appropriate, without exposing a member fraction as probability.
- [ ] Where direct `thunderstorm_probability` is populated, verify the actual provider percentage is displayed separately; an explicit deterministic thunderstorm code remains High even if the provider value is low.
- [ ] With all-zero local support, verify a deterministic thunderstorm code remains High and the summary still acknowledges a thunderstorm signal. Missing members remain unavailable rather than negative votes.
- [ ] With nonzero local support, verify it appears only as neutral secondary detail; Low stays Low and an unavailable qualitative hour stays unavailable. Check 5% provider probability plus 1/40 model support; use fixture tests if current live conditions have no such period.
- [ ] Block the ensemble request: the deterministic outlook continues. Block the deterministic request: ensemble evidence is retained internally but the qualitative outlook is unavailable. Block both: an unavailable state appears.
- [ ] Switch a saved location and reload: each confirmed point receives its own fresh outlook; tapping hours or moving a candidate map marker causes no ensemble refetch.
- [ ] Check midnight, mobile Safari, Chrome mobile and desktop: selected-hour support remains readable without changing the timeline layout.
- [ ] In Barcelona, compare current forecast and local model guidance as a live smoke test only; do not expect the historical 29 September 2026 conditions to recur. Confirm location selection and mobile layout still work.
