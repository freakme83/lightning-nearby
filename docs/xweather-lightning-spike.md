# Xweather live lightning spike

Research snapshot: 30 September 2026. This spike adds a manually invoked server route and a private debug page; it does not add a live layer to the normal app. No Xweather credentials were available in the development environment, so no live upstream request was made. Tests use synthetic fixtures.

## Decision and release boundary

**Prototype only; no public release with real credentials until Xweather confirms the applicable licence in writing.** The General Conditions document currently linked from Xweather (dated 1 January 2023) describes a freemium license for internal business use and generally restricts publishing, distributing, or making service information available to third parties unless the service description grants broader rights. It also requires attribution when third-party availability is permitted. Xweather’s product page advertises a free tier with access to all endpoints, but endpoint availability does not itself grant public redistribution rights. A public hobby website is not clearly covered by “internal business” use. [X1] [X3] [X7]

The route has no account or request authentication. It is harmless while credentials are absent, but anyone who can reach it could spend the configured account’s quota if credentials are added. Keep credentials unset on public deploys. Before any credentialed preview or production deploy, obtain the appropriate rights and add access control and quota protection. This is a technical prototype, not approval to use or republish Xweather data.

## What Xweather documents

| Item | Documented behavior | Spike behavior |
| --- | --- | --- |
| Endpoint | `GET https://data.api.xweather.com/lightning/closest` is the documented closest-lightning query. Standard access is global and real time, covering the past five minutes. | One request is issued only after the user presses **Refresh** on `/debug/lightning`. |
| Spatial limits | Standard `/lightning` access supports up to a 100 km radius and up to 1,000 events per request. A `skip` parameter can request the next batch, but each batch is another API request. The route asks for 50 km to support the app’s nested 5 / 10 / 25 / 50 km bands. | Uses `p=latitude,longitude`, `radius=50km`, `limit=1000`, and `filter=all`. If all 1,000 slots are filled, the page flags counts as potentially incomplete; it does not silently make another billable request. |
| Event fields | Lightning records include `loc.lat`, `loc.long`, and `ob.timestamp` (Unix seconds). `ob.pulse.type` distinguishes IC (intracloud) and CG (cloud-to-ground); the response example uses lower-case `cg`. The API also uses “strike” terminology. | Converts supported records into coordinates, millisecond timestamps, and case-insensitive IC / CG / unknown type. It does not return upstream event IDs. |
| Credentials | API requests use an application client ID and secret as query parameters. Web app credentials are restricted to the registered namespace, normally the top-level domain. | Credentials are read only in the server route from `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET`. They are not sent by the browser, included in the JSON response, or committed. Confirm that the namespace restriction works for the chosen serverless runtime. Do not enable URL logging that records upstream query strings. |
| Response health | The JSON envelope reports `success`, `error`, and `response`. Authentication, rate, server, malformed, and network failures are not equivalent to an empty event list. | Only a successful no-data response produces a healthy zero. Failures stay explicitly unavailable and do not become zero counts. |
| Attribution | Xweather requires attribution for products using its data; the guidance specifies “Powered by Vaisala Xweather” with a link, or a logo, and prohibits implying endorsement. | The debug page includes linked “Powered by Vaisala Xweather” attribution. Confirm whether this is sufficient for the chosen agreement. |

Standard access documentation says the `/lightning` endpoint has a 10× endpoint multiplier. Actual cost is also affected by spatial and temporal multipliers; use response cost headers, especially `X-Cost-Tokens`, as the authoritative measurement. Cost headers and minute / billing-period rate-limit headers are copied into safe diagnostic metadata when present. Radius-specific spatial pricing could not be determined from the public documentation, so the figures below are planning lower bounds, not a quote. [X1] [X4] [X5]

## Cost and request cadence

Xweather currently advertises 15,000 monthly accesses on its free tier. The account, plan, applicable token definition, and actual request charge have not been verified. Assuming the documented 10× endpoint factor is charged against that allowance and spatial / temporal factors are each at least one, a request costs **at least 10 allowance units**. Runtime `X-Cost-Tokens` must replace that assumption after authorized testing. [X4] [X5] [X6]

| Manual or polling rate | Requests in 30 days | Minimum units at 10× | Approximate time to use 15,000 units at this rate |
| --- | ---: | ---: | ---: |
| 1 manual refresh/day | 30 | 300 | 50 months |
| 5 manual refreshes/day | 150 | 1,500 | 10 months |
| 10 manual refreshes/day | 300 | 3,000 | 5 months |
| Poll every minute | 43,200 | 432,000 | 25 hours |
| Poll every 2 minutes | 21,600 | 216,000 | 50 hours |

At the minimum 10 units per query, the nominal free allowance would cover about 1,500 requests/month, or 50 per day averaged over 30 days. Actual costs may be higher. The spike deliberately has no polling, background refresh, or cache. Manual requests alone are inexpensive at prototype scale under this lower-bound assumption, but public access, spatial pricing, and account-level restrictions remain unverified. Rate-limit headers are useful evidence, not a substitute for an application-side cap.

## Implementation and privacy

- `POST /api/lightning/live` accepts latitude and longitude in a JSON body. The location is not placed in our route URL or a link. The browser sends a request only after a manual click.
- The server makes one request to Xweather and returns a normalized summary plus safe cost / rate-limit diagnostics. It does not persist locations or raw provider payloads. The normal app UI and forecast classification are untouched.
- The summary window is the provider’s recent five-minute observation window. Events are counted in inclusive, nested 5 / 10 / 25 / 50 km bands using Haversine distance. “Events” are detected pulses/strikes, not storms.
- The app’s own request body avoids URL-based location exposure, but the hosting provider receives the body and Xweather receives the requested coordinates. Hosting and upstream operational logs may retain request metadata under their own policies; verify these settings before deployment. Do not log request bodies or credential-bearing Xweather URLs.
- The route uses `Cache-Control: no-store`. Provider failure, quota exhaustion, invalid data, and absent credentials are shown as unavailable states, never as evidence that lightning is absent.
- No database, collector, scheduled task, map, normal-page UI, forecast change, or notification is included.

Next.js Route Handlers are supported by Netlify’s Next.js adapter and run as serverless functions. That fits this bounded request / response proxy; it does not provide persistent collection or shared process memory, neither of which this spike needs. Confirm that deployment uses the current Next.js adapter and set secrets only in a protected environment after the release gates above are resolved. [N1]

## Validation and remaining questions

The parser and route are tested with fixtures for valid IC/CG records, malformed rows, healthy empty responses, absent credentials, authentication and quota failures, malformed payloads, network failure, credential secrecy, coordinate bounds, radius boundaries, the provider event cap, and the five-minute cutoff. `npm test` passes 73 tests; lint and TypeScript checks pass. The production build passes from a clean `.next` directory. No live request was possible because this environment had no configured credentials.

Before considering a credentialed release:

1. Get written confirmation that the project, deployment model, and public derived proximity summaries are allowed under the intended plan. Confirm whether a freemium plan permits this non-internal, third-party display.
2. Verify account entitlement, cost for a 50 km query, billing units, rate limits, and attribution wording with one authorized request. Record actual `X-Cost-Tokens` and rate-limit headers.
3. Add request authentication and a server-side rate cap before putting credentials in any publicly reachable environment.
4. Confirm how Netlify access, function logs, retention, and secret configuration work for the intended deploy context.
5. Test live semantics and coverage, including no-data responses, latency, duplication, and whether the five-minute window is complete enough to interpret a zero.

## Sources

- [X1] [Xweather lightning endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning) — endpoint, standard access limits, event fields, and endpoint multiplier.
- [X2] [Xweather authentication](https://www.xweather.com/docs/weather-api/getting-started/authentication) — application credentials and namespace restrictions.
- [X3] [Vaisala General Conditions for Subscription Services](https://docs.vaisala.com/api/khub/documents/_2cuASo637CBKluQEurbLA/content) — linked from Xweather’s terms page; internal-use license, limits on third-party distribution, freemium restrictions, and attribution terms. The PDF is dated 1 January 2023; confirm the current agreement before use.
- [X4] [Xweather cost headers](https://www.xweather.com/docs/weather-api/getting-started/cost-headers) — request cost and token metadata.
- [X5] [Xweather API rate limiting](https://www.xweather.com/docs/weather-api/getting-started/rate-limiting) — per-minute and billing-period limits and headers.
- [X6] [Xweather subscription plans](https://www.xweather.com/products/weather-api) — advertised free-tier allowance and endpoint availability. Account-level terms and entitlement remain unverified.
- [X7] [Xweather attribution guide](https://www.xweather.com/docs/weather-api/resources/attribution) — product attribution examples.
- [N1] [Netlify Next.js runtime support](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) — Next.js Route Handler / API route serverless support.
