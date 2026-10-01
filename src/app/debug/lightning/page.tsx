"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { isValidCoordinates, LOCATION_STORAGE_KEY, parseMonitoredLocation } from "@/lib/location";
import type { LiveLightningApiResult, ProviderDiagnostics } from "@/lib/lightning/types";
import type { ComparableLightningResult, RawFlashComparisonApiResult } from "@/lib/lightning/xweather-flash-comparison";
import type { XweatherResearchMode, XweatherResearchResult } from "@/lib/lightning/xweather-research";
import styles from "./debug.module.css";

type Coordinates = { latitude: number; longitude: number };

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "None in the available window";
  return new Date(timestamp).toLocaleString();
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "None" : value.toFixed(digits);
}

function formatAge(value: number | null): string {
  return value === null ? "None" : `${value.toFixed(2)} min`;
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

function ComparisonSide({ title, result }: { title: string; result: ComparableLightningResult }) {
  if (!result.ok) return <div className={styles.comparisonSide}>
    <h3>{title}</h3>
    <p className={styles.error}><strong>{result.status}</strong> · {result.message}</p>
    <dl className={styles.grid}>
      <div><dt>Endpoint</dt><dd>{result.endpoint}</dd></div>
      <div><dt>Successful</dt><dd>no</dd></div>
      {diagnosticsRows(result.diagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
    </dl>
  </div>;
  return <div className={styles.comparisonSide}>
    <h3>{title}</h3>
    <dl className={styles.grid}>
      <div><dt>Endpoint</dt><dd>{result.endpoint}</dd></div>
      <div><dt>Data kind</dt><dd>{result.kind}</dd></div>
      <div><dt>Successful</dt><dd>yes</dd></div>
      <div><dt>Activity present</dt><dd>{result.activityPresent ? "yes" : "no"}</dd></div>
      <div><dt>Returned count</dt><dd>{result.returnedCount}</dd></div>
      <div><dt>Nearest distance</dt><dd>{formatNumber(result.nearestKm)} km</dd></div>
      <div><dt>Nearest direction</dt><dd>{result.nearestDirection ?? "None"}</dd></div>
      <div><dt>Nearest age</dt><dd>{formatAge(result.nearestAgeMinutes)}</dd></div>
      <div><dt>Newest age</dt><dd>{formatAge(result.newestAgeMinutes)}</dd></div>
      <div><dt>Oldest age</dt><dd>{formatAge(result.oldestAgeMinutes)}</dd></div>
      <div><dt>Within 5 km</dt><dd>{result.counts.within5Km}</dd></div>
      <div><dt>Within 10 km</dt><dd>{result.counts.within10Km}</dd></div>
      <div><dt>Within 25 km</dt><dd>{result.counts.within25Km}</dd></div>
      <div><dt>Within 40 km</dt><dd>{result.counts.within40Km}</dd></div>
      <div><dt>Rejected records</dt><dd>{result.rejectedEventCount}</dd></div>
      <div><dt>At provider limit</dt><dd>{result.mayBeTruncated ? "yes — may be truncated" : "no"}</dd></div>
      {diagnosticsRows(result.diagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
    </dl>
  </div>;
}

export default function LightningDebugPage() {
  const [latitudeText, setLatitudeText] = useState("");
  const [longitudeText, setLongitudeText] = useState("");
  const [savedCoordinates, setSavedCoordinates] = useState<Coordinates | null>(null);
  const [validationError, setValidationError] = useState("");
  const [result, setResult] = useState<LiveLightningApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [researchMode, setResearchMode] = useState<XweatherResearchMode>("summary-default");
  const [researchResult, setResearchResult] = useState<XweatherResearchResult | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [comparisonResult, setComparisonResult] = useState<RawFlashComparisonApiResult | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

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

  async function submitResearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!latitudeText.trim() || !longitudeText.trim() || !isValidCoordinates(latitude, longitude)) {
      setValidationError("Enter a latitude from -90 to 90 and a longitude from -180 to 180.");
      setResearchResult(null);
      return;
    }
    setResearchLoading(true);
    setResearchResult(null);
    setValidationError("");
    try {
      const response = await fetch("/api/lightning/debug-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ latitude, longitude, mode: researchMode }),
      });
      setResearchResult(await response.json() as XweatherResearchResult);
    } catch {
      setResearchResult({ ok: false, mode: researchMode, status: "provider-unavailable", message: "The app could not reach its research endpoint.", providerCode: null, diagnostics: { httpStatus: null, costTokens: null, costMultiplier: null, remainingMinute: null, remainingPeriod: null } });
    } finally {
      setResearchLoading(false);
    }
  }

  async function submitComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!latitudeText.trim() || !longitudeText.trim() || !isValidCoordinates(latitude, longitude)) {
      setValidationError("Enter a latitude from -90 to 90 and a longitude from -180 to 180.");
      setComparisonResult(null);
      return;
    }
    setComparisonLoading(true);
    setComparisonResult(null);
    setCopyStatus("");
    setValidationError("");
    try {
      const response = await fetch("/api/lightning/debug-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ latitude, longitude }),
      });
      setComparisonResult(await response.json() as RawFlashComparisonApiResult);
    } catch {
      setComparisonResult({ ok: false, status: "provider-unavailable", message: "The app could not reach its comparison endpoint." });
    } finally {
      setComparisonLoading(false);
    }
  }

  async function copyComparisonJson() {
    if (!comparisonResult?.ok) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(comparisonResult.comparison, null, 2));
      setCopyStatus("Copied comparison JSON.");
    } catch { setCopyStatus("Copy failed; select the JSON block manually."); }
  }

  const summaryDiagnostics = result?.ok ? result.summary.recentArea.diagnostics : result?.diagnostics;
  const currentDiagnostics = result?.ok && result.summary.current.status !== "not-requested"
    ? result.summary.current.diagnostics
    : null;

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
        <p className={styles.note}>Each click makes one 30-minute / 50 km Summary request, then one 5-minute / 40 km Flash request only when Summary is positive. Nothing refreshes automatically.</p>
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
          <div><dt>Recent-area status</dt><dd>{result.summary.recentArea.status}</dd></div>
          <div><dt>Recent-area window / radius</dt><dd>{result.summary.recentArea.windowMinutes} min / {result.summary.recentArea.radiusKm} km</dd></div>
          <div><dt>Summary detections</dt><dd>{result.summary.recentArea.totalDetections}</dd></div>
          <div><dt>Oldest Summary activity</dt><dd>{formatDate(result.summary.recentArea.oldestEventAt)}</dd></div>
          <div><dt>Newest Summary activity</dt><dd>{formatDate(result.summary.recentArea.newestEventAt)}</dd></div>
          <div><dt>Current Flash status</dt><dd>{result.summary.current.status}</dd></div>
          <div><dt>Current window / radius</dt><dd>{result.summary.current.windowMinutes} min / {result.summary.current.radiusKm} km</dd></div>
          {result.summary.current.status === "unavailable" && <div><dt>Current failure</dt><dd>{result.summary.current.failureStatus} · {result.summary.current.message}</dd></div>}
          {(result.summary.current.status === "clear" || result.summary.current.status === "active") && <>
            <div><dt>Latest Flash</dt><dd>{formatDate(result.summary.current.latestEventAt)}</dd></div>
            <div><dt>Nearest Flash</dt><dd>{formatNumber(result.summary.current.nearestKm)} km</dd></div>
            <div><dt>Nearest Flash age</dt><dd>{formatNumber(result.summary.current.nearestAgeMinutes, 2)} min</dd></div>
            <div><dt>Total flashes</dt><dd>{result.summary.current.totalFlashes}</dd></div>
            <div><dt>Within 5 km</dt><dd>{result.summary.current.counts.within5Km}</dd></div>
            <div><dt>Within 10 km</dt><dd>{result.summary.current.counts.within10Km}</dd></div>
            <div><dt>Within 25 km</dt><dd>{result.summary.current.counts.within25Km}</dd></div>
            <div><dt>Within 40 km</dt><dd>{result.summary.current.counts.within40Km}</dd></div>
            <div><dt>Malformed Flash records skipped</dt><dd>{result.summary.current.rejectedEventCount}</dd></div>
          </>}
        </dl>
        {(result.summary.current.status === "clear" || result.summary.current.status === "active") && result.summary.current.mayBeTruncated && <p className={styles.error} role="status">Xweather returned the 1,000-flash limit. Counts may be incomplete for this five-minute window.</p>}
        <p className={styles.note}>Summary detections and consolidated Flash counts are different event units and are not compared as equivalents.</p>
      </section>}

      {summaryDiagnostics && <section className={styles.panel}>
        <h2>Summary request diagnostics</h2>
        <dl className={styles.grid}>
          {diagnosticsRows(summaryDiagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
        </dl>
      </section>}

      {currentDiagnostics && <section className={styles.panel}>
        <h2>Flash request diagnostics</h2>
        <dl className={styles.grid}>
          {diagnosticsRows(currentDiagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
        </dl>
      </section>}

      <section className={styles.panel} aria-labelledby="research-heading">
        <h2 id="research-heading">History endpoint research</h2>
        <form className={styles.coordinateForm} onSubmit={submitResearch}>
          <label>Endpoint / window
            <select value={researchMode} onChange={(event) => setResearchMode(event.target.value as XweatherResearchMode)}>
              <option value="summary-default">Summary · provider default</option>
              <option value="summary-15m">Summary · requested 15 minutes</option>
              <option value="summary-30m">Summary · requested 30 minutes</option>
              <option value="flash-5m">Flash · documented 5 minutes</option>
            </select>
          </label>
          <button type="submit" disabled={researchLoading}>{researchLoading ? "Researching…" : "Run one research request"}</button>
        </form>
        <p className={styles.note}>Uses the coordinates above. Each click makes exactly one upstream request; there is no automatic refresh. Summary data is aggregate-only, while flash is limited here to its documented five-minute window.</p>
      </section>

      {researchResult && !researchResult.ok && <section className={styles.panel} aria-live="polite">
        <h2>Research request unavailable</h2>
        <p className={styles.error}><strong>{researchResult.status}</strong> · {researchResult.message}</p>
        <dl className={styles.grid}>
          <div><dt>Mode</dt><dd>{researchResult.mode ?? "invalid"}</dd></div>
          <div><dt>Provider code</dt><dd>{researchResult.providerCode ?? "unavailable"}</dd></div>
          {diagnosticsRows(researchResult.diagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
        </dl>
        <p className={styles.note}>A failed research request is never represented as zero activity.</p>
      </section>}

      {researchResult?.ok && <section className={styles.panel} aria-live="polite">
        <h2>Research result</h2>
        <dl className={styles.grid}>
          <div><dt>Endpoint</dt><dd>{researchResult.endpoint}</dd></div>
          <div><dt>Mode</dt><dd>{researchResult.mode}</dd></div>
          <div><dt>Data kind</dt><dd>{researchResult.dataKind}</dd></div>
          <div><dt>Requested window</dt><dd>{researchResult.requestedWindowMinutes === null ? "provider default" : `${researchResult.requestedWindowMinutes} minutes`}</dd></div>
          <div><dt>Returned count</dt><dd>{researchResult.returnedCount}</dd></div>
          <div><dt>Fetched at</dt><dd>{formatDate(researchResult.fetchedAt)}</dd></div>
          <div><dt>Oldest event</dt><dd>{formatDate(researchResult.oldestEventAt)}</dd></div>
          <div><dt>Newest event</dt><dd>{formatDate(researchResult.newestEventAt)}</dd></div>
          <div><dt>Reported range from</dt><dd>{formatDate(researchResult.actualRangeFrom)}</dd></div>
          <div><dt>Reported range to</dt><dd>{formatDate(researchResult.actualRangeTo)}</dd></div>
          <div><dt>Cloud-to-ground pulses</dt><dd>{researchResult.pulseCounts?.cloudToGround ?? "not provided"}</dd></div>
          <div><dt>Intracloud pulses</dt><dd>{researchResult.pulseCounts?.intracloud ?? "not provided"}</dd></div>
          {diagnosticsRows(researchResult.diagnostics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "unavailable"}</dd></div>)}
        </dl>
        <p className={styles.note}>{researchResult.dataKind === "aggregate-summary"
          ? "The summary endpoint does not return raw event coordinates or a nearest-event distance."
          : "Flash results are consolidated events, but the provider’s documented flash window remains five minutes."} These debug results do not change the app’s live observation behavior.</p>
      </section>}

      <section className={styles.panel} aria-labelledby="comparison-heading">
        <h2 id="comparison-heading">Raw vs Flash comparison</h2>
        <form className={styles.coordinateForm} onSubmit={submitComparison}>
          <button type="submit" disabled={comparisonLoading}>{comparisonLoading ? "Comparing…" : "Compare Raw vs Flash"}</button>
        </form>
        <p className={styles.note}>Uses the coordinates above. One click intentionally makes two no-store upstream requests at approximately the same time: Raw 40 km and Flash 40 km. Nothing refreshes automatically.</p>
      </section>

      {comparisonResult && !comparisonResult.ok && <section className={styles.panel} aria-live="polite">
        <h2>Comparison unavailable</h2>
        <p className={styles.error}><strong>{comparisonResult.status}</strong> · {comparisonResult.message}</p>
      </section>}

      {comparisonResult?.ok && <section className={styles.panel} aria-live="polite">
        <h2>Comparison result</h2>
        <pre className={styles.summaryBlock}>{comparisonResult.comparison.summaryLines.join("\n")}</pre>
        <div className={styles.comparisonColumns}>
          <ComparisonSide title="Raw pulses / strikes" result={comparisonResult.comparison.raw} />
          <ComparisonSide title="Consolidated flashes" result={comparisonResult.comparison.flash} />
        </div>
        <button className={styles.copyButton} type="button" onClick={() => void copyComparisonJson()}>Copy comparison JSON</button>
        {copyStatus && <span className={styles.copyStatus} role="status">{copyStatus}</span>}
        <details className={styles.jsonDetails}>
          <summary>Show copyable JSON</summary>
          <pre className={styles.jsonBlock}>{JSON.stringify(comparisonResult.comparison, null, 2)}</pre>
        </details>
        <p className={styles.note}>Pulse and flash counts use different event units and are not treated as an accuracy ratio. The primary comparison is presence, nearest distance, direction and recency within the shared 40 km radius.</p>
      </section>}

      <footer className={styles.footer}>
        <a href="https://www.xweather.com/" target="_blank" rel="noreferrer">Powered by Vaisala Xweather</a>
        <span>Private spike · Not a warning service</span>
      </footer>
    </main>
  );
}
