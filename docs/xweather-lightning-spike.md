# Xweather live lightning spike

Research and live-validation snapshot: 30 September 2026. This spike adds a manually invoked server route and a private debug page; it does not add a live layer to the normal app. Live requests have now succeeded through a Netlify Deploy Preview using real Xweather credentials. The examples below are small validation observations, not scientific benchmark results. Credential values are not recorded here.

## Decision and release boundary

**Prototype only; no public release with real credentials until Xweather confirms the applicable licence in writing.** The General Conditions document currently linked from Xweather (dated 1 January 2023) describes a freemium license for internal business use and generally restricts publishing, distributing, or making service information available to third parties unless the service description grants broader rights. It also requires attribution when third-party availability is permitted. Xweather’s product page advertises a free tier with access to all endpoints, but endpoint availability does not itself grant public redistribution rights. A public hobby website is not clearly covered by “internal business” use. [X1] [X3] [X7]

The route has no account or request authentication or server-side rate limit. Real credentials were configured in the Netlify Deploy Preview for validation. Anyone who can reach that preview route could potentially spend the configured account’s quota; verify preview access restrictions or remove its credentials after testing. Before any publicly reachable credentialed deploy, obtain the appropriate rights and add access control and quota protection. This is a technical prototype, not approval to use or republish Xweather data.

## What Xweather documents

| Item | Documented behavior | Spike behavior |
| --- | --- | --- |
| Endpoint | `GET https://data.api.xweather.com/lightning/closest` is the documented closest-lightning query. Standard access is global and real time, covering the past five minutes. | One request is issued only after the user presses **Refresh** on `/debug/lightning`. |
| Spatial limits | Standard `/lightning` access supports up to a 100 km radius and up to 1,000 events per request. A `skip` parameter can request the next batch, but each batch is another API request. The route asks for 50 km to support the app’s nested 5 / 10 / 25 / 50 km bands. | Uses `p=latitude,longitude`, `radius=50km`, `limit=1000`, and `filter=all`. If all 1,000 slots are filled, the page flags counts as potentially incomplete; it does not silently make another billable request. |
| Event fields | Lightning records include `loc.lat`, `loc.long`, and `ob.timestamp` (Unix seconds). `ob.pulse.type` distinguishes IC (intracloud) and CG (cloud-to-ground); the response example uses lower-case `cg`. The API also uses “strike” terminology. | Converts supported records into coordinates, millisecond timestamps, and case-insensitive IC / CG / unknown type. It does not return upstream event IDs. |
| Credentials | API requests use an application client ID and secret as query parameters. Web app credentials are restricted to the registered namespace, normally the top-level domain. | Credentials are read only in the server route from `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`. They are not sent by the browser, included in the JSON response, or committed. Confirm that the namespace restriction works for the chosen serverless runtime. Do not enable URL logging that records upstream query strings. |
| Response health | The JSON envelope reports `success`, `error`, and `response`. Authentication, rate, server, malformed, and network failures are not equivalent to an empty event list. | Only a successful no-data response produces a healthy zero. Failures stay explicitly unavailable and do not become zero counts. |
| Attribution | Xweather requires attribution for products using its data; the guidance specifies “Powered by Vaisala Xweather” with a link, or a logo, and prohibits implying endorsement. | The debug page includes linked “Powered by Vaisala Xweather” attribution. Confirm whether this is sufficient for the chosen agreement. |

Standard access documentation says the `/lightning` endpoint has a 10× endpoint multiplier. In the live Deploy Preview test, the existing 50 km / five-minute query consistently returned `X-Cost-Tokens: 10` and `X-Cost-Multipliers: endpoint=10; spatial=1; temporal=1`. Treat **10 tokens as the verified observation for this tested query shape only**; this does not guarantee future pricing. The route copies cost and rate-limit headers into safe diagnostic metadata when present. [X1] [X4] [X5]

## Cost and request cadence

Xweather currently advertises 15,000 monthly accesses on its free tier. The account plan and the exact long-term quota behavior have not been established. The request cost observed in this live test was 10 tokens for the query described above. The calculations below use that observed cost and the advertised allowance for rough planning only; they are not a guarantee of future pricing or an interpretation of the `Remaining this period` header. [X4] [X5] [X6]

| Manual or hypothetical polling rate | Requests in 30 days | Arithmetic at observed 10 tokens/query | Approximate time to use 15,000 advertised accesses at this rate |
| --- | ---: | ---: | ---: |
| 1 manual refresh/day | 30 | 300 | 50 months |
| 5 manual refreshes/day | 150 | 1,500 | 10 months |
| 10 manual refreshes/day | 300 | 3,000 | 5 months |
| Poll every minute | 43,200 | 432,000 | 25 hours |
| Poll every 2 minutes | 21,600 | 216,000 | 50 hours |

At the observed 10 tokens per query, 15,000 advertised monthly accesses would arithmetically correspond to 1,500 such requests if the account applies those units as assumed. The spike deliberately has no polling, background refresh, or cache; the polling rows are hypothetical cost comparisons only. Actual future cost and quota accounting remain unverified. Rate-limit headers are useful diagnostics, not a substitute for an application-side cap.

## Live validation in Netlify Deploy Preview

The verified request path was:

`Browser → Netlify Deploy Preview → POST /api/lightning/live → Xweather → normalized summary`

Authentication succeeded and the server route returned HTTP 200. The existing query used a 50 km radius and the provider’s five-minute observation window. Real upstream payloads were parsed into the normalized summary.

Observed diagnostics across the test requests:

| Diagnostic | Observed value |
| --- | --- |
| Upstream HTTP status | `200` |
| `X-Cost-Tokens` | `10` |
| `X-Cost-Multipliers` | `endpoint=10; spatial=1; temporal=1` |
| Remaining this minute | `99` |
| Remaining this period | `15000` on the first request; `14990` on subsequent requests |

Do not infer exact real-time monthly balance semantics from `Remaining this period`; its observed values are recorded only as diagnostics. The verified cost observation is 10 tokens for this tested request shape, not a future price guarantee.

The following cases are validation examples, not a scientific benchmark:

| Case and approximate queried point | Xweather result | Interpretation |
| --- | --- | --- |
| Positive — Ireland sparse activity, `52.89, -6.98` | Nearest event about `0.7 km` away and `2.13 min` old; counts: 5 km `2`, 10 km `3`, 25 km `3`, 50 km `3`; latest event roughly 2 minutes before fetch. Blitzortung showed recent sparse activity nearby. | Strong spatial/time agreement with an independently observed active area. This does not establish that any particular Xweather and Blitzortung records were the same physical discharge. |
| Positive — southern France / Monaco-region active system, `43.58, 3.88` | Nearest event about `12.3 km`; 17 events within 25 km and 26 within 50 km; latest event roughly 1 minute before fetch. | Higher counts were returned in a visibly active lightning system. |
| Positive — Ireland active area, `52.72, -7.29` | Nearest event about `18.6 km`; 4 events within 50 km, all 4 within 25 km; latest event about 1 minute before fetch. | Another positive regional match. |
| Negative control — Ankara, `39.91, 32.84` | Healthy HTTP 200 response; zero events within 5 / 10 / 25 / 50 km; no latest or nearest event. No recent activity was visible in the independent external live view used to select the point. | A healthy zero-activity result was returned as a successful observation, separate from provider failure. |

### Proven by this validation

- Xweather credentials authenticate successfully when held in the Netlify server environment.
- The Netlify server-side route works in a real Deploy Preview, and `/lightning/closest` returns live event data for the tested point and time window.
- The tested 50 km / five-minute query cost 10 tokens, with the multipliers listed above.
- Parsing and normalized summaries work with real upstream payloads in both active-area and healthy-zero examples.
- The implementation keeps provider failures distinct from healthy zero activity. Live provider failure was not forced during this validation; fixture tests cover failure handling.

### Still unproven and release gates

- Current licensing and public redistribution rights, and suitability for public production deployment.
- Long-term reliability, global detection completeness, and provider-versus-Blitzortung detection sensitivity.
- Exact latency distribution and long-term quota behavior.
- Whether `Remaining this period` represents an instantaneous monthly balance; no such inference is made from the two observed values.
- Public endpoint abuse protection. The prototype route has no access control or server-side request rate limit.

## Implementation and privacy

- `POST /api/lightning/live` accepts latitude and longitude in a JSON body. The location is not placed in our route URL or a link. The browser sends a request only after a manual click.
- The server makes one request to Xweather and returns a normalized summary plus safe cost / rate-limit diagnostics. It does not persist locations or raw provider payloads. The normal app UI and forecast classification are untouched.
- The summary window is the provider’s recent five-minute observation window. Events are counted in inclusive, nested 5 / 10 / 25 / 50 km bands using Haversine distance. “Events” are detected pulses/strikes, not storms.
- The app’s own request body avoids URL-based location exposure, but the hosting provider receives the body and Xweather receives the requested coordinates. Hosting and upstream operational logs may retain request metadata under their own policies; verify these settings before deployment. Do not log request bodies or credential-bearing Xweather URLs.
- The route uses `Cache-Control: no-store`. Provider failure, quota exhaustion, invalid data, and absent credentials are shown as unavailable states, never as evidence that lightning is absent.
- No database, collector, scheduled task, map, normal-page UI, forecast change, or notification is included.

Next.js Route Handlers are supported by Netlify’s Next.js adapter and run as serverless functions. That fits this bounded request / response proxy; it does not provide persistent collection or shared process memory, neither of which this spike needs. Confirm that deployment uses the current Next.js adapter and set secrets only in a protected environment after the release gates above are resolved. [N1]

## Validation and remaining questions

The parser and route are tested with fixtures for valid IC/CG records, malformed rows, healthy empty responses, absent credentials, authentication and quota failures, malformed payloads, network failure, credential secrecy, coordinate bounds, radius boundaries, the provider event cap, and the five-minute cutoff. `npm test` passes 73 tests; lint and TypeScript checks pass. The production build passes from a clean `.next` directory. Live validation is summarized above; no test calls the live API.

Before considering a credentialed release:

1. Get written confirmation that the project, deployment model, and public derived proximity summaries are allowed under the intended plan. Confirm whether a freemium plan permits this non-internal, third-party display.
2. Recheck the tested query cost and account entitlement over time; one observed cost does not guarantee future pricing or establish long-term quota behavior.
3. Add request authentication and a server-side rate cap before putting credentials in any publicly reachable production environment.
4. Confirm how Netlify access, function logs, retention, and secret configuration work for the intended production deploy.
5. Continue checking live semantics and coverage across more conditions; the examples above do not establish detection completeness, sensitivity, or an exact latency distribution.

## Sources

- [X1] [Xweather lightning endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning) — endpoint, standard access limits, event fields, and endpoint multiplier.
- [X2] [Xweather authentication](https://www.xweather.com/docs/weather-api/getting-started/authentication) — application credentials and namespace restrictions.
- [X3] [Vaisala General Conditions for Subscription Services](https://docs.vaisala.com/api/khub/documents/_2cuASo637CBKluQEurbLA/content) — linked from Xweather’s terms page; internal-use license, limits on third-party distribution, freemium restrictions, and attribution terms. The PDF is dated 1 January 2023; confirm the current agreement before use.
- [X4] [Xweather cost headers](https://www.xweather.com/docs/weather-api/getting-started/cost-headers) — request cost and token metadata.
- [X5] [Xweather API rate limiting](https://www.xweather.com/docs/weather-api/getting-started/rate-limiting) — per-minute and billing-period limits and headers.
- [X6] [Xweather subscription plans](https://www.xweather.com/products/weather-api) — advertised free-tier allowance and endpoint availability. Account-level terms and entitlement remain unverified.
- [X7] [Xweather attribution guide](https://www.xweather.com/docs/weather-api/resources/attribution) — product attribution examples.
- [N1] [Netlify Next.js runtime support](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) — Next.js Route Handler / API route serverless support.
