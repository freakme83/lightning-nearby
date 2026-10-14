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
  const dateTime = `${value("day")} ${month.charAt(0).toLocaleUpperCase("tr-TR")}${month.slice(1)} ${value("year")}, ${value("hour")}:${value("minute")} TSİ`;
  return `Ankara’da, ${dateTime}`;
}

function formatLocation(label: string): string | null {
  if (/[\r\n\u0000-\u001f\u007f]/.test(label)) return null;
  const trimmed = label.trim();
  const separator = trimmed.indexOf(",");
  if (separator < 0) return trimmed;
  const first = trimmed.slice(0, separator).trim();
  const rest = trimmed.slice(separator + 1).trim();
  return first && rest ? `${first}, ${rest}` : null;
}

// FNV-1a over the stable incident ID. Generic wording stays binary; only verified CG may say "teyit edildi".
export function verbForIncident(incidentId: string, status: ComposerEnrichmentStatus = "no_match"):
  "tespit edildi" | "kaydedildi" | "teyit edildi" {
  let hash = 0x811c9dc5;
  for (const character of incidentId) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193);
  }
  if (status === "cg_verified") {
    return (["tespit edildi", "kaydedildi", "teyit edildi"] as const)[(hash >>> 0) % 3];
  }
  return (hash & 1) === 0 ? "tespit edildi" : "kaydedildi";
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
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
  let coordinateText: string;
  if (status === "cg_verified") {
    const match = input.enrichment.match;
    if (match?.type !== "cg" || !validCoordinates(match.latitude, match.longitude)) {
      return error("missing_cg_match", "A selected CG match with valid coordinates is required.");
    }
    const latitude = match.latitude!;
    const longitude = match.longitude!;
    mapUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
    coordinateText = formatCoordinates(latitude, longitude);
  } else {
    const { latitude, longitude } = input.incident;
    if (!validCoordinates(latitude, longitude)) {
      return error("missing_incident_coordinates", "Valid incident/reference coordinates are required for generic lightning activity.");
    }
    coordinateText = formatCoordinates(latitude, longitude);
  }

  // Preserve the internal event marker for lifecycle compatibility; only the CG marker is public.
  const hashtag = status === "cg_verified" ? "#YILDIRIM" : "#ŞİMŞEK";
  const publicHeader = status === "cg_verified" ? "#YILDIRIM ⚡" : null;
  const dateTimeText = formatDateTime(eventTimeMs);
  const verb = verbForIncident(input.incident.id, status);
  const eventText = status === "cg_verified"
    ? `${locationText} civarında yere ulaşan yıldırım ${verb}.`
    : `${locationText} civarında şimşek/yıldırım aktivitesi ${verb}.`;
  const text = [
    ...(publicHeader ? [publicHeader] : []),
    dateTimeText,
    eventText,
    "",
    "Konum:",
    coordinateText,
  ].join("\n");
  const characterCount = [...text].length;
  if (characterCount > maxCharacters) {
    return { ok: false, error: { code: "message_too_long", message: "Message exceeds the configured character budget." }, characterCount };
  }
  return { ok: true, text, hashtag, dateTimeText, locationText, eventText, mapUrl, coordinateText, characterCount, eventKind: status };
}
