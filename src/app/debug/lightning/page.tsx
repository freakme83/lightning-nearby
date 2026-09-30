"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { isValidCoordinates, LOCATION_STORAGE_KEY, parseMonitoredLocation } from "@/lib/location";
import type { LiveLightningApiResult, ProviderDiagnostics } from "@/lib/lightning/types";
import styles from "./debug.module.css";

type Coordinates = { latitude: number; longitude: number };

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "None in the available window";
  return new Date(timestamp).toLocaleString();
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "None" : value.toFixed(digits);
}

function diagnosticsRows(diagnostics: ProviderDiagnostics) {
  return [
    ["Upstream HTTP status", diagnostics.httpStatus],
    ["X-Cost-Tokens", diagnostics.costTokens],
    ["X-Cost-Multiplier(s)", diagnostics.costMultiplier],
    ["Remaining this minute", diagnostics.remainingMinute],
    ["Remaining this period", diagnostics.remainingPeriod],
  ] as const;
}

export default function LightningDebugPage() {
  const [latitudeText, setLatitudeText] = useState("");
  const [longitudeText, setLongitudeText] = useState("");
  const [savedCoordinates, setSavedCoordinates] = useState<Coordinates | null>(null);
  const [validationError, setValidationError] = useState("");
  const [result, setResult] = useState<LiveLightningApiResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (!stored) return;
      const location = parseMonitoredLocation(JSON.parse(stored));
      if (location) {
        // Load saved coordinates only after mount; never request without an explicit click.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSavedCoordinates({ latitude: location.latitude, longitude: location.longitude });
        setLatitudeText(String(location.latitude));
        setLongitudeText(String(location.longitude));
      }
    } catch { /* Manual coordinates remain available if local storage is unavailable. */ }
  }, []);

  async function loadActivity(coordinates: Coordinates) {
    setLoading(true);
    setResult(null);
    setValidationError("");
    try {
      const response = await fetch("/api/lightning/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(coordinates),
      });
      const payload = await response.json() as LiveLightningApiResult;
      setResult(payload);
    } catch {
      setResult({ ok: false, status: "provider-unavailable", message: "The app could not reach its lightning endpoint.", diagnostics: { httpStatus: null, costTokens: null, costMultiplier: null, remainingMinute: null, remainingPeriod: null } });
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!latitudeText.trim() || !longitudeText.trim() || !isValidCoordinates(latitude, longitude)) {
      setValidationError("Enter a latitude from -90 to 90 and a longitude from -180 to 180.");
      setResult(null);
      return;
    }
    void loadActivity({ latitude, longitude });
  }

  const diagnostics = result?.ok ? result.summary.diagnostics : result?.diagnostics;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>DEVELOPER TOOL · MANUAL REQUESTS ONLY</p>
          <h1>Live lightning test</h1>
          <p>Recent detected lightning events from Xweather. This is an observation test, separate from the forecast.</p>
        </div>
        <nav className={styles.navigation} aria-label="Page navigation">
          <Link href="/">Back to app</Link>
          <Link href="/debug/forecast">Forecast debug</Link>
        </nav>
      </header>

      <section className={styles.panel} aria-labelledby="coordinates-heading">
        <h2 id="coordinates-heading">Monitored point</h2>
        <form className={styles.coordinateForm} onSubmit={submit}>
          <label>Latitude
            <input inputMode="decimal" value={latitudeText} onChange={(event) => setLatitudeText(event.target.value)} placeholder="e.g. 39.93" />
          </label>
          <label>Longitude
            <input inputMode="decimal" value={longitudeText} onChange={(event) => setLongitudeText(event.target.value)} placeholder="e.g. 32.86" />
          </label>
          <button type="submit" disabled={loading}>{loading ? "Loading…" : "Load / refresh"}</button>
          {savedCoordinates && <button className={styles.secondaryButton} type="button" disabled={loading} onClick={() => {
            setLatitudeText(String(savedCoordinates.latitude));
            setLongitudeText(String(savedCoordinates.longitude));
            void loadActivity(savedCoordinates);
          }}>Use saved location</button>}
        </form>
        {validationError && <p className={styles.error} role="alert">{validationError}</p>}
        <p className={styles.note}>Each click makes one request for events from the latest five minutes, within 50 km. Nothing refreshes automatically.</p>
      </section>

      {loading && <p className={styles.status} role="status">Requesting current observation data…</p>}

      {result && !result.ok && <section className={styles.panel} aria-live="polite">
        <h2>Data unavailable</h2>
        <p className={styles.error}><strong>{result.status}</strong> · {result.message}</p>
        <p className={styles.note}>A failed request is not treated as zero lightning activity.</p>
      </section>}

      {result?.ok && <section className={styles.panel} aria-live="polite">
        <h2>Observation summary</h2>
        <dl className={styles.grid}>
          <div><dt>Status</dt><dd>{result.summary.status}</dd></div>
          <div><dt>Provider</dt><dd>{result.summary.provider}</dd></div>
          <div><dt>Fetched at</dt><dd>{formatDate(result.summary.fetchedAt)}</dd></div>
          <div><dt>Source window</dt><dd>{result.summary.observationWindowMinutes} minutes</dd></div>
          <div><dt>Latest event</dt><dd>{formatDate(result.summary.latestEventAt)}</dd></div>
          <div><dt>Nearest event</dt><dd>{formatNumber(result.summary.nearestKm)} km</dd></div>
          <div><dt>Nearest event age</dt><dd>{formatNumber(result.summary.nearestAgeMinutes, 2)} min</dd></div>
          <div><dt>Returned events within 50 km</dt><dd>{result.summary.totalEvents}</dd></div>
          <div><dt>Within 5 km</dt><dd>{result.summary.counts.within5Km}</dd></div>
          <div><dt>Within 10 km</dt><dd>{result.summary.counts.within10Km}</dd></div>
          <div><dt>Within 25 km</dt><dd>{result.summary.counts.within25Km}</dd></div>
          <div><dt>Within 50 km</dt><dd>{result.summary.counts.within50Km}</dd></div>
          <div><dt>Malformed event records skipped</dt><dd>{result.summary.rejectedEventCount}</dd></div>
        </dl>
        {result.summary.mayBeTruncated && <p className={styles.error} role="status">Xweather returned the 1,000-record limit. Counts may be incomplete for this five-minute window.</p>}
        <p className={styles.note}>Counts are provider event records, including intracloud pulses and cloud-to-ground strikes; they are not counts of storms.</p>
      </section>}

      {diagnostics && <section className={styles.panel}>
        <h2>Request diagnostics</h2>
        <dl className={styles.grid}>
          {diagnosticsRows(diagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
        </dl>
      </section>}

      <footer className={styles.footer}>
        <a href="https://www.xweather.com/" target="_blank" rel="noreferrer">Powered by Vaisala Xweather</a>
        <span>Private spike · Not a warning service</span>
      </footer>
    </main>
  );
}
