# GitHub Actions live incident research test

This manual-only workflow tests whether a GitHub-hosted Ubuntu runner can use the existing live incident research runner and its Node WebSocket client. It does not change the incident or clustering algorithms, and it does not publish messages.

## Run manually

The repository's default branch is `main`. GitHub requires the workflow file to be present on the default branch before `workflow_dispatch` can be run. This PR targets `merge-ready`, so it does not by itself make the workflow dispatchable. Once the workflow is present on `main`, open **Actions → Research Lightning Incident Live Test → Run workflow**, select `merge-ready` (or the desired branch containing the workflow), enter or retain the inputs, and start the run. The workflow is triggered only by `workflow_dispatch`; it does not run on pushes, pull requests, schedules, or other workflows.

Inputs include a monitoring area (`custom` or `ankara`), north/east/south/west coordinates, duration, summary interval, and incident profile A/B/C. Coordinates are used only for `area=custom`; the `ankara` option selects the research operational polygon and its derived subscription box. The default area remains `custom`, with the previously documented Spain research box; prior activity there does not mean it is active during a later run. Duration validation allows 1–45 minutes (default 15). The job uses `ubuntu-latest`, Node 22, and a bounded 55-minute timeout. Summary metrics distinguish the subscription bounding box from the strict local monitoring polygon.

## Logs and interpretation

The existing command runs in JSONL mode. Its output is saved as `artifacts/lightning-incident-live-run.jsonl` and uploaded as artifact `lightning-incident-live-run-<run-id>` for 7 days, including when the live command or later steps fail. The runner does not persist raw event records; it retains its existing bounded in-memory comparison signals only.

The workflow summary reports whether setup and `npm ci` succeeded, whether the command started and its exit code, whether the log contains a successful WebSocket connection and a source frame, and whether the final run summary and same-sequence A/B/C comparison appeared. When present, it also lists event/lifecycle counters and profile comparison metrics.

- Setup or dependency failure is an infrastructure/setup failure, not a live-data result.
- No successful connection or no source frame means the feed was not observed by this runner; it does not mean there was no lightning.
- A completed run with zero fresh events inside the selected monitoring area means no fresh local observations were ingested in that window. It does not establish regional inactivity or feed completeness.
- A successful connection, frame, final summary, and policy comparison demonstrate that the hosted runner reached the feed and executed the experiment. This is not evidence of lossless or real-time coverage.

GitHub-hosted runner IP/network policy may block or reject the LightningMaps WebSocket. If that happens, inspect the artifact and job log first; do not alter the incident model based on a network failure. A later experiment could compare a self-hosted runner or a small research VPS, but neither is introduced here.

This remains a research-only workflow. It uses no secrets, creates no persistent lightning dataset, and sends no notifications or social posts.
