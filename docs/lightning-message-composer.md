# Research lightning message composer

Turkish-only v1.1 composes a dry-run social post from a stable incident ID, current `lastActivityTimeMs`, a normalized `displayLabel`, incident/reference coordinates, and an already-resolved enrichment state. It does not call providers, Google Maps, or social APIs, and it is used by the research preview/dry-run pipeline.

Public message semantics:

- `#YILDIRIM ⚡` means Xweather positively verified a CG event. The wording says `yere ulaşan yıldırım`, and the selected Xweather CG coordinates appear in the labeled location block.
- No hashtag means generic lightning activity whose CG status was not positively confirmed. The wording is `şimşek/yıldırım aktivitesi`; it does not classify the event as IC. Coordinates come from the LightningMaps/incident reference.
- Both message kinds include a `Konum:` line followed by latitude and longitude. No public message emits `#ŞİMŞEK`.

Example verified-CG output:

```text
#YILDIRIM ⚡
Ankara’da, 6 Ekim 2026, 16:48 TSİ
Aşağı Ayrancı, Çankaya civarında yere ulaşan yıldırım kaydedildi.

Konum:
39.903, 32.851
```

Example generic/unverified output:

```text
Ankara’da, 6 Ekim 2026, 16:48 TSİ
Aşağı Ayrancı, Çankaya civarında şimşek/yıldırım aktivitesi kaydedildi.

Konum:
39.901, 32.842
```

The composer formats the incident's `lastActivityTimeMs` in `Europe/Istanbul` as `Ankara’da, D MMMM YYYY, HH:mm TSİ`, with Turkish month names and no seconds. The first comma in the normalized display label is rendered as `, `; structured location identity is unchanged. Public coordinates use the existing three-decimal numeric formatter. The CG map URL uses full-precision coordinates from the selected matched Xweather CG event; the public CG coordinate line uses that same event. Generic coordinates use the incident/reference point and do not use a rejected/evaluated provider event. The selected CG point is an approximate observation location, not proof of physical flash identity.

Public verbs are deterministic from the stable incident ID. Generic/unverified activity uses only `tespit edildi` or `kaydedildi`; verified CG may also use `teyit edildi`. `characterCount` counts Unicode code points in the complete raw text, including line breaks and the labeled coordinate block, excluding the internal URL. The default maximum is 280; oversized messages fail without truncation or splitting.

Manual preview from synthetic fixtures:

```sh
npm run research:lightning-message-compose -- --fixture=cg_verified_urban
npm run research:lightning-message-compose -- --input=path/to/normalized-composer-input.json
```

The CLI writes structured JSON to stdout and a readable preview to stderr. The `Research Lightning Message Composer Preview` workflow is `workflow_dispatch` only, needs no secrets, accepts the six fixture scenarios, and uploads a short-lived JSON artifact. Neither path makes a live data request or publishes a post.

Deferred idea, not part of v1.1: for central Ankara incidents, a small curated set of landmarks (TBMM, Anıtkabir, Kocatepe Camii, Esenboğa Havalimanı, Atakule) could supplement the normalized location label with distance and direction. This would require deterministic geodesic distance and bearing and a reasonable maximum distance.
