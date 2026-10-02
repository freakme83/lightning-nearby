"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompassDirection } from "@/lib/lightning/bearing";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "@/lib/lightning/types";
import { claimInitialLiveCheck } from "@/lib/initial-live-check";
import { isCurrentLiveRequest, liveActivityCopy, liveEventCountCopy, liveSeverity, liveSeverityLabel } from "@/lib/live-observation";
import { DEFAULT_PROXIMITY_SCALE, proximityColor, proximityPoint, proximityScale } from "@/lib/proximity";
import type { RiskLevel } from "@/lib/weather";
import { directionLabel, formatDistance, intlLocale, t, type Locale } from "@/lib/i18n";

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
}

function ProximityGraphic({ distanceKm, direction, clear, locale }: { locale: Locale; distanceKm?: number | null; direction?: CompassDirection | null; clear?: boolean }) {
  const scale = distanceKm != null && Number.isFinite(distanceKm) && distanceKm >= 0
    ? proximityScale(distanceKm) : DEFAULT_PROXIMITY_SCALE;
  const point = distanceKm != null && direction ? proximityPoint(distanceKm, direction, scale.outerKm) : null;
  const directionText = direction ? directionLabel(locale, direction) : null;
  const scaleLabel = t(locale, "scale", { distance: scale.outerKm });
  const description = [t(locale, "scaleAccessible", { distance: scale.outerKm }),
    point && distanceKm != null && directionText ? t(locale, "proximityClosest", { distance: formatDistance(distanceKm, locale), direction: directionText }) : clear ? t(locale, "proximityClear") : "",
    t(locale, "schematicAccessible")].filter(Boolean).join(" ");
  const ringRadius = (distance: number) => distance / scale.outerKm * 42;
  const ringLabelY = (distance: number) => distance === scale.outerKm ? 12 : 50 - ringRadius(distance) - 2;
  const [innerKm, middleKm, outerKm] = scale.ringsKm;
  const color = distanceKm != null && Number.isFinite(distanceKm) ? proximityColor(distanceKm) : null;

  return <figure className={`proximity ${clear ? "is-clear" : ""}`} aria-label={description}>
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle className="proximity-fill" cx="50" cy="50" r="42" />
      {[outerKm, middleKm, innerKm].map((range) => <circle key={range} className="proximity-ring" cx="50" cy="50" r={ringRadius(range)} />)}
      {[outerKm, middleKm, innerKm].map((range) => <text key={range} className="proximity-range" x="50" y={ringLabelY(range)}>{range} km</text>)}
      <text className="proximity-north" x="50" y="3">{t(locale, "northInitial")}</text>
      {point && color && <g className={`proximity-flash proximity-flash-${color}`} transform={`translate(${point.x} ${point.y})`}>
        <circle className="proximity-flash-halo" r="2.5" />
        <circle className="proximity-flash-marker" r="1.8" />
        <path className="proximity-flash-glyph" d="M1.2 -4.2 -2.2 .3 .2 .3 -1.1 4.2 3 -1 0.7 -1Z" transform="scale(.25)" />
      </g>}
      <circle className="proximity-center-halo" cx="50" cy="50" r="3.5" />
      <circle className="proximity-center" cx="50" cy="50" r="2" />
    </svg>
    <figcaption>{[scaleLabel,
      point && distanceKm != null && directionText ? t(locale, "closestShort", { distance: formatDistance(distanceKm, locale), direction: directionText }) : clear ? t(locale, "noCurrentShort") : "",
      t(locale, "schematic")].filter(Boolean).join(" · ")}</figcaption>
  </figure>;
}

export default function LiveObservation({ latitude, longitude, forecast, autoCheckEligible, locale }: Props) {
  const [result, setResult] = useState<LiveLightningApiResult | null>(null);
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
  }, []);

  const checkActivity = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    const active = new AbortController();
    controller.current = active;
    const id = ++requestId.current;
    const ownedBy = locationKey;
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
      void checkActivity();
    });
    return () => { automaticEffectGeneration.current += 1; };
  }, [autoCheckEligible, checkActivity]);

  const severity = liveSeverity(result);
  const summary = result?.ok ? result.summary : null;
  const current = summary?.current;
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
              : active ? <><h1 id="overview-title">{t(locale, "lightningNearby")}</h1>
                {current.nearestKm !== null && <p className="nearest-line">{t(locale, "closestActivity")} <strong>{formatDistance(current.nearestKm, locale)} km{current.nearestDirection ? ` ${directionLabel(locale, current.nearestDirection)}` : ""}{current.nearestAgeMinutes !== null ? ` · ${t(locale, "ageMinutes", { age: Math.max(0, Math.round(current.nearestAgeMinutes)) })}` : ""}</strong></p>}
                {count !== null && countRadius !== null && <p className="flash-count">{liveEventCountCopy(count, countRadius, locale)}</p>}
                <p className="live-context">{liveActivityCopy(summary, locale)}</p>
              </>
                : <><h1 id="overview-title">{t(locale, "noCurrentActivity")}</h1><p>{liveActivityCopy(summary, locale)}</p></>}
    </div>
    <button className={`${result ? "secondary-button" : "primary-button"} live-action`} type="button" disabled={loading} onClick={() => void checkActivity()}>{loading ? t(locale, "checking") : checkedAt ? t(locale, "refreshLive") : t(locale, "checkLive")}</button>
    {!loading && active && <ProximityGraphic locale={locale} distanceKm={current.nearestKm} direction={current.nearestDirection} />}
    {!loading && clear && <ProximityGraphic locale={locale} clear />}
    {result && forecast && <aside className={`forecast-context risk-${forecast.risk}`} aria-label={t(locale, "forecastContext")}>
      <div><p className="eyebrow">{t(locale, "next24hOutlook")}</p><h2>{forecast.headline}</h2></div>
      <p>{forecast.summary}</p>
      {forecast.strongestWindow && <p className="strongest-window">{t(locale, "strongestWindow")} <strong>{forecast.strongestWindow}</strong></p>}
    </aside>}
    {checkedAt !== null && <p className="manual-note">{t(locale, "manualNote")}</p>}
  </section>;
}
