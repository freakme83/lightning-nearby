"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompassDirection } from "@/lib/lightning/bearing";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "@/lib/lightning/types";
import { claimInitialLiveCheck } from "@/lib/initial-live-check";
import { isCurrentLiveRequest, liveActivityCopy, liveEventCountCopy, liveSeverity, liveSeverityLabel } from "@/lib/live-observation";
import { proximityPoint } from "@/lib/proximity";
import type { RiskLevel } from "@/lib/weather";

const DIRECTION: Record<CompassDirection, string> = {
  N: "north", NE: "northeast", E: "east", SE: "southeast",
  S: "south", SW: "southwest", W: "west", NW: "northwest",
};
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
}

function ProximityGraphic({ distanceKm, direction, clear }: { distanceKm?: number | null; direction?: CompassDirection | null; clear?: boolean }) {
  const point = distanceKm != null && direction ? proximityPoint(distanceKm, direction) : null;
  const directionLabel = direction ? DIRECTION[direction] : null;
  const description = point && distanceKm != null && directionLabel
    ? `Closest lightning activity is ${distanceKm.toFixed(1)} kilometres ${directionLabel}. Schematic proximity, not a map.`
    : clear
      ? "No current lightning activity detected within 40 kilometres. Schematic proximity, not a map."
      : "Schematic proximity, not a map.";

  return <figure className={`proximity ${clear ? "is-clear" : ""}`} aria-label={description}>
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle className="proximity-fill" cx="50" cy="50" r="42" />
      <circle className="proximity-ring" cx="50" cy="50" r="42" />
      <circle className="proximity-ring" cx="50" cy="50" r="26.25" />
      <circle className="proximity-ring" cx="50" cy="50" r="10.5" />
      <text className="proximity-range range-40" x="50" y="13">40 km</text>
      <text className="proximity-range range-25" x="50" y="21.5">25 km</text>
      <text className="proximity-range range-10" x="50" y="37.5">10 km</text>
      <text className="proximity-north" x="50" y="3">N</text>
      {point && <g className="proximity-flash" transform={`translate(${point.x} ${point.y})`}>
        <circle className="proximity-flash-halo" r="3.1" />
        <circle className="proximity-flash-marker" r="2.4" />
      </g>}
      <circle className="proximity-center-halo" cx="50" cy="50" r="4" />
      <circle className="proximity-center" cx="50" cy="50" r="2.2" />
      {point && <path className="proximity-flash-glyph" d="M1.2 -4.2 -2.2 .3 .2 .3 -1.1 4.2 3 -1 0.7 -1Z" transform={`translate(${point.x} ${point.y}) scale(.38)`} />}
    </svg>
    <figcaption>{point && distanceKm != null && directionLabel ? `${distanceKm.toFixed(1)} km ${directionLabel} · ` : ""}Schematic proximity · not a map</figcaption>
  </figure>;
}

export default function LiveObservation({ latitude, longitude, forecast, autoCheckEligible }: Props) {
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
  const liveBadge = liveSeverityLabel(severity);
  const checkedTime = checkedAt !== null ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(checkedAt) : null;

  return <section className={`current-hero ${heroClass}`} aria-labelledby="overview-title">
    <div className="current-hero-top">
      <div><p className="eyebrow">{result ? "LIVE LIGHTNING" : "CURRENT PICTURE"}</p>{checkedTime && <p className="live-checked">Checked {checkedTime} local time</p>}</div>
      {active && liveBadge && <span className="current-badge">{liveBadge}</span>}
    </div>
    <div className="current-hero-content" aria-live="polite" aria-busy={loading}>
      {loading ? <><h1 id="overview-title">Checking nearby lightning…</h1><p>Requesting the latest lightning observation for this location.</p></>
        : !result ? <><h1 id="overview-title">{forecast?.headline ?? "Check current lightning nearby"}</h1><p>{forecast?.summary ?? "Run a live check to see whether lightning is currently detected nearby."}</p>{forecast?.strongestWindow && <p className="strongest-window">Strongest window <strong>{forecast.strongestWindow}</strong></p>}</>
          : !summary ? <><h1 id="overview-title">Live lightning unavailable</h1><p>The current observation could not be completed. Try again when you’re ready.</p></>
            : current?.status === "unavailable" ? <><h1 id="overview-title">Current lightning unavailable</h1><p>{liveActivityCopy(summary)}</p></>
              : active ? <><h1 id="overview-title">Lightning activity nearby</h1>
                {current.nearestKm !== null && <p className="nearest-line">Closest activity: <strong>{current.nearestKm.toFixed(1)} km{current.nearestDirection ? ` ${DIRECTION[current.nearestDirection]}` : ""}{current.nearestAgeMinutes !== null ? ` · ${Math.max(0, Math.round(current.nearestAgeMinutes))} min ago` : ""}</strong></p>}
                {count !== null && countRadius !== null && <p className="flash-count">{liveEventCountCopy(count, countRadius)}</p>}
                <p className="live-context">{liveActivityCopy(summary)}</p>
              </>
                : <><h1 id="overview-title">No current lightning activity detected within 40 km</h1><p>{liveActivityCopy(summary)}</p></>}
    </div>
    <button className={`${result ? "secondary-button" : "primary-button"} live-action`} type="button" disabled={loading} onClick={() => void checkActivity()}>{loading ? "Checking…" : checkedAt ? "Refresh live activity" : "Check live activity"}</button>
    {!loading && active && <ProximityGraphic distanceKm={current.nearestKm} direction={current.nearestDirection} />}
    {!loading && clear && <ProximityGraphic clear />}
    {result && forecast && <aside className={`forecast-context risk-${forecast.risk}`} aria-label="Next 24 hour forecast context">
      <div><p className="eyebrow">NEXT 24H OUTLOOK</p><h2>{forecast.headline}</h2></div>
      <p>{forecast.summary}</p>
      {forecast.strongestWindow && <p className="strongest-window">Strongest window <strong>{forecast.strongestWindow}</strong></p>}
    </aside>}
    {checkedAt !== null && <p className="manual-note">Live check · refresh for a new observation</p>}
  </section>;
}
