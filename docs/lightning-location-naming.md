# Lightning incident location naming research

This research-only module turns one incident's representative coordinate into structured geographic components and a concise approximate label. It does not change the production app or incident coordinate calculation, and it does not claim that the coordinate is an exact address or administrative truth. The intended reading is “activity was detected around this place.”

## Provider review

| Provider | API and access | Terms / operational fit | Assessment |
|---|---|---|---|
| **OpenStreetMap Nominatim** (selected research adapter) | `GET https://nominatim.openstreetmap.org/reverse?lat=…&lon=…&format=jsonv2&addressdetails=1`; no key or cookies. A descriptive application `User-Agent` is sent; response language is requested as Turkish. | Public service policy sets an absolute maximum of 1 request/second, requires an identifying User-Agent or Referer and visible attribution, asks apps to cache and be switchable, and strongly discourages periodic/bulk geocoding. OSM data is ODbL; attribution/share-alike implications depend on use. Public-server availability and use are not guaranteed. | Good low-volume manual research source with useful structured address components. It is not an unrestricted, production bot endpoint. Automated public posting needs a deliberate policy/attribution review and a provider-switch option. |
| **Google Maps Geocoding API** | Documented reverse-geocoding API; requires an API key or OAuth and an enabled billing account. Returns typed address components. | Pay-as-you-go, quotas, and Google Maps Platform terms apply. Geocoding content caching/storage is generally restricted (place IDs are an exception); attribution/display rules apply and results shown on a map must be on Google Maps. | Technically capable alternative, but billing and content-use restrictions make it a less suitable first choice for reusable text labels that may be posted outside a Google map. Exact fit depends on the applicable agreement and use. |
| **Open-Meteo Geocoding API** (existing forecast place search) | `GET https://geocoding-api.open-meteo.com/v1/search?name=…`; no reverse-coordinate operation is documented. Returns named search results and administrative metadata. | The current documented endpoint is forward search. Review Open-Meteo’s current usage licence before expanding use; commercial-use terms differ from non-commercial use. | Useful for searching a place name, but not an incident-coordinate reverse-geocoding provider. |

Sources checked 5 October 2026: [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/), [Nominatim Reverse API](https://nominatim.org/release-docs/latest/api/Reverse/), [OpenStreetMap attribution](https://www.openstreetmap.org/copyright), [Google Geocoding usage and billing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing), [Google Geocoding policies](https://developers.google.com/maps/documentation/geocoding/policies), [Google reverse geocoding](https://developers.google.com/maps/documentation/geocoding/reverse-geocoding), and [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api). Provider terms can change; check them again before any automated/public use.

### Existing app naming path

The production place picker uses Open-Meteo **forward** search, including `admin1`–`admin4` search context. Separately, the existing location-selection flow already performs a Nominatim reverse lookup (`jsonv2`, address details, zoom 14) and keeps a compact preferred label, first-level admin value, and country. It is used to enrich a selected/geolocated app location and has optional-failure behavior. It does not expose a full independent neighborhood/locality/district/province result for incident naming, and the search metadata is not a reverse lookup. This module therefore defines a research contract without importing production UI logic. The existing Nominatim path demonstrates a technical capability that could be reviewed for reuse later; it is not coupled to this research code.

## Research adapter and normalized model

The research-only files live under `scripts/lightning-location-naming/`. The `ReverseGeocoder` interface accepts latitude/longitude and returns:

```ts
type ReverseGeocodeResult = {
  latitude: number;
  longitude: number;
  neighborhood?: string;
  locality?: string;
  localityKind?: "city" | "town" | "village" | "hamlet" | "municipality" | "other";
  district?: string;
  province?: string;
  country?: string;
  displayLabel: string | null;
  provider: "nominatim";
  rawType?: string;
  attribution: "© OpenStreetMap contributors";
};
```

Nominatim address components are mapped separately: `neighbourhood`/`neighborhood`, `quarter`, or `suburb` to neighborhood; `town`, `village`, `hamlet`, `city`, or `municipality` to locality; `county`, `district`, `state_district`, or `city_district` to district; `province`, `state`, or `region` to province. Field availability and meanings vary by place and OSM tagging. Provider `display_name`, road, house number, postcode, and country are not used to compose domestic labels.

The adapter validates coordinates, requests JSON with structured address details and Turkish language, identifies itself with a project User-Agent, applies an 8-second timeout, and distinguishes timeout/network/HTTP/malformed-response errors. An address with no usable place hierarchy returns `displayLabel: null`; no Ankara fallback is invented. Tests inject fetch responses and do not access the network. No raw response or event coordinate dataset is persisted.

## Label policy

Labels are Ankara-centered because the bot focuses on Ankara while its operational monitoring polygon also reaches nearby provinces. Ankara detection uses only the normalized provider province; neither coordinates nor polygon membership can make a place Ankara.

For Ankara, keep the smallest reliable human-meaningful local place and add a useful parent (prefer a distinct `town`, then a district-like field). Candidate small-place fields are checked in this order: `quarter`, `neighbourhood`/`neighborhood`, `suburb`, `village`, `hamlet`, and `city_district`. This preserves a specific quarter such as Aşağı Ayrancı over a broader suburb. If no small place is returned, use parent + province when available, otherwise the province.

Outside Ankara, omit neighborhood, village, quarter, and other small-place detail by default. Use a district-like parent + province, or province alone if no parent is available. This gives readers useful regional context for nearby provinces without presenting unfamiliar hyper-local names.

Only trailing administrative suffixes `Mahallesi`, `İlçesi`, and `İli` are removed from display components. Meaningful name parts such as `Aşağı`, `Yukarı`, `Eski`, and `Yeni` are preserved. Turkish locale-aware comparisons collapse duplicate hierarchy names. Country, streets, house numbers, postcodes, and provider `display_name` are not included in labels.

| Real hosted Nominatim observation | Normalized label |
|---|---|
| quarter Aşağı Ayrancı; suburb Ayrancı Mahallesi; town Çankaya; province Ankara | `Aşağı Ayrancı, Çankaya` |
| city_district Beynam Mahallesi; town Balâ; province Ankara | `Beynam, Balâ` |
| village Yenipeçenek Mahallesi; town Sincan; province Ankara | `Yenipeçenek, Sincan` |
| suburb Alacaatlı Mahallesi; town Çankaya; province Ankara | `Alacaatlı, Çankaya` |

The first and fourth labels were already good. The Beynam and Yenipeçenek observations exposed that useful local-place fields were being lost. Outside-Ankara regressions remain `Keskin, Kırıkkale` and `Kulu, Konya`, with small-place detail omitted.

The monitoring polygon only determines whether an incident is relevant. It never overrides provider-resolved geography: a point around Kırıkkale must not be labelled Ankara solely because it falls in the operational monitoring region.

## Manual samples and limitations

Hosted manual lookups have produced real Nominatim observations for Ayrancı, Beynam/Bala, Yenipeçenek/Sincan, and Alacaatlı (table above). These demonstrate both useful Ankara sub-area fields and provider variation: `quarter`, `suburb`, `city_district`, and `village` can each contain the meaningful smaller place. Live results are observations for those coordinates, not authoritative boundaries. Keep future samples small, serial, and below the public server's rate cap.

## Manual GitHub Actions live verification

Normalization is deterministic **after** a provider hierarchy is available:

```text
provider hierarchy → normalization → displayLabel
```

The adapter cannot determine which OSM object/address hierarchy Nominatim will associate with a coordinate, so real-provider samples remain necessary. The hosted observations above now confirm that Ankara coordinates can return useful quarter, suburb, village, and city_district detail.

The manual-only workflow is `.github/workflows/research-lightning-location-naming-live.yml` (`workflow_dispatch`; no push, pull-request, or scheduled runs). One dispatch performs one Nominatim reverse lookup. Workflow runs share a concurrency group so concurrent manual dispatches are serialized. Choose `preset` and one sample, or `custom` and enter one latitude/longitude pair. The default preset is Ayrancı. The result artifact and Actions Step Summary separate the whitelisted provider hierarchy from the normalized fields and final `displayLabel`; absent values appear as “not returned”. Success means only that a lookup returned a structured result—manual hierarchy review is still required. Provider, rate-limit, timeout, malformed-response, and unresolved outcomes are reported without substituting a place name.

Preset coordinates are representative points, not official centroids or administrative boundaries. They were checked against gazetteer/map entries; the rural Aşıkoğlu point is tested against the research Ankara operational polygon. Keskin is included as a real Kırıkkale naming case even though it lies outside that operational polygon; this naming workflow does not apply incident acceptance filtering.

| Preset | Latitude | Longitude | Coordinate reference |
|---|---:|---:|---|
| Ankara center | 39.919874 | 32.854271 | [GeoNames Ankara search](https://www.geonames.org/search.html?q=Ankara) |
| Ayrancı | 39.902861 | 32.849819 | [Wikidata Ayrancı](https://www.wikidata.org/wiki/Q20471152) |
| Bahçelievler (Çankaya) | 39.927810 | 32.826490 | [Mapcarta Bahçelievler](https://mapcarta.com/12990336) |
| Eryaman | 39.972300 | 32.621280 | [Mapcarta Eryaman](https://mapcarta.com/25719398) |
| Polatlı | 39.577155 | 32.141317 | [GeoNames Ankara search](https://www.geonames.org/search.html?q=Ankara) |
| Haymana | 39.434140 | 32.498790 | [Mapcarta Haymana](https://mapcarta.com/12970256) |
| Şereflikoçhisar | 38.939250 | 33.538599 | [GeoNames Ankara search](https://www.geonames.org/search.html?q=Ankara) |
| Kırıkkale center | 39.845278 | 33.506389 | [GeoNames Türkiye search](https://www.geonames.org/search.html?country=TR) |
| Keskin | 39.673056 | 33.613611 | [GeoNames Keskin](https://www.geonames.org/8631946/keskin-il-esi.html) |
| Aşıkoğlu, Bala (rural) | 39.583333 | 33.150000 | [GeoNames Ankara search](https://www.geonames.org/search.html?q=Ankara) |

Coordinates for Ayrancı, Bahçelievler, and Eryaman were also checked against the map records identifying those places and their administrative context. The listed references are coordinate aids only; they do not make points official centroids. Nominatim's public 1 request/second cap and fair-use restrictions still apply. The workflow has no secrets, loops over no sample list, and does not persist results beyond a seven-day Actions artifact.

The workflow is available on the default branch after PR #38 was merged. A manual dispatch can run one lookup against the selected branch; use it sparingly and review the real hierarchy alongside normalized output.

Additional limitations: reverse geocoding returns the nearest suitable indexed object/hierarchy for a coordinate, not an exact event address or definitive boundary membership. Neighborhood coverage varies within Turkey; a `suburb` or `city_district` may not correspond neatly to a Turkish mahalle. Human review is needed before deciding that a granular field is meaningful. Labels should be framed as approximate place references.

## CLI and operational guardrails

```sh
npm run research:reverse-geocode -- --lat=39.92 --lon=32.85
npm run research:reverse-geocode -- --lat=39.92 --lon=32.85 --provider=nominatim --format=json
```

The CLI makes one request, prints normalized components and the label (or `unresolved`), and exits distinctly for provider failure or unresolved address data. It is a manual research tool only. A future system should geocode only promoted/publish-candidate incidents, not raw detections; apply a shared rate limiter and appropriate cache; make provider replacement possible; and display OSM attribution when required. No persistent cache is implemented here.

## Research decision

**GO WITH CAVEATS for message-composer research.** The schema and deterministic Ankara-centered label policy are testable, and hosted samples show that Nominatim can return useful local detail for Ankara. Public Nominatim remains rate-limited and intended for limited use; external/public text reuse and attribution need review. Continue low-volume sampling and human review before any public use. No public production use is recommended by this research result.

The separate known startup burst remains a **low-frequency operational edge case to revisit before production deployment**; this work does not address it.
