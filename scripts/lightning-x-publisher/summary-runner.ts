import { readFile } from "node:fs/promises";
import { renderPublisherSummary } from "./summary.ts";
import type { PublisherResult } from "./publisher.ts";

try {
  const result = JSON.parse(await readFile("artifacts/lightning-x-publisher-result.json", "utf8")) as PublisherResult;
  console.log(renderPublisherSummary(result));
} catch {
  console.log("## X publication result\n\nNo structured result was produced. Inspect the ledger and X before any retry.\n");
}
