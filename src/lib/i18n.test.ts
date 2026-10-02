import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, directionLabel, formatClock, formatDayLabel, forecastHeadline, readStoredLocale, riskLabel, saveLocale, t } from "./i18n.ts";
import { summarizeSignal } from "./outlook.ts";
import { liveActivityCopy, liveEventCountCopy, liveSeverityLabel } from "./live-observation.ts";
import { buildTodayBriefing } from "./today-briefing.ts";
import { describeWeatherCode } from "./weather.ts";
import { reverseGeocodeLocation, searchPlaceQuery, searchPlaces } from "./geocoding.ts";
import type { LiveLightningSummary } from "./lightning/types.ts";

test("Turkish defaults, English persists, invalid and unavailable storage fall back safely", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(DEFAULT_LOCALE, "tr");
  assert.equal(readStoredLocale(storage), "tr");
  saveLocale(storage, "en"); assert.equal(values.get(LOCALE_STORAGE_KEY), "en"); assert.equal(readStoredLocale(storage), "en");
  saveLocale(storage, "tr"); assert.equal(readStoredLocale(storage), "tr");
  values.set(LOCALE_STORAGE_KEY, "fr"); assert.equal(readStoredLocale(storage), "tr");
  assert.equal(readStoredLocale({ getItem: () => { throw Error("blocked"); } }), "tr");
  assert.doesNotThrow(() => saveLocale({ setItem: () => { throw Error("blocked"); } }, "en"));
});

test("welcome copy communicates nearby lightning and keeps the permission note concise and separate", () => {
  assert.equal(t("tr", "welcomeEyebrow"), "YEREL YILDIRIM GÖRÜNÜMÜ");
  assert.equal(t("tr", "welcomeTitle"), "Yakınınızda yıldırım ihtimalini görün.");
  assert.equal(t("tr", "welcomeCopy"), "Bir konum seçin; önümüzdeki 24 saatin fırtına görünümünü ve yakın çevredeki güncel yıldırım aktivitesini kontrol edin.");
  assert.equal(t("tr", "permissionNote"), "Konumunuza yalnızca siz izin verdiğinizde erişilir. Seçtiğiniz konum bu cihazda saklanır.");
  assert.equal(t("en", "welcomeEyebrow"), "LOCAL LIGHTNING OUTLOOK");
  assert.equal(t("en", "welcomeTitle"), "See the chance of lightning near you.");
  assert.equal(t("en", "welcomeCopy"), "Choose a location to check the next 24 hours of thunderstorm conditions and current lightning activity nearby.");
  assert.equal(t("en", "permissionNote"), "Your location is accessed only when you allow it. Your selected location is saved on this device.");
  assert.doesNotMatch(t("tr", "welcomeCopy"), /izin|cihazda saklanır/);
  assert.doesNotMatch(t("en", "welcomeCopy"), /allow|saved on this device/i);
});

test("hourly section copy identifies lightning risk in both supported languages", () => {
  assert.equal(t("tr", "hoursAhead"), "YILDIRIM RİSKİ · ÖNÜMÜZDEKİ SAATLER");
  assert.equal(t("tr", "hourlyOutlook"), "Saatlik yıldırım görünümü");
  assert.equal(t("tr", "timelineInstruction"), "Her saat için yıldırım ihtimalini görmek için dokunun.");
  assert.equal(t("tr", "derivedOutlook"), "Yıldırım riski");
  assert.equal(t("en", "hoursAhead"), "LIGHTNING RISK · HOURS AHEAD");
  assert.equal(t("en", "hourlyOutlook"), "Hourly lightning outlook");
  assert.equal(t("en", "timelineInstruction"), "Tap an hour to see the estimated lightning outlook.");
  assert.equal(t("en", "derivedOutlook"), "Lightning risk");
});

test("the same forecast and observation decisions have natural text in both languages", () => {
  for (const risk of ["low", "elevated", "high"] as const) {
    assert.notEqual(forecastHeadline("tr", risk), forecastHeadline("en", risk));
    assert.equal(riskLabel("tr", risk), { low: "Düşük", elevated: "Artmış", high: "Yüksek" }[risk]);
  }
  assert.match(summarizeSignal(null, "", "tr"), /Tahmin saatlerinde/);
  assert.match(summarizeSignal({ risk: "high", start: 1, end: 2 }, "12:00–13:00", "tr"), /En güçlü dönem: 12:00–13:00/);
  assert.match(summarizeSignal({ risk: "elevated", start: 1, end: 2 }, "12:00–13:00", "en"), /plausible/);
  const summary = {
    recentArea: { status: "active", totalDetections: 8 }, current: { status: "active" },
  } as LiveLightningSummary;
  assert.equal(liveActivityCopy(summary, "tr"), "Son 30 dakikada 50 km içinde de aktivite tespit edildi.");
  assert.equal(liveActivityCopy(summary, "en"), "Activity also detected within 50 km during the last 30 minutes.");
  assert.equal(liveEventCountCopy(1, 10, "tr"), "Son 5 dakikada 10 km içinde 1 yıldırım olayı");
  assert.equal(liveEventCountCopy(8, 10, "en"), "8 recent lightning events within 10 km · last 5 min");
  assert.equal(liveSeverityLabel("high", "tr"), "Yüksek");
  assert.equal(liveSeverityLabel("elevated", "en"), "Elevated");
  assert.equal(liveSeverityLabel("nearby", "tr"), "Yakında aktivite");
  assert.equal(directionLabel("tr", "SE"), "güneydoğu");
  assert.equal(directionLabel("en", "SE"), "southeast");
});

test("Today and ordinary weather descriptions localize without changing the local day", () => {
  const day = { date: "2026-10-01", weatherCode: 3, highC: 16, lowC: 10, precipitationProbability: 5, precipitationMm: 0 };
  const instant = Date.UTC(2026, 9, 1, 10);
  assert.equal(buildTodayBriefing([day], "Europe/Istanbul", instant, 12.6, "tr"), "Şu an 13°C · en yüksek 16°C, en düşük 10°C. Kapalı. Bugün kayda değer yağış beklenmiyor.");
  assert.equal(buildTodayBriefing([day], "Europe/Istanbul", instant, 12.6, "en"), "Now 13°C · high 16°C, low 10°C. Overcast skies. Little or no precipitation is expected today.");
  assert.equal(buildTodayBriefing([day], "Europe/Istanbul", Date.UTC(2026, 9, 1, 21), 12.6, "tr"), null);
  assert.equal(describeWeatherCode(95, "tr"), "Gök gürültülü fırtına işareti");
  assert.equal(describeWeatherCode(95, "en"), "Thunderstorm signal");
});

test("locale formats labels but the forecast location timezone still determines the hour and day", () => {
  const instant = Date.UTC(2026, 9, 1, 22, 30);
  assert.equal(formatClock(instant, "Europe/Istanbul", "tr"), "01:30");
  assert.equal(formatClock(instant, "Europe/Istanbul", "en"), "01:30");
  assert.equal(formatClock(instant, "UTC", "tr"), "22:30");
  assert.notEqual(formatDayLabel(instant / 1000, "Europe/Istanbul", "tr"), formatDayLabel(instant / 1000, "Europe/Istanbul", "en"));
});

test("new geocoding requests use the chosen language; switching locale alone makes no request", async () => {
  const calls: URL[] = [];
  const fetcher = (async (input: URL) => { calls.push(input); return new Response(JSON.stringify({ results: [] , address: { city: "Ankara" } })); }) as typeof fetch;
  const storage = { getItem: () => null, setItem: () => {} };
  const location = { latitude: 39.9, longitude: 32.8 };
  saveLocale(storage, "en"); saveLocale(storage, "tr");
  assert.deepEqual(location, { latitude: 39.9, longitude: 32.8 });
  assert.equal(calls.length, 0);
  await searchPlaceQuery("Ankara", undefined, "tr", fetcher);
  await searchPlaceQuery("Ankara", undefined, "en", fetcher);
  await reverseGeocodeLocation(39.9, 32.8, undefined, fetcher, "tr");
  await reverseGeocodeLocation(39.9, 32.8, undefined, fetcher, "en");
  assert.deepEqual(calls.map((url) => url.searchParams.get(url.pathname.endsWith("reverse") ? "accept-language" : "language")), ["tr", "en", "tr", "en"]);
  const locales: string[] = [];
  await searchPlaces("Batman, Belde", undefined, async (_query, _signal, locale) => { locales.push(locale ?? ""); return []; }, "tr");
  assert.deepEqual(locales, ["tr", "tr", "tr"]);
  assert.equal(t("tr", "currentPicture"), "GÜNCEL DURUM");
});
