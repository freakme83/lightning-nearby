# Read-only Datadog EU log reader

This local research utility retrieves recent logs for the fixed Fly app `lightning-nearby-ankara-shadow`. It uses Datadog EU Logs Search only; it does not expose arbitrary queries or any Datadog write/configuration API.

## Start locally

Set `DATADOG_API_KEY` and `DATADOG_APP_KEY` in the process environment, then run:

```sh
npm run research:datadog-log-reader
```

The service listens on `127.0.0.1:3030` by default. `PORT` can select another local port.

```sh
curl http://localhost:3030/health
curl "http://localhost:3030/logs?hours=12"
```

`GET /health` does not contact Datadog. `GET /logs` accepts an integer `hours` value from 1 through 48 and defaults to 12. Results are newest first. Pagination follows Datadog v2's `meta.page.after` cursor through the request's `page.cursor` field. The reader returns at most 5,000 events per request; `truncated` is true when the response indicates more matching results beyond that cap.

Each Datadog request has a 10-second timeout. The only configured Datadog permissions needed are read access to log data. The API key and application key are read from environment variables and are never returned or logged.
