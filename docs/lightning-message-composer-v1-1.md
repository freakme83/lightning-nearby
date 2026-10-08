# Lightning Message Composer v1.1

Public CG messages are URL-free. Only `cg_verified` adds a blank line and the selected Xweather CG latitude/longitude formatted to exactly three decimal places:

```text
#YILDIRIM
8 Ekim 2026, 16:31 TSİ
Salandra / Matera civarında yere ulaşan yıldırım kaydedildi.

40.512, 16.361
```

The composer uses the same selected `enrichment.match` CG event used for its internal Maps URL. It never substitutes the incident centroid, LightningMaps raw coordinate, Nominatim lookup coordinate, map center, or rounded location point. Both numbers use JavaScript `Number.toFixed(3)`, a deterministic numeric format independent of locale: `40.5118` becomes `40.512`, `39.9` becomes `39.900`, and `-73.98765` becomes `-73.988`. Trailing zeros remain. This display precision conveys an approximate observation location, not proof of an exact physical impact point.

The existing generic `ic_only`, `no_match`, and `provider_unavailable` format has neither coordinates nor a URL, even if a match object is present:

```text
#ŞİMŞEK
8 Ekim 2026, 16:31 TSİ
Salandra / Matera civarında şimşek kaydedildi.
```

Hashtags, FNV-1a verb selection, Turkish months, Europe/Istanbul time, first-comma slash formatting, and event wording are unchanged. Removing the public URL gives cleaner output and supports the project's goal of lower URL-related publishing costs. This milestone adds no social publishing or pricing logic.

## Internal metadata and persistence

The composer retains `mapUrl` for CG at the original selected numeric precision, e.g. `https://www.google.com/maps?q=40.5118,16.3612`; for non-CG it remains `null`. The additive `coordinateText` field describes only the public line and is `null` for non-CG. All other result fields remain. Paired artifacts still retain selected event coordinates and provider metadata.

The publication record now carries internal `mapUrl`, and the existing storage adapter writes it to the nullable `public.publication_records.map_url` column in the same insert as `message_text`. A read-only inspection of the prepared ledger project on 8 October 2026 confirmed that this column already exists, is nullable, has no default, and table RLS remains enabled. **No schema migration or live database write was needed.** A separately provisioned ledger must also include this nullable text column before using this adapter.

The stored map query preserves both full-precision selected CG coordinates for later operator review/manual reply. No redundant selected-coordinate columns are added; incident latitude/longitude retain their separate existing meaning. Duplicate-history reads continue to select only the existing fields needed by the matcher. Approval reads additionally retrieve `map_url`, and the Job Summary renders a canonical Google Maps reference under **Internal map**, outside the exact candidate message block. Historical `NULL` map metadata simply omits that section; it does not trigger message reconstruction or backfill.

## Immutable approval payload

`messageFingerprint` remains SHA-256 over the exact UTF-8 public `text`, including the blank line and coordinate line. New CG fingerprints therefore differ from the previous URL-bearing format. Internal `mapUrl` does not enter this hash, the public character count, or the publication identity independently of the existing text fingerprint.

The 280-character budget still counts Unicode code points in the public text only. Oversized messages fail without truncation. The ledger insert checks the exact text against its fingerprint and persists it unchanged as `message_text`; insert-if-absent never replaces an existing record. Approval displays and acts on that stored text, verifies its stored fingerprint, and changes approval fields only. It never invokes the composer. Historical messages/fingerprints are not rewritten, including historical URL-bearing messages.

Approval and duplicate semantics remain unchanged: pending-only approve/skip transitions, idempotent reruns, conflicting opposite actions, same-provider-event blocking, and the existing strict fingerprint/time/distance fallback. Historical selected event IDs still block repeats across format versions. Without a provider event ID, the existing exact-text fallback cannot match different format fingerprints; no cross-version normalization is added. Approved and skipped `WOULD_PUBLISH` rows still block duplicates. No nearby cooldown exists.

The end-to-end and fixture preview summaries now distinguish **Internal map URL available**, **Public message contains URL**, and **Public coordinate**. The end-to-end summary also shows the full internal map reference separately. No X API calls, credentials, `PUBLISHED` writes, scheduling, notifications, matching changes, location changes, lifecycle changes, production UI changes, or forecast changes are introduced.

## Validation and later acceptance

Focused regressions cover selected coordinate provenance, zeros/negative rounding, non-CG isolation, exact 280-character boundaries, public-only fingerprints, durable map serialization, unchanged approval text, historical payloads, and separate operator summaries. Existing composer, preview, ledger v1B.1/v1B.2, manual approval, publish-decision, dry-run, paired-validation, enrichment, naming, and lifecycle suites remain applicable.

After merge into `merge-ready`, run the manual live dry run and confirm a CG candidate has URL-free text, a selected three-decimal coordinate, pending approval, and full-precision `map_url`. Manual approval must show exactly the same persisted candidate plus the separate internal map. This PR does not run live acceptance or publish anything.
