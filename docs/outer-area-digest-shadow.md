# Outer-area digest shadow

Research-only telemetry for testing whether multiple publishable initial `#ŞİMŞEK` incidents in the same outer Ankara district would be more useful as one digest.

Current shadow hypothesis:

- only initial `#ŞİMŞEK` publications are observed;
- `#YILDIRIM` bypasses the experiment;
- only explicitly listed outer Ankara districts participate;
- rolling window: 90 minutes;
- candidate threshold: at least 3 distinct incidents;
- semantic breadth: at least 2 distinct localities;
- after an eligible digest, that district enters a 90-minute shadow cooldown;
- no publication, ledger, Telegram, approval, or X behavior is changed.

The worker emits `outer_area_digest_shadow` after an actual `publication_pending` event is observed. Periodic `summary` logs include `outerAreaDigest` counters.

This is evidence gathering only. Thresholds and district scope are intentionally not production policy yet.
