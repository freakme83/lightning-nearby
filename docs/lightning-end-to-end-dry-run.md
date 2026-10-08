# Lightning end-to-end research dry run

`Research Lightning End-to-End Dry Run` is a single manual GitHub Actions workflow for a live research observation. It calls the existing incident runner in paired-validation mode, then uses the incident's representative coordinate for one Nominatim reverse lookup. If that lookup produces a usable `displayLabel`, the existing paired-message-preview adapter supplies the exact composer output. Nothing is published.

## Manual use

1. Find an active real lightning region.
2. Open **Actions → Research Lightning End-to-End Dry Run → Run workflow**.
3. Select `custom` or `ankara`.
4. Enter the bounding box when using `custom`, then select a 5–20 minute duration and incident profile A, B, or C.
5. Wait for the run and open its Job Summary.
6. If the status is `message_preview_ready`, copy the exact dry-run message from the fenced block. Nothing was published.

The workflow file must be present on GitHub's default branch before the manual Run workflow entry point becomes available. The research branch and draft PR alone do not activate it.

## Stopping states

| Status | Meaning | Further provider calls |
|---|---|---|
| `message_preview_ready` | The paired artifact, place label, and composer all produced a preview. | None |
| `no_publish_candidate` | No live publish candidate occurred. | No Nominatim |
| `no_fresh_publish_candidate` | Candidates did not pass existing pairing freshness rules. | No Nominatim |
| `paired_validation_failed` | The runner failed or its paired artifact was missing or unusable. | No Nominatim |
| `location_lookup_failed` | The one lookup failed. | No composer |
| `no_usable_location_label` | The lookup completed but produced no usable label, including country-only or unstructured offshore results. | No composer |
| `message_composition_failed` | The existing adapter or composer rejected the input. | None |

The Job Summary separates incident, pairing, location, and message details. The artifact includes `lightning-end-to-end-dry-run-result.json`, the original paired result when available, and the live runner log, with three-day retention. The structured result records the stop reason and provider-call diagnostics.

The paired-validation runner retains its one-enrichment-call latch and existing Xweather request and cost behavior. Nominatim is called once only after a usable paired result; forecast providers and social publishing are never called. A paired result is observational evidence, not proof that two providers identified the same physical flash. The selected CG match supplies the Maps coordinate; the incident coordinate supplies location naming. The individual workflows remain available for separate debugging.

## Publish Decision Gate v1A

After the dry run, a separate research-only decision answers: **If publishing were enabled, would this completed observation be allowed to publish?** `WOULD_PUBLISH` means the current shadow policy allows it; `HOLD` lists the reasons it would be blocked. The pipeline status and exact composer message remain separate. Nothing is published.

The gate requires a ready final message, useful structured geography, a healthy (`live`) feed at the paired trigger, and `cg_verified`, `ic_only`, or `no_match` enrichment. CG verification is not mandatory: IC-only and no-match previews retain the composer's generic `#ŞİMŞEK` text without a Maps link. `provider_unavailable` is held even when the composer can produce generic text.

A small place with a useful parent or district/county plus province/state is sufficient. A province/state alone (such as Lazio or Ankara), a country alone, or a missing label is insufficient. The decision checks the normalized hierarchy and the resulting label; it does not alter location naming. Source health comes from the existing live runner's JSONL event at the paired trigger, before the intentional disconnect at the end of paired validation. If that event cannot be established, the gate holds with `source_unhealthy`.

The pure decision function accepts an optional run-scoped incident ID set for existing fixtures. [Publication Ledger v1B.1](lightning-publication-ledger-v1b1.md) adds a record matcher and an explicit `knownDuplicate` integration point for future cross-run history; raw incident IDs are not cross-run identities. The live workflow supplies no such history: **persistent duplicate history is not enabled**, and the summary says so. No publication state is stored, and no nearby geographic cooldown is applied. Reactivation alone does not imply a prior publication. This is a shadow decision only; there are no social credentials, webhooks, or publishing calls.
