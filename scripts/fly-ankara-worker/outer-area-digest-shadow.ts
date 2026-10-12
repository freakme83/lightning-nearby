// Research-only shadow telemetry for aggregating outer-area initial #ŞİMŞEK publications.
// This module never changes a publication decision and has no side effects beyond in-memory diagnostics.
export const OUTER_AREA_DIGEST_WINDOW_MS = 90 * 60_000;
export const OUTER_AREA_DIGEST_MIN_INCIDENTS = 3;
export const OUTER_AREA_DIGEST_MIN_LOCALITIES = 2;

const OUTER_ANKARA_DISTRICTS = new Set([
  "Akyurt", "Ayaş", "Balâ", "Bala", "Beypazarı", "Çamlıdere", "Çubuk", "Elmadağ", "Evren", "Güdül", "Haymana",
  "Kahramankazan", "Kalecik", "Kızılcahamam", "Nallıhan", "Polatlı", "Şereflikoçhisar",
]);

type Candidate = { incidentId: string; atMs: number; district: string; locality: string };
type DistrictState = { candidates: Candidate[]; cooldownUntilMs: number | null };

export type OuterAreaDigestEvaluation = {
  shadowOnly: true;
  district: string;
  windowStartMs: number;
  windowEndMs: number;
  incidentCount: number;
  distinctLocalityCount: number;
  incidentIds: string[];
  localities: string[];
  eligible: boolean;
  newlyEligible: boolean;
  reason: "threshold_met" | "insufficient_incidents" | "insufficient_localities" | "digest_cooldown";
  cooldownUntilMs: number | null;
  wouldSuppressIndividualShimsekCount: number;
};

export class OuterAreaDigestShadow {
  private readonly states = new Map<string, DistrictState>();
  readonly counters = {
    outerAreaCandidates: 0,
    outerAreaDistrictEvaluations: 0,
    outerAreaEligibleDigests: 0,
    outerAreaWouldSuppressIndividualShimsek: 0,
    outerAreaIgnoredNonOuterDistrict: 0,
    outerAreaIgnoredCg: 0,
    outerAreaIgnoredUnusableLocation: 0,
  };

  observePublication(input: { incidentId: string; atMs: number; messageText: string }): OuterAreaDigestEvaluation | null {
    if (input.messageText.startsWith("#YILDIRIM")) { this.counters.outerAreaIgnoredCg++; return null; }
    if (!input.messageText.startsWith("#ŞİMŞEK")) return null;
    const parsed = parseLocationLine(input.messageText);
    if (!parsed) { this.counters.outerAreaIgnoredUnusableLocation++; return null; }
    if (!OUTER_ANKARA_DISTRICTS.has(parsed.district)) { this.counters.outerAreaIgnoredNonOuterDistrict++; return null; }

    this.counters.outerAreaCandidates++;
    const state = this.state(parsed.district);
    if (state.cooldownUntilMs !== null && input.atMs < state.cooldownUntilMs) {
      return {
        shadowOnly: true, district: parsed.district,
        windowStartMs: input.atMs - OUTER_AREA_DIGEST_WINDOW_MS, windowEndMs: input.atMs,
        incidentCount: 0, distinctLocalityCount: 0, incidentIds: [], localities: [], eligible: false, newlyEligible: false,
        reason: "digest_cooldown", cooldownUntilMs: state.cooldownUntilMs, wouldSuppressIndividualShimsekCount: 0,
      };
    }
    if (state.cooldownUntilMs !== null && input.atMs >= state.cooldownUntilMs) {
      state.cooldownUntilMs = null;
      state.candidates = [];
    }
    const cutoff = input.atMs - OUTER_AREA_DIGEST_WINDOW_MS;
    state.candidates = state.candidates.filter(item => item.atMs >= cutoff && item.atMs <= input.atMs);
    if (!state.candidates.some(item => item.incidentId === input.incidentId)) {
      state.candidates.push({ incidentId: input.incidentId, atMs: input.atMs, district: parsed.district, locality: parsed.locality });
    }
    return this.evaluate(parsed.district, input.atMs);
  }

  summary() { return { ...this.counters }; }

  private evaluate(district: string, nowMs: number): OuterAreaDigestEvaluation {
    const state = this.state(district);
    const cutoff = nowMs - OUTER_AREA_DIGEST_WINDOW_MS;
    state.candidates = state.candidates.filter(item => item.atMs >= cutoff && item.atMs <= nowMs);
    this.counters.outerAreaDistrictEvaluations++;
    const ordered = [...state.candidates].sort((a, b) => a.atMs - b.atMs || a.incidentId.localeCompare(b.incidentId));
    const localities = [...new Set(ordered.map(item => item.locality))];
    const eligible = ordered.length >= OUTER_AREA_DIGEST_MIN_INCIDENTS && localities.length >= OUTER_AREA_DIGEST_MIN_LOCALITIES;
    const reason = ordered.length < OUTER_AREA_DIGEST_MIN_INCIDENTS ? "insufficient_incidents" :
      localities.length < OUTER_AREA_DIGEST_MIN_LOCALITIES ? "insufficient_localities" : "threshold_met";
    const newlyEligible = eligible;
    if (newlyEligible) {
      state.cooldownUntilMs = nowMs + OUTER_AREA_DIGEST_WINDOW_MS;
      this.counters.outerAreaEligibleDigests++;
      this.counters.outerAreaWouldSuppressIndividualShimsek += ordered.length;
    }
    return {
      shadowOnly: true, district, windowStartMs: cutoff, windowEndMs: nowMs,
      incidentCount: ordered.length, distinctLocalityCount: localities.length,
      incidentIds: ordered.map(item => item.incidentId), localities: localities.slice(0, 6),
      eligible, newlyEligible, reason, cooldownUntilMs: state.cooldownUntilMs,
      wouldSuppressIndividualShimsekCount: eligible ? ordered.length : 0,
    };
  }

  private state(district: string): DistrictState {
    let state = this.states.get(district);
    if (!state) { state = { candidates: [], cooldownUntilMs: null }; this.states.set(district, state); }
    return state;
  }
}

function parseLocationLine(messageText: string): { locality: string; district: string } | null {
  const locationLine = messageText.split("\n").find(line => line.includes(" / ") && line.includes(" civarında"));
  if (!locationLine) return null;
  const beforeCivarinda = locationLine.split(" civarında", 1)[0]?.trim();
  if (!beforeCivarinda) return null;
  const separator = beforeCivarinda.lastIndexOf(" / ");
  if (separator <= 0) return null;
  const locality = beforeCivarinda.slice(0, separator).trim();
  const district = beforeCivarinda.slice(separator + 3).trim();
  return locality && district ? { locality, district } : null;
}
