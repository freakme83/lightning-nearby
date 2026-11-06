import test from "node:test";
import assert from "node:assert/strict";
import { endCaption, endTextWithoutAttachment, openStreetMapUrl, replayFilename, startMessage,
  TELEGRAM_CAPTION_LIMIT, type EndSummary } from "./messages.ts";

const T = Date.parse("2026-11-06T11:32:00.000Z"); // 14.32 TSİ
const PID = "11111111-1111-4111-8111-111111111111";
const summary: EndSummary = { periodId: PID, firstDetectionMs: T, firstDetectionExact: true,
  lastDetectionMs: T + 36 * 60_000, closedMs: T + 66 * 60_000 + 500, recordedDetectionCount: 23,
  coverageUncertain: false, interruptionCount: 0,
  archive: { exportedEventCount: 23, missingArchiveRecordCount: 0, unknownDistrictCount: 0,
    districts: [{ district: "Gölbaşı", detections: 15 }, { district: "Haymana", detections: 8 }] } };

test("start message: first detection time, district, map link and a neutral fallback", () => {
  assert.equal(startMessage({ firstDetectionMs: T, nowMs: T + 20_000, district: "Gölbaşı", latitude: 39.79, longitude: 32.81 }),
    "⚡ Ankara'da yıldırım hareketliliği tespit edildi.\nİlk tespit: 14.32 TSİ\nKonum: Gölbaşı\n" +
    "Harita: https://www.openstreetmap.org/?mlat=39.7900&mlon=32.8100#map=11/39.7900/32.8100\n" +
    "Yeni tespitler izleniyor.\nKaynak: Blitzortung tespit kayıtları (bağımsız olarak doğrulanmış yıldırım değildir).");
  const neutral = startMessage({ firstDetectionMs: T, nowMs: T + 86_400_000, district: null, latitude: null, longitude: null });
  assert.match(neutral, /Konum: Ankara izleme alanı/);
  assert.match(neutral, /İlk tespit: 14\.32 TSİ \(06\.11\)/); // dated when reported on another day
  assert.doesNotMatch(neutral, /Harita/);
  assert.equal(openStreetMapUrl(Number.NaN, 32), null);
});

test("completion caption separates first, last and closure times and counts detection records", () => {
  assert.equal(endCaption(summary), "⚡ Ankara yıldırım hareketliliği sona erdi.\nTarih: 06.11.2026\n" +
    "İlk tespit: 14.32 TSİ\nSon tespit: 15.08 TSİ\nKapanış: 15.38 TSİ (30 dk sessizlik sonrası; oynatmaya dahil değil)\n" +
    "Toplam: 23 Blitzortung tespit kaydı\nYoğunlaşan ilçeler: Gölbaşı (15), Haymana (8)\n" +
    "📎 Replay kaydı ektedir (son tespitten 10 sn sonra biter).\n" +
    "Not: Sayılar tespit kaydıdır; doğrulanmış tekil yıldırım sayısı değildir.");
  const flagged = endCaption({ ...summary, coverageUncertain: true, interruptionCount: 3, recordedDetectionCount: 51_234,
    archive: { ...summary.archive!, missingArchiveRecordCount: 2, unknownDistrictCount: 1 } });
  assert.match(flagged, /Toplam: 51\.234 Blitzortung/);
  assert.match(flagged, /İlçesi belirlenemeyen: 1\n⚠️ Arşivde eksik kayıt: 2 \(Replay'de yer almıyor\)\n⚠️ Kapsama belirsiz \(kaynak kesintisi: 3\)/);
});

test("captions stay within Telegram's limit and list at most five districts", () => {
  const districts = Array.from({ length: 25 }, (_, i) => ({ district: `İlçe${"x".repeat(60)}${i}`, detections: 100 - i }));
  const caption = endCaption({ ...summary, archive: { ...summary.archive!, districts } });
  assert.ok(caption.length <= TELEGRAM_CAPTION_LIMIT);
  assert.match(caption, /📎 Replay kaydı ektedir/);
  const normal = endCaption({ ...summary, archive: { ...summary.archive!, districts: districts.map((d, i) =>
    ({ ...d, district: `D${i}` })) } });
  assert.match(normal, /D0 \(100\), D1 \(99\), D2 \(98\), D3 \(97\), D4 \(96\) ve 20 ilçe daha/);
});

test("text-only completion explains the missing attachment without inventing districts", () => {
  const text = endTextWithoutAttachment({ ...summary, archive: undefined, firstDetectionExact: false,
    recordedDetectionCount: 50_001 }, "export_too_large");
  assert.match(text, /Başlangıç: 14\.32 TSİ/);
  assert.match(text, /Toplam: 50\.001 Blitzortung tespit kaydı/);
  assert.match(text, /⚠️ Replay kaydı oluşturulamadı: kayıt sayısı Replay sınırını \(50\.000\) aşıyor\.\nİlçe dağılımı bu nedenle verilemedi\./);
  assert.doesNotMatch(text, /Yoğunlaşan|📎/);
});

test("Replay filename is deterministic and carries the period identity", () => {
  assert.equal(replayFilename(PID, T), `ankara-activity-20261106-1432-tsi-${PID}.json`);
  assert.equal(replayFilename(PID, Date.parse("2026-11-06T21:05:00Z")), `ankara-activity-20261107-0005-tsi-${PID}.json`);
});
