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

The policy aims for the smallest **reliable, human-meaningful** area, not the smallest field returned:

- Urban neighborhood + district: `Ayrancı, Çankaya`, `Bahçelievler, Çankaya`, `Eryaman, Etimesgut`.
- Meaningful town + province: `Polatlı, Ankara`, `Keskin, Kırıkkale`; identical locality/province collapses to `Kırıkkale`.
- Village/hamlet: preserve its human-readable name (including `Köyü` when supplied), followed by a distinct district when available, otherwise province.
- Without a neighborhood/locality, use district + province, or province alone. Missing hierarchy produces no label.
- Duplicate adjacent hierarchy names are collapsed; country is kept in structured data but omitted from domestic display labels.
- `Mahallesi` is stripped only from a neighborhood field; `İlçesi` and `İli` are stripped only from their respective admin fields. Other suffixes are preserved. This is intentionally conservative and Turkish-specific.

Illustrative fixture mappings (not provider observations):

| Structured components | Label |
|---|---|
| neighborhood Ayrancı; district Çankaya; province Ankara | `Ayrancı, Çankaya` |
| neighborhood Batıkent; district Yenimahalle; province Ankara | `Batıkent, Yenimahalle` |
| town Polatlı; district Polatlı; province Ankara | `Polatlı, Ankara` |
| village Aşağıörükbağ Köyü; district Bala; province Ankara | `Aşağıörükbağ Köyü, Bala` |
| locality Ankara; province Ankara | `Ankara` |

The monitoring polygon only determines whether an incident is relevant. It never overrides the reverse-geocoded name: a point around Kırıkkale must not be labelled Ankara solely because it falls in the operational monitoring region.

## Manual samples and limitations

The intended small sample set covers Ankara center, Ayrancı, another central neighborhood, Eryaman/Batıkent, Polatlı, Haymana/Bala, Şereflikoçhisar-side, Kırıkkale, Keskin, and one rural point within the operational area. On 5 October 2026 the research environment could not reach Nominatim: the direct provider URL was inaccessible through the available research fetch path, and the workspace has no outbound GitHub/provider network route. No live place result is reported or inferred from that failure. The fixture mappings above are synthetic contract tests, not real lookup evidence. Run individual CLI lookups manually from an allowed network before comparing actual Turkish hierarchy quality; keep calls serial and below the public server's rate cap.

Additional limitations: reverse geocoding returns the nearest suitable indexed object/hierarchy for a coordinate, not an exact event address or definitive boundary membership. Neighborhood coverage varies within Turkey; a `suburb` or `city_district` may not correspond neatly to a Turkish mahalle. Human review is needed before deciding that a granular field is meaningful. Labels should be framed as approximate place references.

## CLI and operational guardrails

```sh
npm run research:reverse-geocode -- --lat=39.92 --lon=32.85
npm run research:reverse-geocode -- --lat=39.92 --lon=32.85 --provider=nominatim --format=json
```

The CLI makes one request, prints normalized components and the label (or `unresolved`), and exits distinctly for provider failure or unresolved address data. It is a manual research tool only. A future system should geocode only promoted/publish-candidate incidents, not raw detections; apply a shared rate limiter and appropriate cache; make provider replacement possible; and display OSM attribution when required. No persistent cache is implemented here.

## Research decision

**GO WITH CAVEATS for message-composer research.** The schema and deterministic Turkish label policy are testable, and Nominatim exposes the component-oriented reverse API needed by the adapter. But actual Ankara neighborhood quality was not live-verified in this environment; public Nominatim is rate-limited and intended for limited use; and external/public text reuse and attribution need review. The next step is a manually run, low-volume sample on an allowed network followed by human review of urban and rural labels. No public production use is recommended by this research result.

The separate known startup burst remains a **low-frequency operational edge case to revisit before production deployment**; this work does not address it.
