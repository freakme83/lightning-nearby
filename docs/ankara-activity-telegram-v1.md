# Ankara Activity Watch Telegram notifications v1

PR-4 adds two informational Telegram messages per Activity Watch period, a start and a completion with a Replay Studio JSON attachment. They go to the **existing** bot and group (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Activity notifications are off unless `ACTIVITY_TELEGRAM_ENABLED=true` (exact lowercase). They are independent of the Profile B publication workflow. The publication notifier (`scripts/lightning-telegram-notifier/pending.ts`), its messages, triggers, timing and error handling are unchanged. Activity notifications never invoke, wait for or suppress a publication.

## Architecture

`scripts/activity-telegram/` is a separate module with its own Telegram client and its own durable state. The worker creates it next to Activity Watch (`createActivityTelegram(process.env, emit)`) and stops it on shutdown; nothing else in the worker changes. It runs on its own unreferenced 15-second timer with at most one operation in flight. It never sees lightning frames: it only reads **committed** database rows. An in-memory Activity Watch transition is never treated as evidence. Its failures are caught and logged (`activity_telegram_error`) and cannot reach Activity Watch, Continuous Capture or publication.

The migration `scripts/activity-telegram/migrations/20261106120000_ankara_activity_notifications_v1.sql` is additive. It adds `ankara_activity_notifications`, a one-row `ankara_activity_notification_settings` and three service-role-only RPCs. It attaches no trigger and has no foreign key to Activity Watch tables, so it takes no lock on period rows and cannot slow or fail `sync_ankara_activity_watch`.

For each notification, keyed by `(period_id, kind)` with the deterministic idempotency key `ankara-activity:v1:<period_id>:<start|end>`, the steps are:

1. **Claim** (`claim_ankara_activity_notification`). This runs under one advisory lock, so concurrent workers are serialized. It plans rows from committed periods: `start` for an active period, `end` for a closed one. It recovers expired leases and leases one due row for 5 minutes.
2. **Prepare** in memory. For a start, this is the first membership row's time plus its Continuous Capture coordinates and district. For an end, it is PR-3's export (`exportPeriod`, the read-only export store, `serializeActivityExport`). No subprocess or file is used.
3. **Reserve** (`begin_ankara_activity_notification_send`). This durably marks "a Telegram request may now be issued". A start whose period has meanwhile closed is marked `superseded` and is not sent.
4. Exactly **one** Telegram request.
5. **Complete** (`complete_ankara_activity_notification`). This records the result. Only the lease owner can write it.

States: `pending` → `claimed` → `sending` → `sent` | `ambiguous` | `failed`, plus `superseded` and `expired`.

## Delivery, retries and ambiguity

Telegram's `sendMessage`/`sendDocument` have no application idempotency key, so **exactly-once delivery is not claimed**. The policy favours avoiding duplicate group messages and keeps unresolved cases visible:

| Telegram result | Recorded as | Retried? |
|---|---|---|
| `ok: true` | `sent` (message ID kept) | — |
| HTTP 429 with Bot API `error_code` 429 (a confirmed refusal) | `pending` after `retry_after`; all activity notifications pause until then | yes, bounded |
| Failure before any connection existed (DNS, refused, connect timeout) | `pending` with 30 s · 2ⁿ backoff | yes, at most 5 send attempts, then `failed` |
| Bot API 4xx other than 429; non-JSON 4xx | `failed` | no |
| **Any HTTP 5xx or Bot API `error_code` ≥ 500** (500, 502, 504, …, JSON or not); timeout; dropped connection; unreadable 2xx; inconsistent 429 | `ambiguous`: a server error can follow an accepted message | **never automatically** |
| Worker crash after claim, before reserving | the lease expires and the row returns to `pending` | yes (nothing was sent) |
| Worker crash after reserving | the lease expires and the row becomes `ambiguous` | **never automatically** |

A lease expiring never makes an uncertain send look safe to repeat. If a Telegram confirmation arrives but cannot be recorded, the worker keeps it in memory and retries the write before claiming anything new. A late confirmation from the same owner also resolves an expired `ambiguous` row to `sent`. The SQL enforces at least 3 seconds between activity sends across workers.

Operators can see unresolved deliveries:

```sql
select period_id, kind, state, attempts, last_outcome, updated_at
from public.ankara_activity_notifications where state in ('ambiguous', 'failed') order by updated_at desc;
```

Check the group first. Only if the message is really absent, an operator may set that row to `state = 'pending', lease_owner = null, next_attempt_at = now()`. Logs carry `activity_telegram_notification` (period, kind, outcome, attachment status) and never the token, URL or Telegram response body.

## Ordering and recovery

- **Normal period:** The start is due 10 seconds after the first detection so the asynchronous archive row can land. If the row is still missing, the dispatcher re-checks every 15 seconds for up to one minute after the first detection. After that the start is sent without a location. Later detections create nothing. The end is planned once Activity Watch has committed the closure.
- **Restarts and overlapping workers:** All state is in the database, so a new process continues where the old one stopped. Delivered notifications are never repeated, and two workers cannot hold the same lease.
- **Missed start:** If a period closed before its start was handed to Telegram, the start is `superseded` and only the completion is sent. No stale start is sent after the period ended.
- **Source interruptions:** These change only Activity Watch's own coverage fields. The dispatcher never reacts to socket state.
- **Database outage:** The dispatcher backs off up to 5 minutes. Activity Watch, Continuous Capture and publication have no dependency on it.
- **No history flood:** The first claim after enablement records `enabled_at`. Periods that started earlier are never announced. A completion whose closure is more than 12 hours old is `expired`, not sent. Planning scans only periods that started within the last 7 days.

## Messages

**Start:**
- `⚡ Ankara'da yıldırım hareketliliği tespit edildi.`
- The first recorded detection time in TSİ, with the date added if it is reported on another day.
- The district from PR-3 attribution of the first archived detection, or `Ankara izleme alanı`.
- An OpenStreetMap link to those coordinates (link previews disabled). The link is left out if no coordinates are available. No geocoding request is made.
- A note that these are Blitzortung detection records, not independently verified lightning.

**Completion** (one `sendDocument`, caption ≤ 1,024 characters):
- Date, first detection, last detection, and the administrative closure, labelled as not part of playback.
- The total number of Blitzortung detection records.
- Up to five districts, then "ve N ilçe daha".
- The unattributed count.
- `⚠️ Arşivde eksik kayıt: N` when archive rows are missing.
- `⚠️ Kapsama belirsiz (kaynak kesintisi: N)` when coverage is uncertain.
- The note that counts are detection records.

The attachment is PR-3's unchanged Replay JSON, so same-millisecond records stay separate and playback ends 10 seconds after the last detection. Its filename is `ankara-activity-YYYYMMDD-HHMM-tsi-<period_id>.json`, from the first detection in TSİ.

If no trustworthy attachment can be produced, a **text-only** completion explains why. No empty or seemingly complete JSON is sent. The cases are:
- **More than 50,000 records:** PR-3's ceiling, checked before any archive read.
- **More than 5,000 records:** the in-worker limit (see below). The Replay can still be produced with PR-3's operator CLI.
- **No archived rows, or inconsistent archive data.**
- **JSON larger than 45 MB.**
- **Archive reads failed three times.** Transient read failures are retried with backoff first.

**Why 5,000:** The worker shares one 256 MB VM with publication, Continuous Capture and Activity Watch, and part of that memory belongs to the VM's own processes. `scripts/research/activity-telegram-memory/preload.ts` runs the unmodified worker locally with every network call intercepted in-process. It feeds 60 synthetic frames per second (5 % inside Ankara) with Continuous Capture, Activity Watch and Activity Telegram enabled, then serves one completed period of N records. Measured whole-process peak RSS (kernel `maxRSS`):

| Attachment | Peak RSS | File |
|---|---|---|
| none (storm baseline) | 100–112 MB | — |
| 100 records | 125 MB | 0.1 MB |
| 2,500 | 145 MB | 1.4 MB |
| 5,000 | 152–163 MB | 2.7 MB |
| 10,000 | 178–186 MB | 5.4 MB |

A 50,000-record build alone exceeded +300 MB. At 5,000 records the export adds about 27–38 MB over the fixed cost of preparing a notification, leaving roughly 90–100 MB below the VM limit. At 10,000 the margin would be too thin, given the VM's own usage and possible spikes. These figures come from a 16 GB development host. V8's heap limit is not derived from the 256 MB VM size, so garbage collection should behave similarly, but production RSS should still be confirmed from Fly metrics after enablement. The district dataset is loaded only when a notification is prepared, never per detection.

## Rollout (operators, after approval; not done in this PR)

1. Check the Supabase migration history. Then apply `20261106120000_ankara_activity_notifications_v1.sql` once. It requires the Continuous Capture and Activity Watch migrations.
2. Deploy the worker image with `ACTIVITY_TELEGRAM_ENABLED` unset or `false`. The Dockerfile now also copies `scripts/activity-export/` (with its district data) and `scripts/activity-telegram/`.
3. Verify worker startup, Activity Watch, Continuous Capture and the existing publication notifications.
4. After approval, set `ACTIVITY_TELEGRAM_ENABLED=true`. The first claim records the enablement time, so only periods that start afterwards are announced. Setting the flag back to `false` stops new activity messages and leaves stored state intact.

## Tests

`npm run test:activity-telegram` runs the unit tests:
- Telegram outcome classification and request shape.
- Message text, the caption limit and the filename.
- Dispatcher behaviour: the 5,000 and 50,000 ceilings, export failures, ambiguity, retries, a lost confirmation, database outages, the flag and credentials.
- Isolation checks: publication notifications stay byte-identical, the import closure has no path to publication code, the Docker image covers every module the worker imports, and the worker wiring is as described.

With `ACTIVITY_WATCH_POSTGRES_TEST_MODULE` (PGlite) set, the tests also run against the real migrations and Activity Watch RPC:
- A normal lifecycle with restarts.
- The no-flood baseline and a missed start.
- Concurrent dispatchers.
- Ambiguous outcomes and crashes before and after reserving.
- 429 and 5xx retry limits, and permanent rejection.
- Missing or absent archive rows.
- A database outage.
- A 6-hour intermittent period with routine reconnects and a worker restart.
- Migration isolation and grants.
