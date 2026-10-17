# Experimental Blitz server adapter (PR-B)

The PR112 dual-source observer's bounded `/recent` cache is the only Blitz data source for this adapter. The Next.js server reads our observer HTTP API; browsers must call only `/api/lightning/blitz-experimental` and never connect to the observer or Blitzortung directly. There is no UI consumer yet.

The server requests 15 minutes within 50 km for recent activity and 5 minutes within 40 km for current activity. The two windows retain their own `coverage.complete` and `coverage.usable` metadata. An empty result is **clear** only when `complete` is true; empty incomplete results are **unknown**, even if `usable` is true. `usable` permits short reconnect gaps and cannot prove no strike was missed. Events with incomplete coverage can still be **active**. Blitz pulse type remains `unknown` because CG/IC classification is not established.

Configure `BLITZ_OBSERVER_API_BASE_URL` and `BLITZ_OBSERVER_API_TOKEN` on the Next.js server only. The token travels in `X-Observer-Token` and is never returned to the browser. This PR adds no UI, persistence, additional Blitz connection, or deployment.
