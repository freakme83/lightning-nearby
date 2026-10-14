# Lightning Message Composer v1.1

The current public message format distinguishes positively verified CG from generic lightning activity whose CG status is not positively confirmed.

Verified CG:

```text
#YILDIRIM ⚡
Ankara’da, 8 Ekim 2026, 16:31 TSİ
Salandra, Matera civarında yere ulaşan yıldırım kaydedildi.

Konum:
40.512, 16.361
```

Only `cg_verified` uses the public hashtag `#YILDIRIM ⚡` and the wording `yere ulaşan yıldırım`. The labeled coordinate block and internal Maps URL use the selected Xweather CG event: the public values are rounded to three decimals, while the internal URL retains the original precision.

Generic/unverified lightning activity:

```text
Ankara’da, 8 Ekim 2026, 16:31 TSİ
Salandra, Matera civarında şimşek/yıldırım aktivitesi kaydedildi.

Konum:
39.900, 32.800
```

`ic_only`, `no_match`, and `provider_unavailable` have no public hashtag. Lack of a verified CG match does not classify the activity as IC. Generic coordinates use the LightningMaps/incident reference point, never a rejected or evaluated Xweather event. Every current message includes `Konum:` on its own line before the coordinates. Location labels render the first separator as a comma, without changing structured location identity.

Both formats use the incident's `lastActivityTimeMs` in `Europe/Istanbul` as `Ankara’da, D MMMM YYYY, HH:mm TSİ`, Turkish month names, and no seconds. Verbs are deterministic from the stable incident ID: generic/unverified activity uses only `tespit edildi` or `kaydedildi`, while verified CG may also use `teyit edildi`. The internal event marker may retain `#ŞİMŞEK` for runtime policy compatibility, but it is never rendered in public text. Public text remains subject to the 280 Unicode-code-point limit and is never truncated.

## Internal metadata and persistence

The composer retains `mapUrl` for CG at the original selected numeric precision, e.g. `https://www.google.com/maps?q=40.5118,16.3612`; for generic activity it remains `null`. `coordinateText` describes the labeled public coordinate line for both formats, sourced from the selected CG event or the incident reference as applicable. Paired artifacts still retain selected event coordinates and provider metadata.

The publication record now carries internal `mapUrl`, and the existing storage adapter writes it to the nullable `public.publication_records.map_url` column in the same insert as `message_text`. A read-only inspection of the prepared ledger project on 8 October 2026 confirmed that this column already exists, is nullable, has no default, and table RLS remains enabled. **No schema migration or live database write was needed.** A separately provisioned ledger must also include this nullable text column before using this adapter.

The stored map query preserves both full-precision selected CG coordinates for later operator review/manual reply. No redundant selected-coordinate columns are added; incident latitude/longitude retain their separate existing meaning. Duplicate-history reads continue to select only the existing fields needed by the matcher. Approval reads additionally retrieve `map_url`, and the Job Summary renders a canonical Google Maps reference under **Internal map**, outside the exact candidate message block. Historical `NULL` map metadata simply omits that section; it does not trigger message reconstruction or backfill.

## Immutable approval payload

`messageFingerprint` remains SHA-256 over the exact UTF-8 public `text`, including the blank line and coordinate line. New fingerprints therefore differ from older formats. Internal `mapUrl` does not enter this hash, the public character count, or the publication identity independently of the existing text fingerprint.

The 280-character budget still counts Unicode code points in the public text only. Oversized messages fail without truncation. The ledger insert checks the exact text against its fingerprint and persists it unchanged as `message_text`; insert-if-absent never replaces an existing record. Approval displays and acts on that stored text, verifies its stored fingerprint, and changes approval fields only. It never invokes the composer. Historical messages/fingerprints are not rewritten, including historical URL-bearing or pre-`Ankara’da` messages.

Approval and duplicate semantics remain unchanged: pending-only approve/skip transitions, idempotent reruns, conflicting opposite actions, same-provider-event blocking, and the existing strict fingerprint/time/distance fallback. Historical selected event IDs still block repeats across format versions. Without a provider event ID, the existing exact-text fallback cannot match different format fingerprints; no cross-version normalization is added. Approved and skipped `WOULD_PUBLISH` rows still block duplicates. No nearby cooldown exists.

The end-to-end and fixture preview summaries distinguish **Internal map URL available**, **Public message contains URL**, and **Public coordinate**. The end-to-end summary also shows the full internal map reference separately. No X API calls, credentials, `PUBLISHED` writes, scheduling, notifications, matching changes, location changes, lifecycle changes, production UI changes, or forecast changes are introduced.

## Validation and later acceptance

Focused regressions cover the explicit `Ankara’da` date/time line, status-dependent deterministic verb wording, selected coordinate provenance, zeros/negative rounding, non-CG isolation, exact 280-character boundaries, public-only fingerprints, durable map serialization, unchanged approval text, historical payloads, and separate operator summaries. Existing composer, preview, ledger v1B.1/v1B.2, manual approval, publish-decision, dry-run, paired-validation, enrichment, naming, and lifecycle suites remain applicable.

After merge into `merge-ready`, run the manual live dry run and confirm a CG candidate has the current Ankara-scoped text, a selected three-decimal coordinate under `Konum:`, pending approval, and full-precision `map_url`. Manual approval must show exactly the same persisted candidate plus the separate internal map. This PR does not run live acceptance or publish anything.
