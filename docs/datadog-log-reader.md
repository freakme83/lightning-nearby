# Read-only Datadog EU log reader

This local research utility retrieves recent logs for the fixed Fly app `lightning-nearby-ankara-shadow`. It uses Datadog EU Logs Search only; it does not expose arbitrary queries or any Datadog write/configuration API.

## Start locally

Set the required `DATADOG_API_KEY`, `DATADOG_APP_KEY`, and `LOG_READER_TOKEN` environment variables, then run:

```sh
npm run research:datadog-log-reader
```

Optional settings are `HOST` and `PORT`. Locally, use `HOST=127.0.0.1` (the default); the default port is `3030`.

```sh
HOST=127.0.0.1 npm run research:datadog-log-reader
curl http://localhost:3030/health
curl -H "Authorization: Bearer $LOG_READER_TOKEN" "http://localhost:3030/logs?hours=12"
```

`GET /health` is unauthenticated, does not contact Datadog, and returns only a healthy status. `GET /logs` requires `Authorization: Bearer <LOG_READER_TOKEN>` and accepts an integer `hours` value from 1 through 48, defaulting to 12. The token is not accepted through query parameters or cookies. Results are newest first. Pagination follows Datadog v2's `meta.page.after` cursor through the request's `page.cursor` field. The reader returns at most 5,000 events per request; `truncated` is true when the response indicates more matching results beyond that cap.

The service is read-only and always filters to `@fly.app.name:lightning-nearby-ankara-shadow`. Each Datadog request has a 10-second timeout. The only configured Datadog permissions needed are read access to log data. Credentials and the bearer token are read from environment variables and are never returned or logged.

For a future Fly deployment, bind to `HOST=0.0.0.0` and configure `DATADOG_API_KEY`, `DATADOG_APP_KEY`, and `LOG_READER_TOKEN` as runtime secrets. The default bind remains loopback for local use. This repository change does not create or deploy a Fly app.
