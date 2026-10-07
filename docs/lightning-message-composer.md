# Research lightning message composer

Turkish-only v1 composes a dry-run social post from a stable incident ID, current `lastActivityTimeMs`, a normalized `displayLabel`, and an already-resolved enrichment state. It does not call providers, Google Maps, or social APIs, and it is not wired into lifecycle or publishing.

The exact output has three lines, plus a fourth map URL only for `cg_verified`:

```text
#YILDIRIM
6 Ekim 2026, 16:48 TSİ
Aşağı Ayrancı / Çankaya civarında yere ulaşan yıldırım kaydedildi.
https://www.google.com/maps?q=39.902742,32.851494
```

Generic states (`ic_only`, `no_match`, and `provider_unavailable`) use `#ŞİMŞEK`, `[location] civarında şimşek [verb].`, and no link. No provider diagnostics appear in the public post. `cg_verified` uses `#YILDIRIM` and `[location] civarında yere ulaşan yıldırım [verb].`; it requires a selected CG match with valid coordinates. Both kinds use only `tespit edildi` or `kaydedildi`. FNV-1a parity of the stable incident ID chooses the verb, so rerenders are identical.

The composer formats the incident's `lastActivityTimeMs` in `Europe/Istanbul` as `D MMMM YYYY, HH:mm TSİ`, with Turkish month names, no seconds, and no local incident timezone. It changes the first comma in the normalized display label to ` / `; names and qualifiers such as `Aşağı`, `Yukarı`, `Eski`, and `Yeni` are preserved. A missing label produces a structured error, with no invented place. The CG map URL is constructed locally from the **selected matched CG event coordinates**, not the incident representative coordinates; it describes an approximate observation location, not a meter-accurate impact point or proof of physical flash identity.

`characterCount` counts Unicode code points in the complete raw text (including line breaks and the full URL). The default maximum is 280 and can be configured. An oversized message returns `message_too_long` with its count; it is never truncated or split. This raw count is conservative for standard X URL shortening and is not a full implementation of X's weighted text parser.

Manual preview from synthetic fixtures:

```sh
npm run research:lightning-message-compose -- --fixture=cg_verified_urban
npm run research:lightning-message-compose -- --input=path/to/normalized-composer-input.json
```

The CLI writes structured JSON to stdout and a readable preview to stderr. The `Research Lightning Message Composer Preview` workflow is `workflow_dispatch` only, needs no secrets, accepts the six fixture scenarios, and uploads a short-lived JSON artifact. Neither path makes a live data request or publishes a post.

Deferred idea, not part of v1: for central Ankara incidents, a small curated set of landmarks (TBMM, Anıtkabir, Kocatepe Camii, Esenboğa Havalimanı, Atakule) could supplement the normalized location label with distance and direction, such as `Anıtkabir'in yaklaşık 2 km doğusu`. This would require deterministic geodesic distance and bearing and a reasonable maximum distance. The CG Google Maps link would still use the selected CG coordinate.
