# X Publisher v1B — Manual Approved Publication

Research Lightning X Publisher is a manual GitHub Actions workflow with one required publicationId input. It has no schedule, push trigger, or dependency on the end-to-end or approval workflows. Nothing publishes automatically. Its draft PR targets merge-ready; no live X request is part of validation.

## Source and eligibility

The publisher reads one persistent publication_records row from Supabase. The public payload is exactly the stored message_text, byte for byte at the JavaScript string level. It verifies the stored SHA-256 message_fingerprint against that text. It does not call the composer, Xweather, reverse geocoding, or add map_url, a link, or whitespace. A CG message keeps the Composer v1.1 three-decimal selected Xweather coordinate line; a non-CG message remains free of URLs and coordinates because the stored composer text is used unchanged. The internal map_url remains separate.

The row must have decision WOULD_PUBLISH, approval_status approved, null platform_post_id and published_at, a nonempty message_text with matching fingerprint, and no previous publish_attempt_id. A guard rejects URL-bearing legacy public messages and rejects non-CG coordinate lines even if their fingerprints match; CG requires its three-decimal final coordinate line. Pending, skipped, HOLD, legacy null approval, changed text, missing text, and reserved attempts cannot send. A PUBLISHED row with a post ID returns already_published without contacting X.

## Manual gate and request

The repository variable X_PUBLISHING_ENABLED must equal the exact string true. Missing or any other value stops before the attempt claim and X call. The four existing GitHub secrets X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET must all exist. They are scoped only to the publishing execution step; the summary and artifact steps receive none. The separate X adapter signs a POST to https://api.x.com/2/tweets with OAuth 1.0a User Context (HMAC-SHA1). The JSON body contains only text with the exact persisted message_text. There is no media, reply, thread, or OAuth2 flow. No dependency was added.

Before contacting X, the publisher atomically claims the row by setting a new publish_attempt_id. The conditional update requires matching publication_id, WOULD_PUBLISH, approved, null platform_post_id, null publish_attempt_id, and the observed fingerprint. A concurrent run cannot claim it. A returned row must still match the observed text and fingerprint. The workflow also serializes runs for the same publication ID. Each execution invokes the X adapter at most once. Fetch has no retry, and redirects are disabled.

## Outcomes and reconciliation

- Confirmed success means X returned HTTP 201 with a valid post ID. The publisher conditionally updates the same approved WOULD_PUBLISH row to PUBLISHED, storing platform_post_id and published_at. The final update also requires the reserved publish_attempt_id and null platform_post_id. A successful rerun reports already_published and makes zero X requests.
- A definite 4xx rejection (other than 408) reports definite_failure. The attempt remains reserved, so any further attempt requires an operator to inspect and explicitly reconcile it.
- A timeout, transport error, HTTP 408 or 5xx, unexpected success status, or malformed/unreadable HTTP 201 response reports publication_uncertain. It does not retry or mark PUBLISHED. The attempt remains reserved and blocks a blind later run. Manual reconciliation must determine whether X created the post.
- If X returned a confirmed post ID but the conditional ledger final update fails, the result says “X post created, ledger update failed — manual reconciliation required”. The X post ID and reserved attempt ID are preserved in the workflow JSON artifact and Job Summary. The claim blocks a later blind retry. An operator should check the account and row before repairing the ledger; no automatic reset or resend is provided.

A process interruption after the claim also leaves the attempt reserved. If the result artifact is absent, inspect the ledger and X manually before considering any new attempt. Never clear publish_attempt_id merely because a workflow failed. The migration file at scripts/lightning-publication-ledger/migrations/20261008_x_publisher_v1b.sql records the two nullable columns. The previous implementation session had already applied this migration to the configured Supabase project as 20261008161633_x_publisher_v1b; recovery did not apply it a second time. RLS remains enabled and no public policy was added.

GitHub Actions requires a workflow_dispatch file to be on the repository default branch before its Run workflow control reliably appears in the UI. The draft PR on merge-ready can be reviewed and tested without triggering a live request; later promotion to the default branch is a separate decision. This change does not enable X_PUBLISHING_ENABLED.
