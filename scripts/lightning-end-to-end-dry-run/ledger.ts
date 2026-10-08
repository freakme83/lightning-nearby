import { decidePublish, type DecisionContext } from "../lightning-publish-decision/decision.ts";
import { duplicateDecisionContext, matchPublicationDuplicate } from "../lightning-publication-ledger/duplicate.ts";
import { buildPublicationRecord } from "../lightning-publication-ledger/record.ts";
import type { DuplicateMatchResult } from "../lightning-publication-ledger/types.ts";
import type { LedgerStore } from "../lightning-publication-ledger/storage/supabase.ts";
import type { DryRunResult } from "./orchestrate.ts";

export type LedgerDiagnostics = {
  persistenceEnabled: boolean;
  historyChecked: boolean;
  recordsExamined: number;
  duplicateMatch: DuplicateMatchResult | null;
  recordPersisted: boolean;
  persistedPublicationId: string | null;
  writeDisposition: "inserted" | "already_present" | null;
  storageStatus: "ok" | "not_configured" | "read_failed" | "write_failed" | "invalid_candidate";
  reason: string | null;
};

// Storage is injected; neither the v1A policy nor the v1B.1 matcher performs I/O.
export async function applyPersistentLedger(result: DryRunResult, context: DecisionContext,
  store: LedgerStore | null, options: { runId?: string | null; configured?: boolean } = {}): Promise<DryRunResult> {
  if (result.status !== "message_preview_ready") return result;
  const diagnostics: LedgerDiagnostics = { persistenceEnabled: options.configured ?? Boolean(store),
    historyChecked: false, recordsExamined: 0, duplicateMatch: null,
    recordPersisted: false, persistedPublicationId: null, writeDisposition: null,
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
  }) };
  const finalBuilt = buildPublicationRecord(final, { runId: options.runId });
  if (!finalBuilt.ok) return finish({ publicationRecordAvailable: false }, "invalid_candidate", finalBuilt.message);
  try {
    const disposition = await store.insertPublicationRecord(finalBuilt.record);
    diagnostics.writeDisposition = disposition;
    diagnostics.persistedPublicationId = finalBuilt.record.publicationId;
    if (disposition === "inserted") {
      diagnostics.recordPersisted = true;
      diagnostics.storageStatus = "ok";
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
        knownDuplicate: diagnostics.duplicateMatch?.duplicate ?? false,
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
      knownDuplicate: diagnostics.duplicateMatch?.duplicate ?? false,
      publicationRecordAvailable: false, persistentHistoryEnabled: true,
    }) };
    diagnostics.storageStatus = "write_failed";
    diagnostics.reason = "Publication record could not be persisted; shadow publication is held.";
    // Retain a HOLD audit record where storage is still available. Never turn a failed
    // WOULD_PUBLISH write into a successful publication decision.
    const held = buildPublicationRecord(final, { runId: options.runId });
    if (held.ok) {
      try {
        const disposition = await store.insertPublicationRecord(held.record);
        diagnostics.writeDisposition = disposition;
        diagnostics.recordPersisted = disposition === "inserted";
        diagnostics.persistedPublicationId = held.record.publicationId;
      } catch { /* The structured diagnostic remains write_failed. */ }
    }
  }
  return { ...final, ledger: diagnostics };
}
