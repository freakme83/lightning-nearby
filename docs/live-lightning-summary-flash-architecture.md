# Production live lightning: Summary-gated Flash

Architecture snapshot: 1 October 2026. This is the first production-integration pass for the token-efficient Xweather live-lightning flow. It changes the normal manual live check without changing forecast classification, forecast data, or debug/reference access to Raw lightning.

## Request flow

Every explicit **Check live activity** action starts with one request:

1. `GET /lightning/summary/closest`
   - 50 km radius
   - `from=-30minutes`
   - `to=now`
   - aggregate regional history only
2. When and only when Summary reports one or more detections, request `GET /lightning/flash/closest`
   - 40 km radius
   - documented recent five-minute window
   - up to 1,000 consolidated flashes

There is no polling, background refresh, cache, persistence, or automatic Raw fallback. Credentials remain server-side and provider payloads are normalized before reaching the browser.

## Why Summary is the gate

Summary cheaply answers whether lightning activity occurred anywhere in the broader 50 km area during the last 30 minutes. A healthy zero is sufficient to stop the request chain: the application can report a quiet recent-area window without buying a precise event-location request that has no useful work to do.

This gate relies on an expected coverage relationship, not a proven provider guarantee: a 30-minute / 50 km Summary zero is treated as sufficient reason not to ask for a 5-minute / 40 km Flash result. The live validation below confirms the positive direction (`Summary > 0` causes Flash to be requested), but neither the current tests nor documented provider semantics establish the inverse recall property (`Flash > 0` always implies `Summary > 0`) across regions and conditions. Summary and Flash use different aggregate/event representations, so a rare missed Flash-only result remains possible. Quiet UI wording is limited to “No recent lightning detections reported…” rather than claiming that no lightning activity occurred.

Summary is aggregate-only. It supplies a detection count and provider-reported oldest/newest activity timestamps when available. It does not supply event coordinates, nearest distance, or direction.

## Why Flash is the current precise layer

When the regional Summary is positive, Flash answers whether consolidated lightning flashes exist within 40 km during the current five-minute window. The application derives:

- nearest distance and compass direction;
- nearest-event age and latest event time;
- flash counts within 5, 10, 25, and 40 km;
- provider diagnostics and possible 1,000-result truncation.

Flash and Raw records are not equivalent event units. Raw represents individual pulses/strikes; Flash consolidates related activity. Validation in PR #15 found that Flash generally preserved presence, broad direction, and recency, while also finding one-sided detections and material nearest-distance differences in sparse or edge cases. This architecture does not claim that Flash is equivalent to Raw.

## Expected token use

Observed costs for the tested query shapes are planning inputs, not guaranteed future pricing:

| Live-check outcome | Requests | Expected observed cost |
| --- | ---: | ---: |
| Summary healthy zero | 1 Summary | 1 token |
| Summary positive; Flash requested | 1 Summary + 1 Flash | 2 tokens |
| Summary failure | 1 Summary | provider-dependent; no Flash or Raw fallback |

Both stage diagnostics are preserved separately when Flash is requested, so debug tooling can verify the actual cost headers without exposing them in the product card.

## User-visible states

- **Quiet recent area:** Summary is zero; Flash is not requested. The card reports no detected activity within 50 km during the last 30 minutes.
- **Recent but currently clear:** Summary is positive and Flash is zero. The card distinguishes recent regional activity from the absence of current flashes inside 40 km during the last five minutes.
- **Current activity:** Summary is positive and Flash is positive. The card leads with current nearby activity and nearest Flash context, then shows a lighter 30-minute regional count.
- **Partial unavailable:** Summary is positive but Flash fails. The recent-area result remains visible, while current precise activity is explicitly unavailable rather than being treated as zero.
- **Fully unavailable:** Summary fails. The live check is unavailable and neither Flash nor Raw is requested.

The five-minute client-side Flash filter uses the timestamp captured immediately before the Flash request. This keeps the local cutoff from moving forward while a slow provider response is in flight; provider-side Flash results are still checked for stale and future timestamps.

Only current Flash data affects live severity: up to 10 km is High, over 10 through 25 km is Elevated, and over 25 through 40 km is Nearby. Summary-only activity is historical regional context and does not raise current live severity.

## Raw and debug boundary

Normal `/api/lightning/live` no longer calls `/lightning/closest`. Raw remains available in debug/reference tooling, including the Raw-versus-Flash comparison. The history research modes and Summary/Flash research controls are also retained.

## Forty-kilometre limitation

Flash cannot provide precise current position information for the existing 40–50 km outer band. Summary still provides broad 30-minute awareness out to 50 km, but that aggregate context must not be presented as precise current activity. A future product decision may choose different wording or escalation behavior, but this pass does not invent precision that the provider response does not contain.

## Release gates

Successful technical integration does not resolve Xweather licensing, public redistribution rights, production suitability, abuse protection, access control, server-side rate limiting, long-term reliability, global detection completeness, latency distribution, or long-term quota/pricing behavior. Those remain release gates before public production use.

## Deploy Preview validation

Validated on PR #16 on 1 October 2026:

- **Quiet control — Ankara (`39.91, 32.84`):** Summary returned HTTP 200 with zero detections. Flash was `not-requested`. The Summary request reported `X-Cost-Tokens: 1` and `X-Cost-Multiplier(s): endpoint=1; spatial=1; temporal=1`. The normal product card independently displayed: “No recent lightning detections reported within 50 km in the last 30 minutes.”
- **Previously active candidate (`42.93, -2.01`):** Summary also returned HTTP 200 with zero detections at validation time. Flash was correctly not requested and the observed cost was one token. The candidate was no longer active, so this is another branching check rather than an active-system validation.
- **Natural active system (`35.35, 26.27`):** The normal product UI displayed “Lightning activity detected nearby,” with nearest detection about 5.3 km south and 4 flashes within 10 km in the last five minutes. It also showed 32 Summary detections within 50 km in the last 30 minutes and Current picture High. A subsequent normal debug **Load / refresh** returned Summary active with 35 detections and Flash active with 6 flashes, nearest about 5.0 km / 3.31 minutes, 3 within 10 km, and zero malformed Flash records skipped.

  Both requests returned HTTP 200 and each reported `X-Cost-Tokens: 1`, with multiplier `endpoint=1; spatial=1; temporal=1`. This directly validates the real active branch `Summary positive -> Flash requested` at an observed total of 2 tokens for that check. The UI and debug results were a few minutes apart, so their counts and nearest ages are not expected to match exactly.
- A natural recent-but-currently-clear case was not available during this small pass. No additional locations were searched to manufacture one.

This is a successful live integration sample, not proof of provider equivalence, universal Summary-gate recall, or long-term behavior. Flash consolidates activity while Summary reports aggregate detections; they remain different products and event representations.
