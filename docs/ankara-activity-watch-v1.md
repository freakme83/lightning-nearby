# Ankara Activity Watch v1

Activity Watch is an opt-in observer of fresh, valid Blitzortung detections inside the existing Ankara monitoring polygon. It does not publish or affect the Ankara incident pipeline. `ACTIVITY_WATCH_ENABLED` defaults to disabled.

The database migration must be reviewed and applied separately before enabling the worker integration. The precise inactivity and recovery rules, database contract, and validation are documented with the implementation in this PR.
