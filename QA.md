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

- [ ] Ankara, Türkiye: confirm ICON-EU EPS support appears when member data is available; the summary gives a member count and model name, never a made-up percentage.
- [ ] European point (for example Berlin) and North American point (for example Miami Beach): verify ICON-EU EPS and ICON global EPS selection respectively.
- [ ] Where direct `thunderstorm_probability` is populated, verify the provider percentage takes precedence for that exact hour.
- [ ] With all-zero member support, verify the summary describes zero support without implying a zero probability or silently treating missing members as zero.
- [ ] With nonzero member support, verify the strongest period and selected-hour member count/model; use fixture tests if current live conditions have no such period.
- [ ] Block the ensemble request: the deterministic outlook continues. Block the deterministic request: a usable ensemble outlook continues. Block both: an unavailable state appears.
- [ ] Switch a saved location and reload: each confirmed point receives its own fresh outlook; tapping hours or moving a candidate map marker causes no ensemble refetch.
- [ ] Check midnight, mobile Safari, Chrome mobile and desktop: selected-hour support remains readable without changing the timeline layout.
