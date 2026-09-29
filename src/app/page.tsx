"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LOCATION_STORAGE_KEY, formatCoordinates, reduceLocationPrecision, type MonitoredLocation } from "@/lib/location";
import { calculateHighestRiskWindow, describeWeatherCode, fetchForecast, selectNext24Hours, type Forecast, type ForecastHour, type RiskLevel } from "@/lib/weather";

const RISK_LABEL: Record<RiskLevel, string> = { low: "Low", elevated: "Elevated", high: "High" };
function localTime(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(epoch * 1000); }
function localDateKey(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(epoch * 1000); }
function dayLabel(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(epoch * 1000); }
function period(start: number, end: number, timezone: string) { return `${localTime(start, timezone)}–${localTime(end, timezone)}`; }
function summaryFor(window: ReturnType<typeof calculateHighestRiskWindow>, timezone: string) {
  if (!window) return "No meaningful thunderstorm signal in the next 24 hours.";
  const range = period(window.start, window.end, timezone);
  return window.level === "high"
    ? `A thunderstorm signal appears in the forecast. The strongest period is ${range}.`
    : `Instability and precipitation overlap in the forecast. Thunderstorm risk is elevated around ${range}.`;
}
function locationErrorMessage(code?: number) {
  if (!navigator.geolocation) return "Location isn’t available in this browser. Try again in a browser that supports location.";
  if (code === 1) return "Location access was declined. Allow it in your browser or device settings, then try again.";
  if (code === 2) return "Your device couldn’t determine a location. Check location services and try again.";
  if (code === 3) return "The location request took too long. Check your signal and try again.";
  return "We couldn’t get your location. Check your device settings and try again.";
}

export default function Home() {
  const [location, setLocation] = useState<MonitoredLocation | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [hours, setHours] = useState<ForecastHour[]>([]);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [forecastError, setForecastError] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as MonitoredLocation;
        if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
          // Hydrate browser-only storage after SSR to avoid a hydration mismatch.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setLocation(parsed);
        }
      }
    } catch { /* Storage may be unavailable or contain malformed data; continue without a saved location. */ }
    finally { setStorageReady(true); }
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!storageReady || !location) return;
    const controller = new AbortController();
    // Clear prior results as this effect synchronizes to a different saved location.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setForecastError(false); setForecast(null); setHours([]); setSelectedTime(null);
    void fetchForecast(location.latitude, location.longitude, controller.signal)
      .then((result) => {
        const nextHours = selectNext24Hours(result.hours);
        if (nextHours.length < 24) throw new Error("forecast-incomplete");
        setForecast(result); setHours(nextHours); setSelectedTime(nextHours[0]?.time ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setForecastError(true);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [location, storageReady]);

  const requestLocation = useCallback(() => {
    setLocationMessage("");
    if (!navigator.geolocation) { setLocationMessage("Location isn’t available in this browser. Try again in a browser that supports location."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      const reduced = reduceLocationPrecision(coords.latitude, coords.longitude);
      const saved = { ...reduced, savedAt: Date.now() };
      try { localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(saved)); setLocation(saved); }
      catch { setLocationMessage("This browser couldn’t save your location on this device. Check its storage settings and try again."); }
      setLocating(false);
    }, (error) => { setLocationMessage(locationErrorMessage(error.code)); setLocating(false); },
    { enableHighAccuracy: false, maximumAge: 300_000, timeout: 15_000 });
  }, []);

  const highestWindow = useMemo(() => calculateHighestRiskWindow(hours), [hours]);
  const overallRisk = hours.reduce<RiskLevel>((risk, hour) => {
    const rank: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };
    return rank[hour.risk] > rank[risk] ? hour.risk : risk;
  }, "low");
  const selected = hours.find((hour) => hour.time === selectedTime) ?? hours[0];

  if (!storageReady) return <main className="page-shell"><div className="loading-state" role="status">Opening your local forecast…</div></main>;

  return <main className="page-shell">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Lightning Nearby home"><span className="brand-mark" aria-hidden="true">↯</span><span>LIGHTNING <b>NEARBY</b></span></Link>
      <span className="edition">LOCAL OUTLOOK <span aria-hidden="true">·</span> 24H</span>
    </header>

    {!location ? <section className="welcome-panel" aria-labelledby="welcome-title">
      <p className="eyebrow">A clearer view of the hours ahead</p>
      <h1 id="welcome-title">Thunderstorm outlook,<br /><em>where you are.</em></h1>
      <p className="welcome-copy">Share your location to see the next 24 hours of forecast conditions. Your location stays on this device and is sent only to Open‑Meteo to request the forecast.</p>
      <button className="primary-button" type="button" onClick={requestLocation} disabled={locating}><span aria-hidden="true">⌖</span>{locating ? "Finding location…" : "Use my location"}</button>
      {locationMessage && <p className="inline-error" role="alert">{locationMessage}</p>}
      <p className="permission-note">Your browser will ask before sharing. Nothing is requested until you tap above.</p>
      <div className="welcome-rule" /><p className="micro-copy">Forecast guidance only. This is not an official weather warning.</p>
    </section> : <section className="overview" aria-labelledby="overview-title">
      <div className="location-line"><div><p className="eyebrow">MONITORED LOCATION</p><p className="coordinates">{formatCoordinates(location.latitude, location.longitude)}</p></div>
        <button className="text-button" type="button" onClick={requestLocation} disabled={locating}>{locating ? "Locating…" : "Update location"}</button></div>
      {locationMessage && <p className="inline-error" role="alert">{locationMessage}</p>}
      {loading && <div className="loading-state" role="status">Getting the latest forecast…</div>}
      {forecastError && !loading && <div className="error-panel" role="alert"><div><strong>Forecast unavailable</strong><p>We couldn’t reach Open‑Meteo. Check your connection and try again. No old forecast is shown as current.</p></div><button className="secondary-button" type="button" onClick={() => setLocation({ ...location })}>Try again</button></div>}
      {forecast && !loading && <>
        <div className={`risk-overview risk-${overallRisk}`}>
          <div className="risk-heading"><span className="risk-orb" aria-hidden="true"><span /></span><div><p className="eyebrow">NEXT 24 HOURS · {forecast.timezone}</p><h1 id="overview-title">{RISK_LABEL[overallRisk]} <span>signal</span></h1></div></div>
          <p className="summary">{summaryFor(highestWindow, forecast.timezone)}</p>
          {highestWindow && <div className="peak-line"><span className="peak-spark" aria-hidden="true">✳</span><span>Highest signal <strong>{period(highestWindow.start, highestWindow.end, forecast.timezone)}</strong></span></div>}
        </div>
        <section className="timeline-section" aria-labelledby="timeline-title">
          <div className="section-heading"><div><p className="eyebrow">THE HOURS AHEAD</p><h2 id="timeline-title">Hourly outlook</h2></div><span className="timezone-label">Local time</span></div>
          <p className="timeline-instruction">Tap an hour to see its forecast values.</p>
          <div className="timeline-scroll" role="group" aria-label="Hourly thunderstorm outlook; scroll horizontally"><ol className="timeline">
            {hours.map((hour, index) => {
              const previous = hours[index - 1];
              const showDate = index === 0 || !previous || localDateKey(previous.time, forecast.timezone) !== localDateKey(hour.time, forecast.timezone);
              const isSelected = selectedTime === hour.time;
              return <li key={hour.time} className={`hour-slot ${isSelected ? "is-selected" : ""}`}>
                {showDate && <span className="day-label">{dayLabel(hour.time, forecast.timezone)}</span>}
                <button type="button" className={`hour-button risk-${hour.risk}`} aria-pressed={isSelected} aria-label={`${localTime(hour.time, forecast.timezone)}, ${RISK_LABEL[hour.risk]} thunderstorm signal`} onClick={() => setSelectedTime(hour.time)}>
                  <span className="hour-time">{localTime(hour.time, forecast.timezone).slice(0, 2)}</span><span className="risk-bar" aria-hidden="true"><span /></span><span className="hour-risk">{RISK_LABEL[hour.risk]}</span>
                </button>
              </li>;
            })}
          </ol></div>
          <div className="legend" aria-label="Risk level legend"><span><i className="legend-dot low" />Low</span><span><i className="legend-dot elevated" />Elevated</span><span><i className="legend-dot high" />High</span><span className="derived-label">Derived outlook</span></div>
        </section>
        {selected && <section className="details-section" aria-live="polite" aria-labelledby="details-title">
          <div className="details-top"><div><p className="eyebrow">SELECTED HOUR</p><h2 id="details-title">{dayLabel(selected.time, forecast.timezone)} · {localTime(selected.time, forecast.timezone)}</h2></div><span className={`small-risk risk-${selected.risk}`}>{RISK_LABEL[selected.risk]}</span></div>
          <p className="details-note">Open‑Meteo forecast values</p>
          <dl className="forecast-values">
            <div><dt>Weather</dt><dd>{describeWeatherCode(selected.weatherCode)}</dd></div>
            <div><dt>Thunderstorm probability</dt><dd>{selected.thunderstormProbability == null ? "Not available for this forecast" : `${Math.round(selected.thunderstormProbability)}% · provider value`}</dd></div>
            <div><dt>Precipitation chance</dt><dd>{selected.precipitationProbability == null ? "Not available" : `${Math.round(selected.precipitationProbability)}%`}</dd></div>
            <div><dt>CAPE</dt><dd>{selected.cape == null ? "Not available" : `${Math.round(selected.cape)} J/kg`}</dd></div>
            <div><dt>Convective inhibition</dt><dd>{selected.convectiveInhibition == null ? "Not available" : `${Math.round(selected.convectiveInhibition)} J/kg`}</dd></div>
          </dl>
          <p className="classification-note">Low / Elevated / High is our qualitative interpretation of available forecast fields. It is not an official warning or a probability.</p>
        </section>}
        <div className="update-line">Forecast updated {new Intl.DateTimeFormat("en-GB", { timeZone: forecast.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(forecast.fetchedAt)} local time</div>
      </>}
    </section>}

    <footer className="disclaimer"><span className="disclaimer-mark" aria-hidden="true">i</span><p><strong>Forecast guidance, not an official warning.</strong> Forecasts can change and may miss local conditions. Follow your local meteorological and emergency authorities for safety advice.</p></footer>
    <div className="footer-meta"><span>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open‑Meteo</a></span><span>Location stays on this device</span></div>
  </main>;
}
