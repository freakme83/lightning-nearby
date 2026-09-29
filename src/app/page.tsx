"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { LOCATION_STORAGE_KEY, formatCoordinates, formatLocationLabel, parseMonitoredLocation, reduceLocationPrecision, saveMonitoredLocation, type LocationSelection, type MonitoredLocation } from "@/lib/location";
import { MIN_PLACE_QUERY_LENGTH, PLACE_SEARCH_DEBOUNCE_MS, reverseGeocodeLocation, searchPlaces, type PlaceResult } from "@/lib/geocoding";
import { RISK_THRESHOLDS, describeWeatherCode, isThunderstormCode, selectNext24Hours, type RiskLevel } from "@/lib/weather";
import { calculateStrongestSignalWindow, fetchOutlook, isCurrentForecastRequest, mergeEnsembleEvidence, retainSelectedHour, summarizeSignal, type Outlook, type OutlookHour } from "@/lib/outlook";
import LocationMap from "./location-map";

const RISK_LABEL: Record<RiskLevel, string> = { low: "Low", elevated: "Elevated", high: "High" };
function localTime(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(epoch * 1000); }
function localDateKey(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(epoch * 1000); }
function dayLabel(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(epoch * 1000); }
function period(start: number, end: number, timezone: string) { return `${localTime(start, timezone)}–${localTime(end, timezone)}`; }
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
  const [forecast, setForecast] = useState<Outlook | null>(null);
  const [hours, setHours] = useState<OutlookHour[]>([]);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [forecastError, setForecastError] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"search" | "map">("search");
  const [candidate, setCandidate] = useState<LocationSelection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchNotice, setSearchNotice] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [resolvingLocation, setResolvingLocation] = useState(false);
  const immediateSearchRef = useRef(false);
  const searchRequestRef = useRef(0);
  const confirmRequestRef = useRef(0);
  const reverseControllerRef = useRef<AbortController | null>(null);
  const forecastRequestRef = useRef(0);
  const currentOutlookRef = useRef<Outlook | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (saved) {
        const parsed = parseMonitoredLocation(JSON.parse(saved));
        if (parsed) {
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
    const requestId = ++forecastRequestRef.current;
    const isCurrentRequest = () => isCurrentForecastRequest(requestId, forecastRequestRef.current, controller.signal);
    // Clear prior results as this effect synchronizes to a different saved location.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setForecastError(false); setForecast(null); setHours([]); setSelectedTime(null);
    currentOutlookRef.current = null;
    const requests = fetchOutlook(location.latitude, location.longitude, controller.signal);
    let pendingEnsemble: Awaited<typeof requests.ensemble> = null;
    let primaryReady = false;
    void requests.primary.then((primary) => {
      if (!isCurrentRequest()) return;
      primaryReady = true;
      const result = pendingEnsemble ? mergeEnsembleEvidence(primary, pendingEnsemble) : primary;
      const nextHours = selectNext24Hours(result.hours);
      if (!nextHours.some((hour) => hour.signal.kind === "qualitative")) {
        setForecastError(true); setLoading(false); return;
      }
      currentOutlookRef.current = result;
      setForecast(result); setHours(nextHours); setSelectedTime(nextHours[0]?.time ?? null); setLoading(false);
    }).catch(() => {
      if (isCurrentRequest()) { setForecastError(true); setLoading(false); }
    });
    void requests.ensemble.then((ensemble) => {
      if (!isCurrentRequest() || !ensemble) return;
      if (!primaryReady) { pendingEnsemble = ensemble; return; }
      const current = currentOutlookRef.current;
      if (!current) return;
      const result = mergeEnsembleEvidence(current, ensemble);
      const nextHours = selectNext24Hours(result.hours);
      currentOutlookRef.current = result;
      setForecast(result); setHours(nextHours);
      setSelectedTime((selected) => retainSelectedHour(selected, nextHours));
    });
    return () => controller.abort();
  }, [location, storageReady]);

  const requestLocation = useCallback(() => {
    setLocationMessage("");
    if (!navigator.geolocation) { setLocationMessage("Location isn’t available in this browser. Try again in a browser that supports location."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      const reduced = reduceLocationPrecision(coords.latitude, coords.longitude);
      try { const saved = saveMonitoredLocation(localStorage, { ...reduced, source: "geolocation" }); if (saved) setLocation(saved); }
      catch { setLocationMessage("This browser couldn’t save your location on this device. Check its storage settings and try again."); }
      setLocating(false);
    }, (error) => { setLocationMessage(locationErrorMessage(error.code)); setLocating(false); },
    { enableHighAccuracy: false, maximumAge: 300_000, timeout: 15_000 });
  }, []);

  const openPicker = useCallback(() => {
    setCandidate(location ? { ...location } : null);
    setPickerMode("search"); setSearchQuery(""); setSearchResults([]); setSearchError(""); setSearchNotice(""); setHasSearched(false); setSearching(false);
    setLocationMessage(""); setPickerOpen(true);
  }, [location]);

  const submitPlaceSearch = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (Array.from(searchQuery.trim()).length < MIN_PLACE_QUERY_LENGTH) { setSearchError(`Enter at least ${MIN_PLACE_QUERY_LENGTH} characters to search.`); setSearchResults([]); setSearchNotice(""); setHasSearched(false); return; }
    immediateSearchRef.current = true;
    setSearchError(""); setSearchNotice(""); setSearchRevision((revision) => revision + 1);
  }, [searchQuery]);

  useEffect(() => {
    if (!pickerOpen || pickerMode !== "search") return;
    const query = searchQuery.trim();
    if (Array.from(query).length < MIN_PLACE_QUERY_LENGTH) return;
    const requestId = ++searchRequestRef.current;
    const controller = new AbortController();
    const delay = immediateSearchRef.current ? 0 : PLACE_SEARCH_DEBOUNCE_MS;
    immediateSearchRef.current = false;
    const timer = window.setTimeout(() => {
      setSearching(true); setSearchError("");
      void searchPlaces(query, controller.signal).then(({ results, fallbackMessage }) => {
        if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
        setSearchResults(results); setSearchNotice(fallbackMessage ?? ""); setHasSearched(true);
      }).catch(() => {
        if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
        setSearchError("Place search is unavailable right now. Check your connection and try again.");
        setSearchResults([]); setSearchNotice(""); setHasSearched(true);
      }).finally(() => {
        if (!controller.signal.aborted && requestId === searchRequestRef.current) setSearching(false);
      });
    }, delay);
    return () => {
      window.clearTimeout(timer); controller.abort();
      if (requestId === searchRequestRef.current) searchRequestRef.current += 1;
    };
  }, [pickerOpen, pickerMode, searchQuery, searchRevision]);

  const changeSearchQuery = useCallback((query: string) => {
    setSearchQuery(query); setSearchResults([]); setSearchError(""); setSearchNotice(""); setHasSearched(false); setSearching(false);
  }, []);

  const switchPickerMode = useCallback((mode: "search" | "map") => {
    setSearching(false); setPickerMode(mode);
  }, []);

  const selectPlace = useCallback((place: PlaceResult) => {
    reverseControllerRef.current?.abort(); confirmRequestRef.current += 1; setResolvingLocation(false);
    setCandidate(place); setPickerMode("map"); setSearchError("");
  }, []);

  const pickMapPoint = useCallback((latitude: number, longitude: number) => {
    reverseControllerRef.current?.abort(); confirmRequestRef.current += 1; setResolvingLocation(false);
    setCandidate({ ...reduceLocationPrecision(latitude, longitude), source: "map" });
  }, []);

  const cancelPicker = useCallback(() => {
    searchRequestRef.current += 1; confirmRequestRef.current += 1; reverseControllerRef.current?.abort();
    setPickerOpen(false); setCandidate(null); setSearchError(""); setSearchNotice(""); setSearchResults([]); setSearching(false); setResolvingLocation(false);
  }, []);

  const confirmCandidate = useCallback(async () => {
    if (!candidate || resolvingLocation) return;
    const requestId = ++confirmRequestRef.current;
    const controller = new AbortController();
    reverseControllerRef.current = controller;
    setResolvingLocation(true); setLocationMessage("");
    let selection = candidate;
    if (candidate.source === "map") {
      try {
        const metadata = await reverseGeocodeLocation(candidate.latitude, candidate.longitude, controller.signal);
        if (metadata) selection = { ...candidate, ...metadata };
      } catch {
        if (controller.signal.aborted || requestId !== confirmRequestRef.current) return;
      }
    }
    if (controller.signal.aborted || requestId !== confirmRequestRef.current) return;
    try {
      const saved = saveMonitoredLocation(localStorage, selection);
      if (!saved) return;
      setLocation(saved); setLocationMessage(""); setPickerOpen(false); setCandidate(null);
    } catch {
      setLocationMessage("This browser couldn’t save the selected location on this device. Check its storage settings and try again.");
    } finally {
      if (requestId === confirmRequestRef.current) setResolvingLocation(false);
    }
  }, [candidate, resolvingLocation]);

  const highestWindow = useMemo(() => calculateStrongestSignalWindow(hours), [hours]);
  const selected = hours.find((hour) => hour.time === selectedTime) ?? hours[0];
  const locationPicker = pickerOpen && <section className="location-picker" aria-label="Choose a monitored location">
    <div className="picker-heading"><div><p className="eyebrow">LOCATION</p><h2>Choose a point</h2></div><button className="text-button" type="button" onClick={cancelPicker}>Cancel</button></div>
    <div className="picker-tabs" role="group" aria-label="Location selection method">
      <button className={`secondary-button ${pickerMode === "search" ? "is-active" : ""}`} type="button" aria-pressed={pickerMode === "search"} disabled={resolvingLocation} onClick={() => switchPickerMode("search")}>Search place</button>
      <button className={`secondary-button ${pickerMode === "map" ? "is-active" : ""}`} type="button" aria-pressed={pickerMode === "map"} disabled={resolvingLocation} onClick={() => switchPickerMode("map")}>Pick on map</button>
    </div>
    {pickerMode === "search" ? <>
      <form className="place-search" onSubmit={submitPlaceSearch}>
        <label className="visually-hidden" htmlFor="place-search">Search for a place</label>
        <input id="place-search" type="search" value={searchQuery} onChange={(event) => changeSearchQuery(event.target.value)} placeholder="City, town, or place" autoComplete="off" />
        <button className="secondary-button" type="submit">{searching ? "Searching…" : "Search"}</button>
      </form>
      {searchError && <p className="inline-error" role="alert">{searchError}</p>}
      {searching && <p className="picker-note" role="status">Searching places…</p>}
      {searchNotice && <p className="picker-note" role="status">{searchNotice}</p>}
      {!searching && hasSearched && !searchError && searchResults.length === 0 && <p className="picker-note" role="status">No matching places found. Try a nearby town or a broader search.</p>}
      {searchResults.length > 0 && <ul className="place-results" aria-label="Search results">{searchResults.map((place, index) => <li key={`${place.latitude}:${place.longitude}:${index}`}>
        <button type="button" onClick={() => selectPlace(place)}><strong>{place.label}</strong><span>{[place.admin1, place.country].filter(Boolean).join(", ") || formatCoordinates(place.latitude, place.longitude)}</span></button>
      </li>)}</ul>}
    </> : <>
      <p className="picker-note">Tap the map to place one marker. Pan and zoom to refine the point.</p>
      <LocationMap candidate={candidate} onPick={pickMapPoint} />
      <p className="picker-note">Map tiles and place labels © OpenStreetMap contributors.</p>
    </>}
    {candidate && <div className="candidate-row"><p><strong>{formatLocationLabel(candidate)}</strong><span>{formatCoordinates(candidate.latitude, candidate.longitude)}</span></p><button className="primary-button" type="button" onClick={() => void confirmCandidate()} disabled={resolvingLocation}>{resolvingLocation ? "Finding place…" : "Use this location"}</button></div>}
    {candidate?.source === "map" && <p className="picker-note">Confirming this point may send its coordinates to OpenStreetMap Nominatim to find a place label.</p>}
  </section>;

  if (!storageReady) return <main className="page-shell"><div className="loading-state" role="status">Opening your local forecast…</div></main>;

  return <main className="page-shell">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Lightning Nearby home"><span className="brand-mark" aria-hidden="true">↯</span><span>LIGHTNING <b>NEARBY</b></span></Link>
      <span className="edition">LOCAL OUTLOOK <span aria-hidden="true">·</span> 24H</span>
    </header>

    {!location ? <section className="welcome-panel" aria-labelledby="welcome-title">
      <p className="eyebrow">A clearer view of the hours ahead</p>
      <h1 id="welcome-title">Thunderstorm outlook,<br /><em>where you are.</em></h1>
      <p className="welcome-copy">Choose a point to see the next 24 hours of forecast conditions. Device location is requested only after a tap; place searches are sent to Open‑Meteo. Your selected location stays on this device.</p>
      <button className="primary-button" type="button" onClick={requestLocation} disabled={locating}><span aria-hidden="true">⌖</span>{locating ? "Finding location…" : "Use my location"}</button>
      <button className="text-button picker-open-button" type="button" onClick={openPicker}>Search for a place or choose on map</button>
      {locationPicker}
      {locationMessage && <p className="inline-error" role="alert">{locationMessage}</p>}
      <p className="permission-note">Your browser asks before sharing device location. It is not requested until you tap “Use my location”.</p>
      <div className="welcome-rule" /><p className="micro-copy">Forecast guidance only. This is not an official weather warning.</p>
    </section> : <section className="overview" aria-labelledby="overview-title">
      <div className="location-line"><div><p className="eyebrow">MONITORED LOCATION</p><p className="coordinates">{location.label || location.country ? formatLocationLabel(location) : formatCoordinates(location.latitude, location.longitude)}</p>{(location.label || location.country) && <p className="location-coordinates">{formatCoordinates(location.latitude, location.longitude)}</p>}</div>
        <div className="location-actions"><button className="text-button" type="button" onClick={requestLocation} disabled={locating}>{locating ? "Locating…" : "Update location"}</button><button className="text-button" type="button" onClick={openPicker}>Search / map</button></div></div>
      {locationPicker}
      {locationMessage && <p className="inline-error" role="alert">{locationMessage}</p>}
      {loading && <div className="loading-state" role="status">Getting the latest forecast…</div>}
      {forecastError && !loading && <div className="error-panel" role="alert"><div><strong>Forecast unavailable</strong><p>Open‑Meteo could not provide enough current forecast data. Check your connection and try again. No old forecast is shown as current.</p></div><button className="secondary-button" type="button" onClick={() => setLocation({ ...location })}>Try again</button></div>}
      {forecast && !loading && <>
        <div className={`risk-overview ${highestWindow ? `risk-${highestWindow.risk}` : ""}`}>
          <div className="risk-heading"><span className="risk-orb" aria-hidden="true"><span /></span><div><p className="eyebrow">NEXT 24 HOURS · {forecast.timezone}</p><h1 id="overview-title">{highestWindow ? <>{RISK_LABEL[highestWindow.risk]} <span>signal</span></> : "Forecast signal"}</h1></div></div>
          <p className="summary">{summarizeSignal(highestWindow, highestWindow ? period(highestWindow.start, highestWindow.end, forecast.timezone) : "")}</p>
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
                <button type="button" className={`hour-button ${hour.signal.kind === "qualitative" ? `risk-${hour.signal.risk}` : ""}`} aria-pressed={isSelected} aria-label={`${localTime(hour.time, forecast.timezone)}, ${hour.signal.kind === "qualitative" ? `${RISK_LABEL[hour.signal.risk]} thunderstorm signal` : "signal unavailable"}`} onClick={() => setSelectedTime(hour.time)}>
                  <span className="hour-time">{localTime(hour.time, forecast.timezone).slice(0, 2)}</span><span className="risk-bar" aria-hidden="true"><span /></span><span className="hour-risk">{hour.signal.kind === "qualitative" ? RISK_LABEL[hour.signal.risk] : "—"}</span>
                </button>
              </li>;
            })}
          </ol></div>
          <div className="legend" aria-label="Risk level legend"><span><i className="legend-dot low" />Low</span><span><i className="legend-dot elevated" />Elevated</span><span><i className="legend-dot high" />High</span><span className="derived-label">Derived outlook</span></div>
        </section>
        {selected && <section className="details-section" aria-live="polite" aria-labelledby="details-title">
          <div className="details-top"><div><p className="eyebrow">SELECTED HOUR</p><h2 id="details-title">{dayLabel(selected.time, forecast.timezone)} · {localTime(selected.time, forecast.timezone)}</h2></div>{selected.signal.kind === "qualitative" && <span className={`small-risk risk-${selected.signal.risk}`}>{RISK_LABEL[selected.signal.risk]}</span>}</div>
          <p className="details-note">Open‑Meteo forecast values</p>
          <dl className="forecast-values">
            {selected.weatherCode != null && <div><dt>Weather</dt><dd>{describeWeatherCode(selected.weatherCode)}</dd></div>}
            {selected.evidence.providerProbability != null && <div><dt>Thunderstorm probability</dt><dd>{Math.round(selected.evidence.providerProbability)}% · provider value</dd></div>}
            {selected.evidence.ensemble && selected.evidence.ensemble.supportingMembers > 0 && <div><dt>Nearby model support</dt><dd>Present</dd></div>}
            {selected.precipitationProbability != null && <div><dt>Precipitation chance</dt><dd>{Math.round(selected.precipitationProbability)}%</dd></div>}
          </dl>
          <p className="classification-note">{selected.signal.kind === "unavailable" ? "There is not enough forecast data to assess this hour." : isThunderstormCode(selected.weatherCode) && selected.evidence.providerProbability != null && selected.evidence.providerProbability < RISK_THRESHOLDS.directThunderstormProbabilityElevated ? "The weather forecast indicates a thunderstorm here, while the provider's separate probability is low. Forecast indicators can differ." : "Low / Elevated / High is a qualitative forecast signal, not a probability or official warning. Only the provider value above, when shown, is a thunderstorm probability."}</p>
        </section>}
        <div className="update-line">Forecast updated {new Intl.DateTimeFormat("en-GB", { timeZone: forecast.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(forecast.fetchedAt)} local time</div>
      </>}
    </section>}

    <footer className="disclaimer"><span className="disclaimer-mark" aria-hidden="true">i</span><p><strong>Forecast guidance, not an official warning.</strong> Forecasts can change and may miss local conditions. Follow your local meteorological and emergency authorities for safety advice.</p></footer>
    <div className="footer-meta"><span>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open‑Meteo</a></span><span>Location stays on this device</span></div>
  </main>;
}
