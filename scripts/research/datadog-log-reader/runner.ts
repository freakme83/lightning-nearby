import { readLogReaderConfig, startLogReader } from "./service.ts";

try {
  const config = readLogReaderConfig(process.env);
  startLogReader(config);
  console.log(`Datadog log reader listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to start Datadog log reader");
  process.exitCode = 1;
}
