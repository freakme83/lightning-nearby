import { decidePublish, type DecisionContext } from "../lightning-publish-decision/decision.ts";
import { duplicateDecisionContext, matchPublicationDuplicate } from "../lightning-publication-ledger/duplicate.ts";
import { buildPublicationRecord } from "../lightning-publication-ledger/record.ts";
import type { DuplicateMatchResult } from "../lightning-publication-ledger/types.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { DryRunResult } from "./orchestrate.ts";
import type { CgAdmissionRequest, CgAdmissionResult } from "../lightning-cg-repeat-policy/admission.ts";

export type LedgerDiagnostics = {
  persistenceEnabled: boolean;
  historyChecked: boolean;
  recordsExamined: number;
  duplicateMatch: DuplicateMatchResult | null;
  recordPersisted: boolean;
  persistedPublicationId: string | null;
  writeDisposition: "inserted" | "already_present" | null;
  approvalStatus: "pending" | null;
  storageStatus: "ok" | "not_configured" | "read_failed" | "write_failed" | "invalid_candidate";
  reason: string | null;
  cgAdmission?: CgAdmissionResult;
};

// Storage is injected; neither the v1A policy nor the v1B.1 matcher performs I/O.
export async function applyPersistentLedger(result: DryRunResult, context: DecisionContext,
  store: LedgerStore | null, options: { runId?: string | null; configured?: boolean; cgAdmission?: CgAdmissionRequest } = {}): Promise<DryRunResult> {
  if (result.status !== "message_preview_ready") return result;
  const diagnostics: LedgerDiagnostics = { persistenceEnabled: options.configured ?? Boolean(store),
    historyChecked: false, recordsExamined: 0, duplicateMatch: null,
    recordPersisted: false, persistedPublicationId: null, writeDisposition: null, approvalStatus: null,
    storageStatus: "not_configured", reason: null };
  const finish = (extra: Partial<DecisionContext>, status: LedgerDiagnostics["storageStatus"], reason: string | null) => ({
    ...result, ledger: { ...diagnostics, storageStatus: status, reason },
    publishDecision: decidePublish(result, { ...context, ...extra, persistentHistoryEnabled: Boolean(store) }),
  });
  if (!store) return finish({ publicationHistoryAvailable: false }, "not_configured", "Supabase ledger configuration is missing or invalid.");
  const provisional = { ...result, publishDecision: decidePublish(result, context) };
  const built = buildPublicationRecord(provisional, { runId: options.runId });
  if (!built.ok) return finish({ publicationHistoryAvailable: false }, "invalid_candidate", built.message);
  let history;
  try {
    history = await store.loadRelevantPublicationHistory(built.record);
  } catch {
    return finish({ publicationHistoryAvailable: false }, "read_failed", "Publication history could not be read.");
  }
  diagnostics.historyChecked = true;
  diagnostics.recordsExamined = history.length;
  diagnostics.duplicateMatch = matchPublicationDuplicate(built.record, history);
  let final = { ...result, publishDecision: decidePublish(result, {
    ...context, ...duplicateDecisionContext(diagnostics.duplicateMatch), persistentHistoryEnabled: true,
    knownDuplicate: context.knownDuplicate === true || diagnostics.duplicateMatch.duplicate,
  }) };
  const finalBuilt = buildPublicationRecord(final, { runId: options.runId });
  if (!finalBuilt.ok) return finish({ publicationRecordAvailable: false }, "invalid_candidate", finalBuilt.message);
  const exactMessageText = result.message?.ok ? result.message.text : "";
  const admission = options.cgAdmission;
  if (admission?.kind === "repeat" && (!finalBuilt.record.cgMetadata?.semanticIdentity.available ||
      !finalBuilt.record.providerEventId || finalBuilt.record.enrichmentStatus !== "cg_verified")) {
    return finish({ cgRepeatGate: { eligible: false, reason: "cg_repeat_metadata_unavailable" } },
      "invalid_candidate", "Selected CG semantic metadata is unavailable.");
  }
  if (admission && finalBuilt.record.enrichmentStatus === "cg_verified") finalBuilt.record.cgScopeId = admission.scopeId;
  try {
    let disposition: "inserted" | "already_present";
    if (admission && finalBuilt.record.enrichmentStatus === "cg_verified" && finalBuilt.record.decision === "WOULD_PUBLISH") {
      if (!store.admitCgPublication) {
        if (admission.kind === "repeat") throw new Error("Atomic admission unavailable");
        // Test/offline stores keep their initial path. They cannot admit repeats.
        disposition = await store.insertPublicationRecord(finalBuilt.record, exactMessageText);
      } else {
        diagnostics.cgAdmission = await store.admitCgPublication(finalBuilt.record, exactMessageText, admission);
        if (diagnostics.cgAdmission.outcome === "suppressed") {
          return finish({ publicationRecordAvailable: false,
            knownDuplicate: ["same_provider_event", "same_observation_fingerprint", "concurrent_unique_conflict"].includes(diagnostics.cgAdmission.reason),
            cgRepeatGate: { eligible: false, reason: `cg_repeat_${diagnostics.cgAdmission.reason}` } },
            "ok", diagnostics.cgAdmission.reason);
        }
        disposition = diagnostics.cgAdmission.outcome;
      }
    } else {
      // A repeat artifact must never reach insertion without an admission request.
      if (result.paired?.triggerMode === "cg_repeat_probe" && finalBuilt.record.decision === "WOULD_PUBLISH") {
        return finish({ cgRepeatGate: { eligible: false, reason: "cg_repeat_atomic_admission_missing" } }, "invalid_candidate", "Repeat admission request is missing.");
      }
      disposition = await store.insertPublicationRecord(finalBuilt.record, exactMessageText);
    }
    diagnostics.writeDisposition = disposition;
    diagnostics.persistedPublicationId = finalBuilt.record.publicationId;
    if (disposition === "inserted") {
      diagnostics.recordPersisted = true;
      diagnostics.storageStatus = "ok";
      diagnostics.approvalStatus = finalBuilt.record.decision === "WOULD_PUBLISH" ? "pending" : null;
    } else {
      // Immutable row already existed under this ID. It is an idempotent write,
      // but do not claim a fresh WOULD_PUBLISH or a new HOLD audit was recorded.
      try {
        const refreshed = await store.loadRelevantPublicationHistory(finalBuilt.record);
        diagnostics.historyChecked = true;
        diagnostics.recordsExamined = refreshed.length;
        diagnostics.duplicateMatch = matchPublicationDuplicate(finalBuilt.record, refreshed);
      } catch { /* An uncertain existing row still cannot safely publish. */ }
      final = { ...result, publishDecision: decidePublish(result, { ...context,
        knownDuplicate: context.knownDuplicate === true || diagnostics.duplicateMatch?.duplicate === true,
        publicationRecordAvailable: false, persistentHistoryEnabled: true,
      }) };
      diagnostics.storageStatus = "ok";
      diagnostics.reason = "Publication ID already existed; its immutable record was not replaced.";
    }
  } catch {
    // A concurrent writer may have inserted a blocking provider event. Recheck before
    // reporting the failure; never report WOULD_PUBLISH after a failed write.
    try {
      const refreshed = await store.loadRelevantPublicationHistory(finalBuilt.record);
      diagnostics.historyChecked = true;
      diagnostics.recordsExamined = refreshed.length;
      diagnostics.duplicateMatch = matchPublicationDuplicate(finalBuilt.record, refreshed);
    } catch { /* Preserve the original write failure. */ }
    final = { ...result, publishDecision: decidePublish(result, { ...context,
      knownDuplicate: context.knownDuplicate === true || diagnostics.duplicateMatch?.duplicate === true,
      publicationRecordAvailable: false, persistentHistoryEnabled: true,
    }) };
    diagnostics.storageStatus = "write_failed";
    diagnostics.reason = "Publication record could not be persisted; shadow publication is held.";
    // Retain a HOLD audit record where storage is still available. Never turn a failed
    // WOULD_PUBLISH write into a successful publication decision.
    const held = buildPublicationRecord(final, { runId: options.runId });
    if (held.ok) {
      try {
        const disposition = await store.insertPublicationRecord(held.record, exactMessageText);
        diagnostics.writeDisposition = disposition;
        diagnostics.recordPersisted = disposition === "inserted";
        diagnostics.persistedPublicationId = held.record.publicationId;
      } catch { /* The structured diagnostic remains write_failed. */ }
    }
  }
  return { ...final, ledger: diagnostics };
}
