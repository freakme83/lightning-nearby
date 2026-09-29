"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createForecastDebugSnapshot, type DebugEnsembleStatus } from "@/lib/forecast-debug";
import { isValidCoordinates, LOCATION_STORAGE_KEY, parseMonitoredLocation } from "@/lib/location";
import { combineForecasts, explainSignalDecision, fetchOutlook, isCurrentForecastRequest, mergeEnsembleEvidence, retainSelectedHour, type Outlook } from "@/lib/outlook";
import { describeWeatherCode, isThunderstormCode, selectNext24Hours } from "@/lib/weather";
import { formatForecastLocalTime, isGenericFixedOffsetTimezone, resolveDisplayTimezone } from "@/lib/timezone";
import styles from "./debug.module.css";

type Coordinates = { latitude: number; longitude: number };
type PrimaryStatus = "idle" | "loading" | "available" | "unavailable";

function showValue(value: number | string | null | undefined, suffix = ""): string {
  return value == null ? "unavailable" : `${value}${suffix}`;
}

function safeLocalTime(timestamp: number, timezone: string): string {
  try { return formatForecastLocalTime(timestamp, timezone); }
  catch { return "unavailable"; }
}

export default function ForecastDebugPage() {
  const [latitudeText, setLatitudeText] = useState("");
  const [longitudeText, setLongitudeText] = useState("");
  const [loadedCoordinates, setLoadedCoordinates] = useState<Coordinates | null>(null);
  const [savedCoordinates, setSavedCoordinates] = useState<Coordinates | null>(null);
  const [savedTimezone, setSavedTimezone] = useState<string | undefined>();
  const [validationError, setValidationError] = useState("");
  const [primaryStatus, setPrimaryStatus] = useState<PrimaryStatus>("idle");
  const [ensembleStatus, setEnsembleStatus] = useState<DebugEnsembleStatus>("not-loaded");
  const [primaryError, setPrimaryError] = useState("");
  const [outlook, setOutlook] = useState<Outlook | null>(null);
  const [providerTimezone, setProviderTimezone] = useState<string | undefined>();
  const [displayTimezone, setDisplayTimezone] = useState<string | undefined>();
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const outlookRef = useRef<Outlook | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (!stored) return;
      const location = parseMonitoredLocation(JSON.parse(stored));
      if (location) {
        // Hydrate the optional saved-location shortcut from browser-only storage after mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSavedCoordinates({ latitude: location.latitude, longitude: location.longitude }); setSavedTimezone(location.timezone);
      }
    } catch { /* Saved-location convenience is optional; manual coordinates remain available. */ }
  }, []);

  const loadCoordinates = useCallback((coordinates: Coordinates, placeTimezone?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const isCurrent = () => isCurrentForecastRequest(requestId, requestIdRef.current, controller.signal);
    setLoadedCoordinates(coordinates);
    setValidationError(""); setPrimaryError(""); setPrimaryStatus("loading"); setEnsembleStatus("loading");
    setOutlook(null); outlookRef.current = null; setProviderTimezone(undefined); setDisplayTimezone(undefined); setSelectedTime(null);

    const applyOutlook = (next: Outlook) => {
      if (!isCurrent()) return;
      outlookRef.current = next;
      setOutlook(next);
      const nextHours = selectNext24Hours(next.hours);
      setSelectedTime((selected) => retainSelectedHour(selected, nextHours));
    };

    const requests = fetchOutlook(coordinates.latitude, coordinates.longitude, controller.signal);
    let pendingEnsemble: Awaited<typeof requests.ensemble> = null;
    let primaryReady = false;
    let primaryFailed = false;

    void requests.primary.then((primary) => {
      if (!isCurrent()) return;
      primaryReady = true;
      setPrimaryStatus("available");
      setProviderTimezone(primary.timezone);
      setDisplayTimezone(primary.timezone);
      const initial = pendingEnsemble ? mergeEnsembleEvidence(primary, pendingEnsemble) : primary;
      applyOutlook(initial);

      if (isGenericFixedOffsetTimezone(primary.timezone)) {
        void resolveDisplayTimezone(coordinates.latitude, coordinates.longitude, primary.timezone, placeTimezone, controller.signal)
          .then((timezone) => {
            if (!isCurrent() || timezone === primary.timezone) return;
            setDisplayTimezone(timezone);
          });
      }
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      primaryFailed = true;
      setPrimaryStatus("unavailable");
      setPrimaryError(error instanceof Error ? error.message : "Forecast request failed.");
      if (pendingEnsemble) {
        const ensembleOnly = combineForecasts(null, pendingEnsemble);
        if (ensembleOnly) {
          setDisplayTimezone(ensembleOnly.timezone);
          applyOutlook(ensembleOnly);
          if (isGenericFixedOffsetTimezone(ensembleOnly.timezone)) {
            void resolveDisplayTimezone(coordinates.latitude, coordinates.longitude, ensembleOnly.timezone, placeTimezone, controller.signal)
              .then((timezone) => { if (isCurrent()) setDisplayTimezone(timezone); });
          }
        }
      }
    });

    void requests.ensemble.then((ensemble) => {
      if (!isCurrent()) return;
      if (!ensemble) { setEnsembleStatus("unavailable"); return; }
      setEnsembleStatus("available");
      if (!primaryReady) {
        pendingEnsemble = ensemble;
        if (primaryFailed) {
          const ensembleOnly = combineForecasts(null, ensemble);
          if (ensembleOnly) {
            setDisplayTimezone(ensembleOnly.timezone);
            applyOutlook(ensembleOnly);
            if (isGenericFixedOffsetTimezone(ensembleOnly.timezone)) {
              void resolveDisplayTimezone(coordinates.latitude, coordinates.longitude, ensembleOnly.timezone, placeTimezone, controller.signal)
                .then((timezone) => { if (isCurrent()) setDisplayTimezone(timezone); });
            }
          }
        }
        return;
      }
      const current = outlookRef.current;
      if (current) applyOutlook(mergeEnsembleEvidence(current, ensemble));
    });
  }, []);

  useEffect(() => () => {
    controllerRef.current?.abort();
    requestIdRef.current += 1;
  }, []);

  const submitCoordinates = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const latitude = Number(latitudeText.trim());
    const longitude = Number(longitudeText.trim());
    if (!latitudeText.trim() || !longitudeText.trim() || !isValidCoordinates(latitude, longitude)) {
      setValidationError("Enter a latitude from -90 to 90 and a longitude from -180 to 180.");
      return;
    }
    loadCoordinates({ latitude, longitude });
  }, [latitudeText, longitudeText, loadCoordinates]);

  const hours = useMemo(() => outlook ? selectNext24Hours(outlook.hours) : [], [outlook]);
  const selected = hours.find((hour) => hour.time === selectedTime) ?? hours[0];
  const timezone = displayTimezone ?? providerTimezone ?? outlook?.timezone ?? "UTC";
  const selectedDecision = selected ? explainSignalDecision(selected.evidence) : null;
  const snapshot = loadedCoordinates ? createForecastDebugSnapshot({
    ...loadedCoordinates,
    hour: selected,
    providerTimezone,
    displayTimezone,
    ensembleStatus,
    ensembleFetchedAt: outlook?.ensembleFetchedAt,
  }) : "";

  const useSavedLocation = () => {
    if (!savedCoordinates) return;
    setLatitudeText(String(savedCoordinates.latitude)); setLongitudeText(String(savedCoordinates.longitude));
    loadCoordinates(savedCoordinates, savedTimezone);
  };

  const copySnapshot = async () => {
    try {
      await navigator.clipboard.writeText(snapshot);
      setCopyMessage("Diagnostic snapshot copied.");
    } catch {
      setCopyMessage("Could not access the clipboard in this browser.");
    }
  };

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.kicker}>DEVELOPER TOOL</p><h1>Forecast diagnostics</h1><p>Observe the production forecast inputs and decision path for any coordinate.</p></div>
      <Link href="/">Back to Lightning Nearby</Link>
    </header>

    <section className={styles.panel} aria-labelledby="coordinate-title">
      <h2 id="coordinate-title">Inspect coordinates</h2>
      <form className={styles.coordinateForm} onSubmit={submitCoordinates}>
        <label>Latitude<input inputMode="decimal" type="number" step="any" value={latitudeText} onChange={(event) => setLatitudeText(event.target.value)} placeholder="26.77" /></label>
        <label>Longitude<input inputMode="decimal" type="number" step="any" value={longitudeText} onChange={(event) => setLongitudeText(event.target.value)} placeholder="-83.86" /></label>
        <button type="submit">Load / Inspect</button>
        {savedCoordinates && <button type="button" className={styles.secondaryButton} onClick={useSavedLocation}>Use saved location</button>}
      </form>
      {validationError && <p className={styles.error} role="alert">{validationError}</p>}
      {loadedCoordinates && <p className={styles.coordinateSummary}>Loaded: {loadedCoordinates.latitude}, {loadedCoordinates.longitude}</p>}
    </section>

    {loadedCoordinates && <>
      <section className={styles.panel} aria-labelledby="source-status-title">
        <h2 id="source-status-title">Source status</h2>
        <dl className={styles.grid}>
          <div><dt>Deterministic forecast</dt><dd>{primaryStatus}</dd></div>
          <div><dt>Ensemble support</dt><dd>{ensembleStatus}</dd></div>
          <div><dt>Provider timezone</dt><dd>{showValue(providerTimezone)}</dd></div>
          <div><dt>Resolved display timezone</dt><dd>{showValue(displayTimezone)}</dd></div>
        </dl>
        {primaryStatus === "unavailable" && <p className={styles.error} role="status">Deterministic forecast unavailable: {primaryError || "request failed"}. Ensemble-only hours, if any, remain qualitative unavailable.</p>}
      </section>

      {hours.length > 0 && <section className={styles.panel} aria-labelledby="hour-title">
        <h2 id="hour-title">Next 24 forecast hours</h2>
        <label className={styles.hourSelector}>Selected hour
          <select value={selected?.time ?? ""} onChange={(event) => setSelectedTime(Number(event.target.value))}>
            {hours.map((hour) => <option key={hour.time} value={hour.time}>{safeLocalTime(hour.time, timezone)} · {new Date(hour.time * 1_000).toISOString()}</option>)}
          </select>
        </label>
      </section>}

      {selected && <>
        <section className={styles.panel} aria-labelledby="identity-title">
          <h2 id="identity-title">Selected hour identity</h2>
          <dl className={styles.grid}>
            <div><dt>Latitude</dt><dd>{loadedCoordinates.latitude}</dd></div>
            <div><dt>Longitude</dt><dd>{loadedCoordinates.longitude}</dd></div>
            <div><dt>Unix timestamp (s)</dt><dd>{selected.time}</dd></div>
            <div><dt>UTC ISO timestamp</dt><dd>{new Date(selected.time * 1_000).toISOString()}</dd></div>
            <div><dt>Provider timezone</dt><dd>{showValue(providerTimezone)}</dd></div>
            <div><dt>Resolved display timezone</dt><dd>{showValue(displayTimezone)}</dd></div>
            <div><dt>Displayed local time</dt><dd>{safeLocalTime(selected.time, timezone)}</dd></div>
          </dl>
        </section>

        <section className={styles.panel} aria-labelledby="deterministic-title">
          <h2 id="deterministic-title">Deterministic forecast</h2>
          <dl className={styles.grid}>
            <div><dt>weather_code</dt><dd>{showValue(selected.weatherCode)} · {describeWeatherCode(selected.weatherCode)}</dd></div>
            <div><dt>thunderstorm_probability</dt><dd>{showValue(selected.evidence.providerProbability, selected.evidence.providerProbability == null ? "" : "%")}</dd></div>
            <div><dt>precipitation_probability</dt><dd>{showValue(selected.precipitationProbability, selected.precipitationProbability == null ? "" : "%")}</dd></div>
            <div><dt>CAPE</dt><dd>{showValue(selected.cape, selected.cape == null ? "" : " J/kg")}</dd></div>
            <div><dt>CIN</dt><dd>{showValue(selected.convectiveInhibition, selected.convectiveInhibition == null ? "" : " J/kg")}</dd></div>
            <div><dt>Deterministic qualitative result</dt><dd>{selected.signal.kind === "qualitative" ? selected.signal.risk : "unavailable"}</dd></div>
          </dl>
        </section>

        <section className={styles.panel} aria-labelledby="ensemble-title">
          <h2 id="ensemble-title">Ensemble evidence</h2>
          <p className={styles.note}>Member support is secondary evidence, not a thunderstorm probability.</p>
          <dl className={styles.grid}>
            <div><dt>Fetch status</dt><dd>{ensembleStatus}</dd></div>
            <div><dt>Model</dt><dd>{showValue(selected.evidence.ensemble?.model)}</dd></div>
            <div><dt>Supporting / available members</dt><dd>{selected.evidence.ensemble ? `${selected.evidence.ensemble.supportingMembers} / ${selected.evidence.ensemble.availableMembers}` : "unavailable"}</dd></div>
            <div><dt>Sampled locations</dt><dd>{showValue(selected.evidence.ensemble?.sampledLocations)}</dd></div>
            <div><dt>Spatial window</dt><dd>{showValue(selected.evidence.ensemble?.spatialWindowKm, selected.evidence.ensemble ? " km" : "")}</dd></div>
            <div><dt>Temporal window</dt><dd>{showValue(selected.evidence.ensemble?.temporalWindowHours, selected.evidence.ensemble ? " hour(s) either side" : "")}</dd></div>
            <div><dt>Ensemble fetched at (Unix ms)</dt><dd>{showValue(outlook?.ensembleFetchedAt)}</dd></div>
          </dl>
        </section>

        <section className={styles.panel} aria-labelledby="decision-title">
          <h2 id="decision-title">Final outlook and decision trace</h2>
          <dl className={styles.grid}>
            <div><dt>Signal kind</dt><dd>{selected.signal.kind}</dd></div>
            <div><dt>Qualitative level</dt><dd>{selected.signal.kind === "qualitative" ? selected.signal.risk : "unavailable"}</dd></div>
            <div><dt>Provider probability</dt><dd>{showValue(selected.evidence.providerProbability, selected.evidence.providerProbability == null ? "" : "%")}</dd></div>
            <div><dt>Ensemble evidence</dt><dd>{selected.evidence.ensemble ? "Present as secondary support" : "unavailable"}</dd></div>
          </dl>
          <h3>Why this qualitative result?</h3>
          <p className={styles.explanation}>{selectedDecision?.qualitative}</p>
          <h3>Ensemble influence</h3>
          <p className={styles.explanation}>{selectedDecision?.ensemble}</p>
          {isThunderstormCode(selected.weatherCode) && selected.evidence.providerProbability != null
            && <p className={styles.note}>The provider probability is retained separately; the deterministic thunderstorm code has classifier precedence.</p>}
        </section>

        <section className={styles.panel} aria-labelledby="snapshot-title">
          <h2 id="snapshot-title">Diagnostic snapshot</h2>
          <button type="button" onClick={() => void copySnapshot()}>Copy diagnostic snapshot</button>
          <p className={styles.note} role="status">{copyMessage}</p>
        </section>
      </>}

      {primaryStatus === "loading" && !selected && <p className={styles.status} role="status">Loading deterministic forecast…</p>}
      {primaryStatus === "unavailable" && !selected && ensembleStatus === "loading" && <p className={styles.status} role="status">Deterministic data is unavailable; checking whether ensemble evidence can be inspected.</p>}
    </>}
  </main>;
}
