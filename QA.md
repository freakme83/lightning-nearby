# Milestone 1 manual QA

- [ ] Fresh load: location is not requested until **Use my location** is tapped.
- [ ] Accept geolocation: rounded coordinates are saved on-device and a current forecast loads.
- [ ] Deny geolocation: a clear message appears; retry remains available.
- [ ] Retry location after changing browser/device permission.
- [ ] Update location: the newly chosen location replaces the single saved location.
- [ ] Forecast fetch failure: block `api.open-meteo.com`; verify an explicit unavailable state and no stale forecast.
- [ ] Mobile viewport: check 320 px and 390 px widths, touch targets, timeline scrolling, and details.
- [ ] Midnight/time zone: use coordinates in another time zone and verify local date changes.
- [ ] DST: test around spring-forward/fall-back; timeline order should remain chronological.
- [ ] PWA installability: serve over HTTPS, inspect manifest/service worker, and try installation on Android and iOS.
- [ ] Reload with saved location: forecast reloads without another permission prompt.
- [ ] No network: cached shell may reopen, but the forecast must report unavailable rather than show old values.
