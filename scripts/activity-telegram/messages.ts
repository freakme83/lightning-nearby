// Pure Turkish message text for Activity Watch notifications. Times are shown in TSİ
// (Türkiye time, fixed UTC+03:00). Counts are Blitzortung detection records, never presented
// as independently verified physical lightning discharges.
import { MAX_EXPORT_DETECTIONS } from "../activity-export/store.ts";

export const NEUTRAL_LOCATION = "Ankara izleme alanı";
export const TELEGRAM_CAPTION_LIMIT = 1_024;
const TSI_OFFSET_MS = 3 * 60 * 60_000;
const MAX_LISTED_DISTRICTS = 5;

const pad = (value: number) => String(value).padStart(2, "0");
const local = (ms: number) => new Date(ms + TSI_OFFSET_MS);
export const tsiTime = (ms: number) => `${pad(local(ms).getUTCHours())}.${pad(local(ms).getUTCMinutes())}`;
export const tsiDate = (ms: number) =>
  `${pad(local(ms).getUTCDate())}.${pad(local(ms).getUTCMonth() + 1)}.${local(ms).getUTCFullYear()}`;
const tsiDay = (ms: number) => Math.floor((ms + TSI_OFFSET_MS) / 86_400_000);
// Turkish digit grouping without depending on ICU data: 50000 -> "50.000".
const count = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Time, with the day added when it differs from the reference day. */
function timeOn(ms: number, referenceMs: number): string {
  return tsiDay(ms) === tsiDay(referenceMs) ? `${tsiTime(ms)} TSİ`
    : `${tsiTime(ms)} TSİ (${tsiDate(ms).slice(0, 5)})`;
}

export function openStreetMapUrl(latitude: number, longitude: number): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  const lat = latitude.toFixed(4), lon = longitude.toFixed(4);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=11/${lat}/${lon}`;
}

export function startMessage(input: { firstDetectionMs: number; nowMs: number; district: string | null;
  latitude: number | null; longitude: number | null }): string {
  const map = input.latitude === null || input.longitude === null ? null
    : openStreetMapUrl(input.latitude, input.longitude);
  return [
    "⚡ Ankara'da yıldırım hareketliliği tespit edildi.",
    `İlk tespit: ${timeOn(input.firstDetectionMs, input.nowMs)}`,
    `Konum: ${input.district ?? NEUTRAL_LOCATION}`,
    ...(map ? [`Harita: ${map}`] : []),
    "Yeni tespitler izleniyor.",
    "Kaynak: Blitzortung tespit kayıtları (bağımsız olarak doğrulanmış yıldırım değildir).",
  ].join("\n");
}

export type EndSummary = {
  periodId: string;
  firstDetectionMs: number;
  /** false when the first detection time could not be read and the period start is shown. */
  firstDetectionExact: boolean;
  lastDetectionMs: number;
  closedMs: number;
  recordedDetectionCount: number;
  coverageUncertain: boolean;
  interruptionCount: number;
  /** Present only when the archived detections could be read. */
  archive?: { exportedEventCount: number; missingArchiveRecordCount: number;
    districts: { district: string; detections: number }[]; unknownDistrictCount: number };
};

export type AttachmentUnavailableReason = "export_too_large" | "worker_attachment_limit" | "no_archived_events" |
  "archive_inconsistent" | "attachment_too_large" | "export_unavailable";
/**
 * In-worker Replay attachments are capped well below PR-3's 50,000-record ceiling: building a
 * maximum-size export measured about +335 MB peak memory, more than the 256 MB worker VM, while
 * 10,000 records measured about +71 MB. Larger periods are exported with PR-3's operator CLI.
 */
export const WORKER_ATTACHMENT_MAX_DETECTIONS = 10_000;
const UNAVAILABLE_TEXT: Record<AttachmentUnavailableReason, string> = {
  export_too_large: `kayıt sayısı Replay sınırını (${count(MAX_EXPORT_DETECTIONS)}) aşıyor`,
  worker_attachment_limit: `kayıt sayısı Telegram eki sınırını (${count(WORKER_ATTACHMENT_MAX_DETECTIONS)}) aşıyor; ` +
    "Replay kaydı operatör aracıyla alınabilir",
  no_archived_events: "bu döneme ait arşiv kaydı bulunamadı",
  archive_inconsistent: "arşiv verisi tutarsız",
  attachment_too_large: "dosya Telegram boyut sınırını aşıyor",
  export_unavailable: "arşive geçici olarak erişilemedi",
};

function endLines(summary: EndSummary, districtLimit: number): string[] {
  const first = summary.firstDetectionMs;
  const lines = [
    "⚡ Ankara yıldırım hareketliliği sona erdi.",
    `Tarih: ${tsiDate(first)}`,
    `${summary.firstDetectionExact ? "İlk tespit" : "Başlangıç"}: ${timeOn(first, first)}`,
    `Son tespit: ${timeOn(summary.lastDetectionMs, first)}`,
    `Kapanış: ${timeOn(summary.closedMs, first)} (30 dk sessizlik sonrası; oynatmaya dahil değil)`,
    `Toplam: ${count(summary.recordedDetectionCount)} Blitzortung tespit kaydı`,
  ];
  const archive = summary.archive;
  if (archive) {
    if (archive.districts.length && districtLimit > 0) {
      const listed = archive.districts.slice(0, districtLimit).map(item => `${item.district} (${count(item.detections)})`);
      const rest = archive.districts.length - listed.length;
      lines.push(`Yoğunlaşan ilçeler: ${listed.join(", ")}${rest > 0 ? ` ve ${rest} ilçe daha` : ""}`);
    }
    if (archive.unknownDistrictCount) lines.push(`İlçesi belirlenemeyen: ${count(archive.unknownDistrictCount)}`);
    if (archive.missingArchiveRecordCount) {
      lines.push(`⚠️ Arşivde eksik kayıt: ${count(archive.missingArchiveRecordCount)} (Replay'de yer almıyor)`);
    }
  }
  if (summary.coverageUncertain) {
    lines.push(`⚠️ Kapsama belirsiz${summary.interruptionCount ? ` (kaynak kesintisi: ${count(summary.interruptionCount)})` : ""}`);
  }
  return lines;
}

const NOTE = "Not: Sayılar tespit kaydıdır; doğrulanmış tekil yıldırım sayısı değildir.";

/** Caption for the sendDocument message; always within Telegram's 1,024-character limit. */
export function endCaption(summary: EndSummary): string {
  for (let limit = MAX_LISTED_DISTRICTS; ; limit--) {
    const caption = [...endLines(summary, limit), "📎 Replay kaydı ektedir (son tespitten 10 sn sonra biter).", NOTE]
      .join("\n");
    if (caption.length <= TELEGRAM_CAPTION_LIMIT || limit <= 0) return caption.slice(0, TELEGRAM_CAPTION_LIMIT);
  }
}

/** Text-only completion report when no trustworthy Replay attachment can be produced. */
export function endTextWithoutAttachment(summary: EndSummary, reason: AttachmentUnavailableReason): string {
  return [...endLines(summary, MAX_LISTED_DISTRICTS),
    `⚠️ Replay kaydı oluşturulamadı: ${UNAVAILABLE_TEXT[reason]}.`,
    ...(summary.archive ? [] : ["İlçe dağılımı bu nedenle verilemedi."]), NOTE].join("\n");
}

/** Deterministic: first detection (TSİ) plus the full period ID. */
export function replayFilename(periodId: string, firstDetectionMs: number): string {
  const day = tsiDate(firstDetectionMs).split(".").reverse().join("");
  return `ankara-activity-${day}-${tsiTime(firstDetectionMs).replace(".", "")}-tsi-${periodId}.json`;
}
