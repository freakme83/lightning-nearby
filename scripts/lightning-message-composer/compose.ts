import type { ComposeResult, ComposerEnrichmentStatus, ComposerInput, ComposerOptions } from "./types.ts";

export const DEFAULT_MAX_CHARACTERS = 280;
export const MESSAGE_TIME_ZONE = "Europe/Istanbul";

const formatter = new Intl.DateTimeFormat("tr-TR", {
  timeZone: MESSAGE_TIME_ZONE,
  day: "numeric", month: "long", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

const supportedStatuses = new Set<ComposerEnrichmentStatus>([
  "cg_verified", "ic_only", "no_match", "provider_unavailable",
]);

function error(code: Exclude<ComposeResult, { ok: true }>["error"]["code"], message: string): ComposeResult {
  return { ok: false, error: { code, message } };
}

function formatDateTime(eventTimeMs: number): string {
  const parts = formatter.formatToParts(new Date(eventTimeMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  const month = value("month");
  return `${value("day")} ${month.charAt(0).toLocaleUpperCase("tr-TR")}${month.slice(1)} ${value("year")}, ${value("hour")}:${value("minute")} TSİ`;
}

function formatLocation(label: string): string | null {
  if (/[\r\n\u0000-\u001f\u007f]/.test(label)) return null;
  const trimmed = label.trim();
  const separator = trimmed.indexOf(",");
  if (separator < 0) return trimmed;
  const first = trimmed.slice(0, separator).trim();
  const rest = trimmed.slice(separator + 1).trim();
  return first && rest ? `${first} / ${rest}` : null;
}

// FNV-1a over the stable incident ID; the low bit chooses one of the two locked verbs.
export function verbForIncident(incidentId: string): "tespit edildi" | "kaydedildi" {
  let hash = 0x811c9dc5;
  for (const character of incidentId) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193);
  }
  return (hash & 1) === 0 ? "tespit edildi" : "kaydedildi";
}

export function composeLightningMessage(input: ComposerInput, options: ComposerOptions = {}): ComposeResult {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    return error("invalid_character_budget", "Maximum character count must be a positive integer.");
  }
  if (typeof input?.incident?.id !== "string" || !input.incident.id.trim()) {
    return error("invalid_incident_id", "A stable incident ID is required.");
  }
  const eventTimeMs = input.incident.lastActivityTimeMs;
  if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs < 0 || eventTimeMs > 8.64e15) {
    return error("invalid_event_time", "A valid incident lastActivityTimeMs is required.");
  }
  if (typeof input.locationDisplayLabel !== "string" || !input.locationDisplayLabel.trim()) {
    return error("missing_location", "A normalized location display label is required.");
  }
  const locationText = formatLocation(input.locationDisplayLabel);
  if (!locationText) return error("invalid_location", "The location label cannot form a safe message line.");
  const status = input.enrichment?.status;
  if (!status || !supportedStatuses.has(status)) return error("invalid_enrichment", "An enrichment state is required.");

  let mapUrl: string | null = null;
  let coordinateText: string | null = null;
  if (status === "cg_verified") {
    const match = input.enrichment.match;
    if (match?.type !== "cg" || typeof match.latitude !== "number" || typeof match.longitude !== "number" ||
        !Number.isFinite(match.latitude) || !Number.isFinite(match.longitude) ||
        Math.abs(match.latitude) > 90 || Math.abs(match.longitude) > 180) {
      return error("missing_cg_match", "A selected CG match with valid coordinates is required.");
    }
    mapUrl = `https://www.google.com/maps?q=${match.latitude},${match.longitude}`;
    coordinateText = `${match.latitude.toFixed(3)}, ${match.longitude.toFixed(3)}`;
  }

  const hashtag = status === "cg_verified" ? "#YILDIRIM" : "#ŞİMŞEK";
  const dateTimeText = formatDateTime(eventTimeMs);
  const eventText = `${locationText} civarında ${status === "cg_verified" ? "yere ulaşan yıldırım" : "şimşek"} ${verbForIncident(input.incident.id)}.`;
  const text = [hashtag, dateTimeText, eventText, ...(coordinateText ? ["", coordinateText] : [])].join("\n");
  const characterCount = [...text].length;
  if (characterCount > maxCharacters) {
    return { ok: false, error: { code: "message_too_long", message: "Message exceeds the configured character budget." }, characterCount };
  }
  return { ok: true, text, hashtag, dateTimeText, locationText, eventText, mapUrl, coordinateText, characterCount, eventKind: status };
}
