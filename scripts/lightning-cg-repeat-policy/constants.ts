// CG admission defaults. Keep the database RPC policy version in sync when tuning.
export const CG_REPEAT_URBAN_MIN_DISTANCE_KM = 1;
export const CG_REPEAT_RURAL_MIN_DISTANCE_KM = 5;
export const CG_REPEAT_BURST_WINDOW_MINUTES = 20;
export const CG_REPEAT_MAX_ADMISSIONS_PER_WINDOW = 3; // Includes the initial CG admission.
export const CG_REPEAT_POLICY_VERSION = "cg-repeat:v1";
export const CG_REPEAT_PROBE_MIN_INTERVAL_MS = 120_000;
export const CG_REPEAT_MAX_TRACKED_SCOPES = 32;
export const CG_REPEAT_SELECTED_MAX_REFERENCE_DELTA_MS = 60_000;
// A restart/disconnection loses lifecycle continuity. No repeat override until a
// full close+cooldown interval of observed healthy service; initial rules stay intact.
export const CG_REPEAT_RECOVERY_HOLD_MS = 40 * 60_000;
