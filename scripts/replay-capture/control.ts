import { randomUUID } from "node:crypto";
import { createCaptureStore } from "./store.ts";
import { validateCaptureSettings } from "./geometry.ts";

export async function runCaptureControl(environment: Record<string, string | undefined>,
  log: (value: unknown) => void = value => console.log(JSON.stringify(value))): Promise<void> {
  const operation = environment.CAPTURE_OPERATION;
  if (!["start","status","stop"].includes(operation ?? "")) throw new Error("Invalid capture operation");
  if (operation === "start" && (!environment.CAPTURE_CENTER_LAT?.trim() ||
      !environment.CAPTURE_CENTER_LON?.trim())) throw new Error("Start requires center latitude and longitude");
  const settings = operation === "start" ? validateCaptureSettings(
    Number(environment.CAPTURE_CENTER_LAT), Number(environment.CAPTURE_CENTER_LON),
    Number(environment.CAPTURE_SIDE_KM), Number(environment.CAPTURE_DURATION_MINUTES)) : null;
  const store = createCaptureStore({ url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY });
  if (operation === "start") {
    const result = await store.request(randomUUID(), settings!, settings!.durationMinutes);
    log({ kind: "replay_capture_requested", ...result, centerLat: settings!.centerLat,
      centerLon: settings!.centerLon, sideKm: settings!.sideKm, durationMinutes: settings!.durationMinutes });
    if (result.outcome === "conflict") throw new Error("An active or requested capture already exists");
  } else if (operation === "stop") {
    log({ kind: "replay_capture_stop", ...await store.stop() });
    log({ kind: "replay_capture_status", session: await store.status() });
  } else log({ kind: "replay_capture_status", session: await store.status() });
}

if (process.argv[1]?.endsWith("/scripts/replay-capture/control.ts")) {
  runCaptureControl(process.env).catch(error => {
    // Never print raw upstream bodies or credentials.
    console.error(JSON.stringify({ kind: "replay_capture_control_error",
      reason: error instanceof Error && error.message.startsWith("Capture RPC failed")
        ? "capture storage unavailable" : error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
