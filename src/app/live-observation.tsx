"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveLightningApiResult, LiveLightningSummary } from "@/lib/lightning/types";
import type { BlitzExperimentalResult } from "@/lib/lightning/blitz-experimental";
import { claimInitialLiveCheck } from "@/lib/initial-live-check";
import { liveActivitySegments, liveEventCountCopy, liveSeverityLabel, requestLiveCheck } from "@/lib/live-observation";
import { activityMapData, liveActivityView, lookupActivityPlace, type ActivityPlaceContext } from "@/lib/live-activity";
import { canStartLiveSourceRequest, DEVELOPER_LIVE_SOURCE_STORAGE_KEY, isCurrentSourceRequest, livePresentationSeverity, liveSourceEndpoint, normalizeBlitzPresentation, normalizeXweatherPresentation, ownsLiveRequestController, parseStoredLiveSource, shouldRunInitialLiveSourceCheck, unavailableLivePresentation, type LiveLightningPresentation, type LiveLightningSource } from "@/lib/live-lightning-presentation";
import LiveActivityMap from "./live-activity-map";
import type { RiskLevel } from "@/lib/weather";
import { intlLocale, t, type Locale } from "@/lib/i18n";

export interface ForecastContext {
  risk: RiskLevel;
  headline: string;
  summary: string;
  strongestWindow: string | null;
}

interface Props {
  latitude: number;
  longitude: number;
  forecast: ForecastContext | null;
  autoCheckEligible: boolean;
  locale: Locale;
  onManualRefresh: () => void;
  developerMode?: boolean;
  developerModeReady?: boolean;
}

type BlitzFailure = Extract<BlitzExperimentalResult, { ok: false }>;
function failureBlitz(status: BlitzFailure["status"]): BlitzExperimentalResult {
  return { ok: false, status, message: "Unavailable" };
}

function xweatherUnavailable(): LiveLightningApiResult {
  return { ok: false, status: "provider-unavailable", message: "Unavailable", diagnostics: {
    httpStatus: null, costTokens: null, costMultiplier: null, remainingMinute: null, remainingPeriod: null,
  } };
}

function isBlitzResult(value: unknown): value is BlitzExperimentalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.ok === false) return typeof body.status === "string" && typeof body.message === "string";
  if (body.ok !== true || !body.summary || typeof body.summary !== "object") return false;
  const summary = body.summary as Record<string, unknown>;
  if (summary.provider !== "blitzortung-experimental" || !summary.recent || typeof summary.recent !== "object" ||
      !summary.current || typeof summary.current !== "object") return false;
  const recent = summary.recent as Record<string, unknown>;
  const current = summary.current as Record<string, unknown>;
  const validStatus = (status: unknown) => status === "active" || status === "clear" || status === "unknown";
  return validStatus(recent.status) && validStatus(current.status) && Array.isArray(current.events) &&
    Boolean(recent.coverage && typeof recent.coverage === "object") && Boolean(current.coverage && typeof current.coverage === "object");
}

export default function LiveObservation({ latitude, longitude, forecast, autoCheckEligible, locale, onManualRefresh, developerMode = false, developerModeReady = true }: Props) {
  const [source, setSource] = useState<LiveLightningSource>("xweather");
  const [sourcePreferenceReady, setSourcePreferenceReady] = useState(false);
  const sourceRef = useRef<LiveLightningSource>("xweather");
  const [result, setResult] = useState<LiveLightningPresentation | null>(null);
  const [xweatherSummary, setXweatherSummary] = useState<LiveLightningSummary | null>(null);
  const [topLevelFailure, setTopLevelFailure] = useState(false);
  const [place, setPlace] = useState<ActivityPlaceContext | null>(null);
  const placeController = useRef<AbortController | null>(null);
  const lookupLocale = useRef(locale);
  useEffect(() => { lookupLocale.current = locale; }, [locale]);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const automaticEffectGeneration = useRef(0);
  const locationKey = `${latitude},${longitude}`;
  const locationRef = useRef(locationKey);

  useEffect(() => () => {
    requestId.current += 1;
    controller.current?.abort();
    placeController.current?.abort();
  }, []);

  useEffect(() => {
    if (!developerModeReady) return;
    let restoredSource: LiveLightningSource = "xweather";
    if (developerMode) {
      try {
        restoredSource = parseStoredLiveSource(localStorage.getItem(DEVELOPER_LIVE_SOURCE_STORAGE_KEY)) ?? "xweather";
      } catch { /* Storage can be unavailable; Xweather remains the safe default. */ }
    }
    const sourceChanged = restoredSource !== sourceRef.current;
    sourceRef.current = restoredSource;
    queueMicrotask(() => {
      if (sourceChanged) {
        setSource(restoredSource);
        setResult(null);
        setXweatherSummary(null);
        setTopLevelFailure(false);
        setPlace(null);
        setCheckedAt(null);
        setLoading(false);
      }
      setSourcePreferenceReady(true);
    });
  }, [developerMode, developerModeReady]);

  const checkActivity = useCallback(async (automaticSource?: LiveLightningSource) => {
    if (!canStartLiveSourceRequest(automaticSource, sourceRef.current)) return;
    if (controller.current && !controller.current.signal.aborted) return;
    const requestedSource = automaticSource ?? sourceRef.current;
    const active = new AbortController();
    controller.current = active;
    const id = ++requestId.current;
    const ownedBy = locationKey;
    const isCurrent = () => isCurrentSourceRequest(id, requestId.current, requestedSource,
      sourceRef.current, ownedBy, locationRef.current, active.signal);
    placeController.current?.abort();
    setPlace(null);
    setLoading(true);
    setResult(null);
    setXweatherSummary(null);
    setTopLevelFailure(false);
    setCheckedAt(null);
    try {
      const response = await fetch(liveSourceEndpoint(requestedSource), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude, longitude }), signal: active.signal, cache: "no-store",
      });
      const body: unknown = await response.json();
      if (!isCurrent()) return;
      let presentation: LiveLightningPresentation;
      if (requestedSource === "xweather") {
        const parsed = body as LiveLightningApiResult;
        if (response.ok && parsed?.ok && parsed.summary) {
          presentation = normalizeXweatherPresentation(parsed);
          setXweatherSummary(parsed.summary);
          setTopLevelFailure(false);
        } else {
          presentation = normalizeXweatherPresentation(xweatherUnavailable());
          setXweatherSummary(null);
          setTopLevelFailure(true);
        }
      } else {
        if (!isBlitzResult(body)) presentation = unavailableLivePresentation("blitz-experimental", "malformed-response");
        else if (response.ok && body.ok) presentation = normalizeBlitzPresentation(body);
        else presentation = normalizeBlitzPresentation(body.ok ? failureBlitz("provider-unavailable") : body);
        setXweatherSummary(null);
      }
      setResult(presentation);
      setCheckedAt(Date.now());
      const mapData = presentation.status === "active" ? activityMapData(presentation, latitude, longitude) : null;
      if (mapData) {
        const lookup = new AbortController();
        placeController.current = lookup;
        void lookupActivityPlace(mapData.events[0].event, lookup.signal, lookupLocale.current).then(context => {
          if (isCurrentSourceRequest(id, requestId.current, requestedSource, sourceRef.current,
            ownedBy, locationRef.current, lookup.signal)) setPlace(context);
        });
      }
    } catch {
      if (!isCurrent()) return;
      setResult(unavailableLivePresentation(requestedSource));
      setXweatherSummary(null);
      setTopLevelFailure(requestedSource === "xweather");
      setCheckedAt(Date.now());
    } finally {
      if (ownsLiveRequestController(controller.current, active)) {
        controller.current = null;
        setLoading(false);
      }
    }
  }, [latitude, longitude, locationKey]);

  useEffect(() => {
    if (!shouldRunInitialLiveSourceCheck(autoCheckEligible, developerModeReady, sourcePreferenceReady, sourceRef.current)) return;
    const generation = ++automaticEffectGeneration.current;
    queueMicrotask(() => {
      if (generation !== automaticEffectGeneration.current) return;
      if (!claimInitialLiveCheck(() => window.sessionStorage)) return;
      void requestLiveCheck("automatic", () => checkActivity("xweather"));
    });
    return () => { automaticEffectGeneration.current += 1; };
  }, [autoCheckEligible, checkActivity, developerModeReady, sourcePreferenceReady]);

  const changeSource = (next: LiveLightningSource) => {
    if (next === sourceRef.current) return;
    sourceRef.current = next;
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
    placeController.current?.abort();
    placeController.current = null;
    setSource(next);
    if (developerMode) {
      try { localStorage.setItem(DEVELOPER_LIVE_SOURCE_STORAGE_KEY, next); }
      catch { /* The current selection still works for this page load. */ }
    }
    setResult(null);
    setXweatherSummary(null);
    setTopLevelFailure(false);
    setPlace(null);
    setCheckedAt(null);
    setLoading(false);
  };

  const severity = livePresentationSeverity(result);
  const mapData = useMemo(() => activityMapData(result ?? undefined, latitude, longitude), [result, latitude, longitude]);
  const activity = liveActivityView(result ?? undefined, latitude, longitude, locale, place);
  const countRadius = result?.status === "active" && severity && severity !== "none"
    ? severity === "high" ? 10 : severity === "elevated" ? 25 : result.currentRadiusKm : null;
  const count = result?.status === "active" && countRadius
    ? countRadius === 10 ? result.counts.within10Km : countRadius === 25 ? result.counts.within25Km : result.counts.within40Km : null;
  const active = result?.status === "active";
  const clear = result?.status === "clear";
  const unavailableState = result?.status === "unavailable" || result?.status === "unknown";
  const heroClass = active && severity ? `live-${severity}` : clear ? "live-clear" : unavailableState ? "live-unavailable" : forecast ? `forecast-fallback risk-${forecast.risk}` : "forecast-fallback";
  const liveBadge = liveSeverityLabel(severity, locale);
  const checkedTime = checkedAt !== null ? new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(checkedAt) : null;

  return <section className={`current-hero ${heroClass}`} aria-labelledby="overview-title">
    <div className="current-hero-top">
      <div><p className="eyebrow">{result ? t(locale, "liveLightning") : t(locale, "currentPicture")}</p>{checkedTime && <p className="live-checked">{t(locale, "checkedTime", { time: checkedTime })}</p>}</div>
      {active && liveBadge && <span className="current-badge">{liveBadge}</span>}
    </div>
    {developerMode && sourcePreferenceReady && <label className="developer-source">{t(locale, "developerLightningSource")}
      <select value={source} onChange={event => {
        const next = parseStoredLiveSource(event.target.value);
        if (next) changeSource(next);
      }}>
        <option value="xweather">{t(locale, "developerSourceXweather")}</option>
        <option value="blitz-experimental">{t(locale, "developerSourceBlitz")}</option>
      </select>
    </label>}
    <div className="current-hero-content" aria-live="polite" aria-busy={loading}>
      {loading ? <><h1 id="overview-title">{t(locale, "checkingNearby")}</h1><p>{t(locale, "requestingObservation")}</p></>
        : !result ? <><h1 id="overview-title">{forecast?.headline ?? t(locale, "checkCurrent")}</h1><p>{forecast?.summary ?? t(locale, "runLiveCheck")}</p>{forecast?.strongestWindow && <p className="strongest-window">{t(locale, "strongestWindow")} <strong>{forecast.strongestWindow}</strong></p>}</>
          : result.status === "unavailable" ? <><h1 id="overview-title">{t(locale, topLevelFailure ? "liveUnavailable" : "currentUnavailable")}</h1><p>{xweatherSummary ? liveActivitySegments(xweatherSummary, locale).map(segment => segment.text).join("") : t(locale, "liveUnavailableBody")}</p></>
            : result.status === "unknown" ? <><h1 id="overview-title">{t(locale, "observationWindowIncomplete")}</h1><p>{t(locale, "observationWindowIncompleteBody")}</p></>
              : active ? <><h1 id="overview-title">{activity?.headline}</h1>
                {activity?.placeContext && <p className="activity-place">{activity.placeContext}</p>}
                {activity?.nearestLine && <p className="nearest-line"><span className="visually-hidden">{t(locale, "closestActivity")} </span><strong>{activity.nearestLine}</strong></p>}
                {mapData && <LiveActivityMap data={mapData} locale={locale} />}
                {count !== null && countRadius !== null && <p className="flash-count">{liveEventCountCopy(count, countRadius, locale)}</p>}
                {result.source === "xweather" && xweatherSummary
                  ? <p className="live-context">{liveActivitySegments(xweatherSummary, locale).map(segment => segment.text).join("")}</p>
                  : result.recentStatus === "active" ? <p className="live-context">{t(locale, "blitzRecentActive")}</p>
                    : result.recentStatus === "unknown" ? <p className="live-context">{t(locale, "blitzRecentUnknown")}</p> : null}
              </>
                : <><h1 id="overview-title">{t(locale, "noCurrentActivity")}</h1>
                  {result.source === "xweather" && xweatherSummary
                    ? <p>{liveActivitySegments(xweatherSummary, locale).map(segment => segment.emphasize
                      ? <span key="recent-detection" className="recent-detection">{segment.text}</span> : segment.text)}</p>
                    : <p>{t(locale, result.recentStatus === "active" ? "blitzRecentActive" : result.recentStatus === "unknown" ? "blitzRecentUnknown" : "blitzRecentClear")}</p>}
                </>}
    </div>
    <button className={`${result ? "secondary-button" : "primary-button"} live-action`} type="button" disabled={loading} onClick={() => void requestLiveCheck(checkedAt === null ? "manual-check" : "manual-refresh", checkActivity, onManualRefresh)}>{loading ? t(locale, "checking") : checkedAt ? t(locale, "refreshLive") : t(locale, "checkLive")}</button>
    {result && forecast && <aside className={`forecast-context risk-${forecast.risk}`} aria-label={t(locale, "forecastContext")}>
      <div><p className="eyebrow">{t(locale, "next24hOutlook")}</p><h2>{forecast.headline}</h2></div>
      <p>{forecast.summary}</p>
      {forecast.strongestWindow && <p className="strongest-window">{t(locale, "strongestWindow")} <strong>{forecast.strongestWindow}</strong></p>}
    </aside>}
    {checkedAt !== null && <p className="manual-note">{t(locale, "manualNote")}</p>}
  </section>;
}
