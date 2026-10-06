export type ComposerEnrichmentStatus = "cg_verified" | "ic_only" | "no_match" | "provider_unavailable";

export type ComposerInput = {
  incident: { id: string; lastActivityTimeMs: number };
  locationDisplayLabel: string | null;
  enrichment: {
    status: ComposerEnrichmentStatus;
    match?: { type: string; latitude?: number; longitude?: number };
  };
};

export type ComposerOptions = { maxCharacters?: number };

export type ComposedMessage = {
  ok: true;
  text: string;
  hashtag: "#YILDIRIM" | "#ŞİMŞEK";
  dateTimeText: string;
  locationText: string;
  eventText: string;
  mapUrl: string | null;
  characterCount: number;
  eventKind: ComposerEnrichmentStatus;
};

export type ComposerErrorCode =
  | "invalid_incident_id"
  | "invalid_event_time"
  | "missing_location"
  | "invalid_location"
  | "invalid_enrichment"
  | "missing_cg_match"
  | "invalid_character_budget"
  | "message_too_long";

export type ComposeResult =
  | ComposedMessage
  | { ok: false; error: { code: ComposerErrorCode; message: string }; characterCount?: number };
