# Blitzortung read-only connectivity and decoder probe

This research-only probe answers whether the current raw Blitzortung WebSocket line is technically reachable and decodable. It does not compare sources, rank them, feed the incident lifecycle, or change production. LightningMaps/live2 remains the exclusive production trigger source.

## Boundary and protocol assumptions

The standalone code lives in `scripts/research/blitzortung-probe/` and is reached only through the manual `research:blitzortung-probe` package command. Nothing in the Fly worker, app, or existing live2 research runners imports it. Its only non-local import is the existing pure `pointInMonitoringArea` geometry helper, used read-only; it does not import lifecycle engines or runners.

The endpoint rotation is `wss://ws1.blitzortung.org/`, `wss://ws7.blitzortung.org/`, and `wss://ws8.blitzortung.org/`. After open, the probe sends `{"a":111}`. Text frames are decoded with the compact LZW dictionary algorithm used by the current `Panzer1119/BlitzortungAPI` implementation (4.1.1, inspected at commit `18e1520f33681d143777d80c10f997c52b5af5c1`). The protocol is unofficial and undocumented, so endpoint, subscription, compression, and payload fields may change without notice.

Top-level strike time is preserved as an integer string before JSON parsing. The current observed 19-digit value is treated as Unix nanoseconds and safely reduced with `BigInt` to integer milliseconds; the raw value and inferred unit remain in event telemetry. `pol`, `mds`, `mcg`, `region`, and `sig` count are reported as source facts only. They are not quality scores and no CG/IC inference is made.

This is an unofficial/raw-feed experiment. Existing project research documents identify permission and redistribution questions that remain unresolved. Technical reachability is not authorization for a public product.

## Run for 5–10 minutes

From the repository root (Node 22.6 or newer):

```sh
npm run research:blitzortung-probe -- --duration=10 --summary-every=60 --format=jsonl
```

`--duration` is minutes and defaults to 10. `--summary-every` is seconds and defaults to 60. To constrain a manual endpoint check, pass for example `--servers=ws7`; otherwise the probe rotates through `ws1,ws7,ws8` after failures/disconnects. Reconnect delay is bounded exponential backoff with jitter. No deployment is part of this probe.

## Telemetry

Every emitted record contains `source: "blitzortung"`; endpoint-specific records also contain `sourceServer` (`ws1`, `ws7`, or `ws8`). Dedicated log kinds are:

- `blitzortung_start`
- `blitzortung_connection`
- `blitzortung_event`
- `blitzortung_decode_error`
- `blitzortung_json_parse_error`
- `blitzortung_payload_rejected`
- `blitzortung_summary`

Event logs contain receive time, normalized and raw event time, inferred timestamp unit, receive-minus-event latency, coordinates, raw polarity/`mds`/`mcg`/region, station count when `sig` is present, Ankara monitoring-area membership, source server, and encoded/decoded character counts. Summary fields are all `blitz...`-prefixed and cover connection state, frames, decoder/JSON/rejection counts, usable events, inside/outside counts, reconnects, last frame/strike, and bounded latency min/median/max.

## Isolation guarantees

- The probe has its own connection state and counters. It never reads or mutates live2 `sourceHealthy`, counters, dedupe, candidates, clusters, incidents, association, recovery, or repeat-CG state.
- A decoded strike terminates in source-specific logging and probe-local statistics. There is no import or call edge to Xweather, Supabase, Telegram, the publisher, message composer, public PWA state, or any lifecycle runner/engine.
- The manual command is not included in `start`, build, Fly, or CI runtime commands. A disconnect or decoder failure can only affect the probe process.
- Existing live2 log kinds and metric meanings are unchanged.

Focused tests cover the compressed frame algorithm, JSON/event extraction, precision-safe timestamp handling, reuse of the Ankara polygon, malformed data, decoder containment, source-local counters/health, the runtime import boundary, and manual-only package wiring. Normal tests never contact live servers.

Optional manual smoke runs on 16 October 2026 reached all three endpoints and sent `{"a":111}`. `ws1` opened in about 6.0 seconds and decoded 202/202 frames during one minute; `ws7` opened in about 4.0 seconds and decoded 57/57 frames during 12 seconds; `ws8` opened in about 6.3 seconds and decoded 44/44 frames during 12 seconds. No run recorded a decoder, JSON, or payload-shape failure. The one-minute `ws1` sample had receive-minus-event latency from 1,529 to 17,656 ms (median 5,819 ms). No event in these short samples was inside the Ankara monitoring area. These observations establish only momentary endpoint, handshake, and decoder viability.

## Next phase, not implemented here

PR 2 may run live2 as production-authoritative while Blitzortung remains a read-only shadow source long enough to observe both. Only that later phase may add cross-source observation/matching telemetry. This PR contains no matching window, same-discharge inference, source scoring, preference, failover, fusion, UI work, or Xweather replacement. No conclusion about source superiority or production suitability should be drawn from PR 1.
