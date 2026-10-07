import type { PairedValidationArtifact } from "../lightning-cg-paired-validation/types.ts";
import type { ComposeResult, ComposedMessage, ComposerEnrichmentStatus } from "../lightning-message-composer/types.ts";

export type PairedResult = Extract<PairedValidationArtifact, { status: "paired_result" }>;
export type PairedTriggerMode = PairedResult["triggerMode"];
export type PairedSourceStatus = PairedValidationArtifact["status"] | "unknown";

export type PairedPreviewInput = {
  artifact: unknown;
  locationDisplayLabel: string | null;
};

export type PairedMessagePreview =
  | {
    ok: true;
    sourceStatus: "paired_result";
    triggerMode: PairedTriggerMode;
    incidentId: string;
    locationDisplayLabel: string;
    enrichmentStatus: ComposerEnrichmentStatus;
    composer: ComposedMessage;
    text: string;
    characterCount: number;
    mapUrl: string | null;
  }
  | {
    ok: false;
    sourceStatus: PairedSourceStatus;
    triggerMode?: PairedTriggerMode;
    incidentId?: string;
    locationDisplayLabel: string | null;
    enrichmentStatus?: ComposerEnrichmentStatus;
    composer?: Extract<ComposeResult, { ok: false }>;
    error: {
      code: "not_paired_result" | "malformed_paired_artifact" | "composer_error";
      message: string;
    };
    text: null;
    characterCount: number | null;
    mapUrl: null;
  };
