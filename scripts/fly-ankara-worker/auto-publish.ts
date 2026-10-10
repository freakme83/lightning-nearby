import { applyManualApproval, type ApprovalStore } from "../lightning-publication-ledger/approval.ts";
import { createSupabaseApprovalStore } from "../lightning-publication-ledger/storage/supabase.ts";
import { createPublisherDispatcher, type PublisherDispatcher } from "../lightning-github-dispatch/publisher.ts";

export type FlyAutoPublish = { approvalStore: ApprovalStore; dispatchPublisher: PublisherDispatcher };
type Emit = (kind: string, fields?: Record<string, unknown>) => void;

export function createFlyAutoPublish(environment: Record<string, string | undefined>,
  emit: Emit, fetcher: typeof fetch = fetch): FlyAutoPublish | undefined {
  if (environment.LIGHTNING_AUTO_PUBLISH_ENABLED !== "true") return undefined;
  const github = createPublisherDispatcher(environment, fetcher);
  if (!github.dispatch) {
    emit("configuration_warning", { capability: "autoPublish", disabled: true,
      invalidSettings: github.invalidSettings });
    return undefined;
  }
  return { approvalStore: createSupabaseApprovalStore({ url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY }, fetcher), dispatchPublisher: github.dispatch };
}

// Called once, solely from the freshly inserted safe pending-candidate path,
// after the independent Telegram attempt. Persistence remains authoritative.
export async function autoPublishNewPending(publicationId: string, incidentId: string,
  configuration: FlyAutoPublish | undefined, emit: Emit, now: () => number): Promise<void> {
  const identity = { publicationId, incidentId };
  if (!configuration) {
    emit("auto_publish_disabled", { ...identity, reason: "disabled_or_unconfigured" });
    return;
  }
  try {
    const approval = await applyManualApproval(publicationId, "approve", configuration.approvalStore,
      { actor: "fly:guarded-auto-publish", now: () => new Date(now()).toISOString() });
    // Manual approval intentionally treats same-action races/reruns as success.
    // Auto mode is stricter: only this attempt's confirmed pending transition
    // authorizes dispatch. An already-approved row or concurrent winner cannot.
    if (approval.outcome !== "updated" || approval.previousStatus !== "pending" || approval.finalStatus !== "approved") {
      emit("auto_approval_failed", { ...identity, reason: approval.outcome });
      return;
    }
  } catch {
    emit("auto_approval_failed", { ...identity, reason: "unexpected_error" });
    return;
  }
  emit("auto_approval_succeeded", { ...identity, approvalStatus: "approved" });
  try {
    const dispatched = await configuration.dispatchPublisher(publicationId);
    emit(dispatched.ok ? "auto_publish_dispatch_sent" : "auto_publish_dispatch_failed", {
      ...identity, ...(dispatched.ok ? {} : { reason: dispatched.reason }),
      ...(dispatched.httpStatus === undefined ? {} : { httpStatus: dispatched.httpStatus }),
    });
  } catch {
    emit("auto_publish_dispatch_failed", { ...identity, reason: "unexpected_error" });
  }
  // No rollback, retries, or PUBLISHED claim. GitHub independently checks the
  // final kill switch and owns the existing publish_attempt_id protocol.
}
