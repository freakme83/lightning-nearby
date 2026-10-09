"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "@/lib/lightning/types";
import { claimInitialLiveCheck } from "@/lib/initial-live-check";
import { isCurrentLiveRequest, liveActivityCopy, liveActivitySegments, liveEventCountCopy, liveSeverity, liveSeverityLabel, requestLiveCheck } from "@/lib/live-observation";
import { activityMapData, liveActivityView, lookupActivityPlace, type ActivityPlaceContext } from "@/lib/live-activity";
import LiveActivityMap from "./live-activity-map";
import type { RiskLevel } from "@/lib/weather";
import { intlLocale, t, type Locale } from "@/lib/i18n";

const unavailable: LiveLightningApiResult = {
  ok: false, status: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS,
};

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
}

export default function LiveObservation({ latitude, longitude, forecast, autoCheckEligible, locale, onManualRefresh }: Props) {
  const [result, setResult] = useState<LiveLightningApiResult | null>(null);
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

  const checkActivity = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    const active = new AbortController();
    controller.current = active;
    const id = ++requestId.current;
    const ownedBy = locationKey;
    placeController.current?.abort();
    setPlace(null);
    setLoading(true);
    setResult(null);
    setCheckedAt(null);
    try {
      const response = await fetch("/api/lightning/live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude, longitude }), signal: active.signal,
        cache: "no-store",
      });
      const body = await response.json() as LiveLightningApiResult;
      if (!isCurrentLiveRequest(id, requestId.current, ownedBy, locationRef.current, active.signal)) return;
      setResult(response.ok && body.ok && body.summary ? body : unavailable);
      setCheckedAt(Date.now());
      const mapData = response.ok && body.ok ? activityMapData(body.summary.current, latitude, longitude) : null;
      if (mapData) {
        const lookup = new AbortController();
        placeController.current = lookup;
        void lookupActivityPlace(mapData.events[0].event, lookup.signal, lookupLocale.current).then(context => {
          if (isCurrentLiveRequest(id, requestId.current, ownedBy, locationRef.current, lookup.signal)) setPlace(context);
        });
      }
    } catch {
      if (!isCurrentLiveRequest(id, requestId.current, ownedBy, locationRef.current, active.signal)) return;
      setResult(unavailable);
      setCheckedAt(Date.now());
    } finally {
      if (isCurrentLiveRequest(id, requestId.current, ownedBy, locationRef.current, active.signal)) {
        controller.current = null;
        setLoading(false);
      }
    }
  }, [latitude, longitude, locationKey]);

  useEffect(() => {
    if (!autoCheckEligible) return;
    const generation = ++automaticEffectGeneration.current;
    // Defer one microtask so React Strict Mode's setup/cleanup replay cancels its
    // first setup before it claims the session guard or starts the request.
    queueMicrotask(() => {
      if (generation !== automaticEffectGeneration.current) return;
      if (!claimInitialLiveCheck(() => window.sessionStorage)) return;
      void requestLiveCheck("automatic", checkActivity);
    });
    return () => { automaticEffectGeneration.current += 1; };
  }, [autoCheckEligible, checkActivity]);

  const severity = liveSeverity(result);
  const summary = result?.ok ? result.summary : null;
  const current = summary?.current;
  const mapData = useMemo(() => activityMapData(current, latitude, longitude), [current, latitude, longitude]);
  const activity = liveActivityView(current, latitude, longitude, locale, place);
  const countRadius = current?.status === "active" && severity && severity !== "none"
    ? severity === "high" ? 10 : severity === "elevated" ? 25 : 40 : null;
  const count = current?.status === "active" && countRadius
    ? countRadius === 10 ? current.counts.within10Km : countRadius === 25 ? current.counts.within25Km : current.counts.within40Km : null;
  const active = current?.status === "active";
  const clear = current?.status === "clear" || current?.status === "not-requested";
  const unavailableState = Boolean(result && (!result.ok || current?.status === "unavailable"));
  const heroClass = active && severity ? `live-${severity}` : clear ? "live-clear" : unavailableState ? "live-unavailable" : forecast ? `forecast-fallback risk-${forecast.risk}` : "forecast-fallback";
  const liveBadge = liveSeverityLabel(severity, locale);
  const checkedTime = checkedAt !== null ? new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(checkedAt) : null;

  return <section className={`current-hero ${heroClass}`} aria-labelledby="overview-title">
    <div className="current-hero-top">
      <div><p className="eyebrow">{result ? t(locale, "liveLightning") : t(locale, "currentPicture")}</p>{checkedTime && <p className="live-checked">{t(locale, "checkedTime", { time: checkedTime })}</p>}</div>
      {active && liveBadge && <span className="current-badge">{liveBadge}</span>}
    </div>
    <div className="current-hero-content" aria-live="polite" aria-busy={loading}>
      {loading ? <><h1 id="overview-title">{t(locale, "checkingNearby")}</h1><p>{t(locale, "requestingObservation")}</p></>
        : !result ? <><h1 id="overview-title">{forecast?.headline ?? t(locale, "checkCurrent")}</h1><p>{forecast?.summary ?? t(locale, "runLiveCheck")}</p>{forecast?.strongestWindow && <p className="strongest-window">{t(locale, "strongestWindow")} <strong>{forecast.strongestWindow}</strong></p>}</>
          : !summary ? <><h1 id="overview-title">{t(locale, "liveUnavailable")}</h1><p>{t(locale, "liveUnavailableBody")}</p></>
            : current?.status === "unavailable" ? <><h1 id="overview-title">{t(locale, "currentUnavailable")}</h1><p>{liveActivityCopy(summary, locale)}</p></>
              : active ? <><h1 id="overview-title">{activity?.headline}</h1>
                {activity?.placeContext && <p className="activity-place">{activity.placeContext}</p>}
                {activity?.nearestLine && <p className="nearest-line"><span className="visually-hidden">{t(locale, "closestActivity")} </span><strong>{activity.nearestLine}</strong></p>}
                {mapData && <LiveActivityMap data={mapData} locale={locale} />}
                {count !== null && countRadius !== null && <p className="flash-count">{liveEventCountCopy(count, countRadius, locale)}</p>}
                <p className="live-context">{liveActivityCopy(summary, locale)}</p>
              </>
                : <><h1 id="overview-title">{t(locale, "noCurrentActivity")}</h1><p>{liveActivitySegments(summary, locale).map(segment => segment.emphasize
                  ? <span key="recent-detection" className="recent-detection">{segment.text}</span> : segment.text)}</p></>}
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
