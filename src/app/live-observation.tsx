"use client";

import { useEffect, useRef, useState } from "react";
import type { OutlookHour } from "@/lib/outlook";
import type { CompassDirection } from "@/lib/lightning/bearing";
import { EMPTY_PROVIDER_DIAGNOSTICS, type LiveLightningApiResult } from "@/lib/lightning/types";
import { currentSeverity, isCurrentLiveRequest, liveActivityCopy, liveSeverity } from "@/lib/live-observation";

const DIRECTION: Record<CompassDirection, string> = {
  N: "north", NE: "northeast", E: "east", SE: "southeast",
  S: "south", SW: "southwest", W: "west", NW: "northwest",
};
const unavailable: LiveLightningApiResult = {
  ok: false, status: "provider-unavailable", message: "Unavailable", diagnostics: EMPTY_PROVIDER_DIAGNOSTICS,
};

interface Props { latitude: number; longitude: number; forecastHours: readonly Pick<OutlookHour, "time" | "signal">[] }

export default function LiveObservation({ latitude, longitude, forecastHours }: Props) {
  const [result, setResult] = useState<LiveLightningApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const locationKey = `${latitude},${longitude}`;
  const locationRef = useRef(locationKey);

  useEffect(() => () => {
    requestId.current += 1;
    controller.current?.abort();
  }, []);

  async function checkActivity() {
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
  }

  const severity = liveSeverity(result);
  const currentHour = forecastHours.find((hour) => checkedAt !== null && hour.time === Math.floor(checkedAt / 3_600_000) * 3_600);
  const forecastRisk = currentHour?.signal.kind === "qualitative" ? currentHour.signal.risk : null;
  const combined = result?.ok && result.summary.current.status !== "unavailable" ? currentSeverity(forecastRisk, severity) : null;
  const summary = result?.ok ? result.summary : null;
  const current = summary?.current;
  const countRadius = current?.status === "active" && severity && severity !== "none"
    ? severity === "high" ? 10 : severity === "elevated" ? 25 : 40 : null;
  const count = current?.status === "active" && countRadius
    ? countRadius === 10 ? current.counts.within10Km : countRadius === 25 ? current.counts.within25Km : current.counts.within40Km : null;

  return <section className={`live-card ${severity && severity !== "none" ? `live-${severity}` : ""}`} aria-labelledby="live-title">
    <div className="live-heading"><div><p className="eyebrow">LIVE LIGHTNING</p><h2 id="live-title">Nearby lightning</h2></div>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void checkActivity()}>{loading ? "Checking…" : checkedAt ? "Refresh live activity" : "Check live activity"}</button></div>
    <div className="live-content" aria-live="polite" aria-busy={loading}>
      {loading ? <p>Checking nearby lightning activity…</p>
        : !result ? <p>Check recent detections around your monitored location.</p>
          : !summary ? <p>Live lightning data is temporarily unavailable. Try again when you’re ready.</p>
            : <>
              <p className="live-message">{liveActivityCopy(summary)}</p>
              {current?.status === "active" && current.nearestKm !== null && <p>Nearest detection: {current.nearestKm.toFixed(1)} km{current.nearestDirection ? ` ${DIRECTION[current.nearestDirection]}` : ""}{current.nearestAgeMinutes !== null ? ` · ${Math.max(0, Math.round(current.nearestAgeMinutes))} min ago` : ""}</p>}
              {count !== null && <p>{count} {count === 1 ? "flash" : "flashes"} within {countRadius} km in the last 5 min</p>}
              {summary.recentArea.totalDetections > 0 && <p className="live-context">{summary.recentArea.totalDetections} {summary.recentArea.totalDetections === 1 ? "detection" : "detections"} within 50 km in the last 30 min</p>}
              {combined && <p className="current-picture">Current picture: <strong>{combined === "nearby" ? "Nearby activity" : combined[0].toUpperCase() + combined.slice(1)}</strong><span> · this hour’s forecast and last live check</span></p>}
            </>}
    </div>
    {checkedAt !== null && <p className="live-checked">Checked at {new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(checkedAt)} local time · refresh manually for a new check</p>}
  </section>;
}
