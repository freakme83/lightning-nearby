# Research paired-artifact message preview

This local adapter takes an existing `paired_result` JSON artifact and an explicit normalized location `displayLabel`, maps only the incident ID, current `lastActivityTimeMs`, enrichment status, and selected CG match coordinates to the existing Turkish message composer, and returns its exact dry-run text with metadata. The paired artifact does not contain a location label. This step does not geocode, query a provider, modify an incident, or publish anything.

```sh
npm run research:paired-message-preview -- --artifact=artifacts/lightning-cg-paired-result.json --location="Aşağı Ayrancı, Çankaya"
npm run research:paired-message-preview -- --fixture=reactivated_cg --location="Beynam, Balâ"
npm run test:research:paired-message-preview
```

The CLI prints structured JSON to stdout and a readable final post to stderr. Synthetic replay fixtures include CG, IC, no-match, provider-unavailable, reactivated CG, and malformed input. No workflow or default-branch dispatch is required.

`no_publish_candidate` and `no_fresh_publish_candidate` are not composable. Malformed paired data returns an adapter error; a missing normalized label or CG match retains the composer's structured error and emits no post. The trigger mode is retained as preview metadata, while freshness, reactivation, provider, and cost diagnostics never enter public text. A reactivated incident uses its **current** `lastActivityTimeMs`; only the selected matched CG coordinate forms a CG map URL. Public wording, timezone, hashtags, and length rules remain owned by the composer.
