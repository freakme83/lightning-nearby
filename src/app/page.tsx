"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { LOCATION_STORAGE_KEY, formatCoordinates, formatLocationLabel, parseMonitoredLocation, reduceLocationPrecision, saveMonitoredLocation, type LocationSelection, type MonitoredLocation } from "@/lib/location";
import { INITIAL_VISIBLE_PLACE_RESULTS, MIN_PLACE_QUERY_LENGTH, PLACE_SEARCH_DEBOUNCE_MS, parseCoordinateQuery, reverseGeocodeLocation, searchPlaces, visiblePlaceResults, type PlaceResult } from "@/lib/geocoding";
import { isCurrentGeolocationRequest, resolveGeolocationSelection } from "@/lib/geolocation";
import { RISK_THRESHOLDS, describeWeatherCode, isThunderstormCode, selectNext24Hours } from "@/lib/weather";
import { calculateStrongestSignalWindow, fetchOutlook, isCurrentForecastRequest, mergeEnsembleEvidence, retainSelectedHour, summarizeSignal, type Outlook, type OutlookHour } from "@/lib/outlook";
import { nextForecastRefreshRevision } from "@/lib/forecast-refresh";
import { isGenericFixedOffsetTimezone, resolveDisplayTimezone } from "@/lib/timezone";
import { DEFAULT_LOCALE, formatClock, formatDayLabel, forecastHeadline, readStoredLocale, riskLabel, saveLocale, t, type Locale, type MessageKey } from "@/lib/i18n";
import TodayBriefing from "./today-briefing";
import LocationMap from "./location-map";
import LiveObservation, { type ForecastContext } from "./live-observation";
import { firstLocationAutoCheckKey, isInitialLiveCheckEligible, suppressInitialLiveCheckForSession } from "@/lib/initial-live-check";

const localTime = (epoch: number, timezone: string, locale: Locale) => formatClock(epoch * 1000, timezone, locale);
function localDateKey(epoch: number, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(epoch * 1000); }
const dayLabel = formatDayLabel;
function period(start: number, end: number, timezone: string, locale: Locale) { return `${localTime(start, timezone, locale)}–${localTime(end, timezone, locale)}`; }
function displayLocationCoordinates(selection: LocationSelection): string {
  return selection.label === "Selected coordinates"
    ? `${selection.latitude}, ${selection.longitude}`
    : formatCoordinates(selection.latitude, selection.longitude);
}
function locationErrorMessage(code?: number): MessageKey {
  if (!navigator.geolocation) return "locationUnsupported";
  if (code === 1) return "locationDenied";
  if (code === 2) return "locationUnavailable";
  if (code === 3) return "locationTimeout";
  return "locationFailed";
}
function visibleLocationLabel(selection: LocationSelection, locale: Locale): string {
  return selection.label === "Selected coordinates" ? t(locale, "selectedCoordinates") : formatLocationLabel(selection);
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const localeRef = useRef<Locale>(DEFAULT_LOCALE);
  const [location, setLocation] = useState<MonitoredLocation | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [initialAutoCheckLocationKey, setInitialAutoCheckLocationKey] = useState<string | null>(null);
  const [forecast, setForecast] = useState<Outlook | null>(null);
  const [hours, setHours] = useState<OutlookHour[]>([]);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingForecast, setRefreshingForecast] = useState(false);
  const [forecastRefreshRevision, setForecastRefreshRevision] = useState(0);
  const [forecastError, setForecastError] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState<MessageKey | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"search" | "map">("search");
  const [candidate, setCandidate] = useState<LocationSelection | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [showAllSearchResults, setShowAllSearchResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<MessageKey | null>(null);
  const [searchNotice, setSearchNotice] = useState<MessageKey | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [resolvingLocation, setResolvingLocation] = useState(false);
  const immediateSearchRef = useRef(false);
  const searchRequestRef = useRef(0);
  const confirmRequestRef = useRef(0);
  const reverseControllerRef = useRef<AbortController | null>(null);
  const forecastRequestRef = useRef(0);
  const forecastRefreshPendingRef = useRef(false);
  const previousForecastLocationKeyRef = useRef<string | null>(null);
  const currentOutlookRef = useRef<Outlook | null>(null);
  const geolocationRequestRef = useRef(0);
  const geolocationControllerRef = useRef<AbortController | null>(null);

  const invalidateGeolocationRequest = useCallback(() => {
    geolocationRequestRef.current += 1;
    geolocationControllerRef.current?.abort();
    geolocationControllerRef.current = null;
    setLocating(false);
  }, []);

  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = locale;
  }, [locale]);
  const changeLocale = (next: Locale) => { setLocale(next); saveLocale(localStorage, next); };

  useEffect(() => {
    // Hydrate browser-only preference after SSR. Its default matches the server's Turkish document.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocale(readStoredLocale(localStorage));
    try {
      const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (saved) {
        const parsed = parseMonitoredLocation(JSON.parse(saved));
        if (parsed) {
          // Hydrate browser-only storage after SSR to avoid a hydration mismatch.
          setLocation(parsed);
          setInitialAutoCheckLocationKey(`${parsed.latitude},${parsed.longitude}`);
        }
      }
    } catch { /* Storage may be unavailable or contain malformed data; continue without a saved location. */ }
    finally { setStorageReady(true); }
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!storageReady || !location) return;
    const locationKey = `${location.latitude},${location.longitude}`;
    const sameSavedPoint = previousForecastLocationKeyRef.current === locationKey;
    previousForecastLocationKeyRef.current = locationKey;
    const controller = new AbortController();
    const requestId = ++forecastRequestRef.current;
    const isCurrentRequest = () => isCurrentForecastRequest(requestId, forecastRequestRef.current, controller.signal);
    // Clear prior results as this effect synchronizes to a different saved location.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setForecastError(false); setForecast(null); setHours([]);
    if (!sameSavedPoint) {
      forecastRefreshPendingRef.current = false;
      setRefreshingForecast(false);
      setSelectedTime(null);
    }
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
        setForecastError(true); setLoading(false);
        forecastRefreshPendingRef.current = false; setRefreshingForecast(false);
        return;
      }
      currentOutlookRef.current = result;
      setForecast(result); setHours(nextHours);
      setSelectedTime((selected) => retainSelectedHour(sameSavedPoint ? selected : null, nextHours));
      setLoading(false); forecastRefreshPendingRef.current = false; setRefreshingForecast(false);
      if (isGenericFixedOffsetTimezone(result.timezone)) {
        void resolveDisplayTimezone(location.latitude, location.longitude, result.timezone, location.timezone, controller.signal)
          .then((timezone) => {
            if (!isCurrentRequest() || timezone === result.timezone) return;
            const current = currentOutlookRef.current;
            if (!current) return;
            const localized = { ...current, timezone };
            currentOutlookRef.current = localized;
            setForecast(localized);
          });
      }
    }).catch(() => {
      if (isCurrentRequest()) {
        setForecastError(true); setLoading(false);
        forecastRefreshPendingRef.current = false; setRefreshingForecast(false);
      }
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
  }, [forecastRefreshRevision, location, storageReady]);

  const refreshForecast = useCallback(() => {
    const nextRevision = nextForecastRefreshRevision(forecastRefreshRevision, {
      loadingForecast: loading,
      locating,
      refreshPending: forecastRefreshPendingRef.current,
    });
    if (nextRevision === null) return;
    forecastRefreshPendingRef.current = true;
    setRefreshingForecast(true);
    setForecastRefreshRevision(nextRevision);
  }, [forecastRefreshRevision, loading, locating]);

  const requestLocation = useCallback(() => {
    setLocationMessage(null);
    if (!navigator.geolocation) { setLocationMessage("locationUnsupported"); return; }
    geolocationControllerRef.current?.abort();
    geolocationControllerRef.current = null;
    const requestId = ++geolocationRequestRef.current;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (requestId !== geolocationRequestRef.current) return;
      const controller = new AbortController();
      geolocationControllerRef.current = controller;
      void resolveGeolocationSelection(coords.latitude, coords.longitude, controller.signal, (lat, lon, signal) => reverseGeocodeLocation(lat, lon, signal, fetch, locale)).then((selection) => {
        if (!isCurrentGeolocationRequest(requestId, geolocationRequestRef.current, controller.signal)) return;
        try {
          const saved = saveMonitoredLocation(localStorage, selection);
          if (saved) {
            const locationKey = `${saved.latitude},${saved.longitude}`;
            const autoCheckKey = firstLocationAutoCheckKey({ storageReady, currentLocationKey: location ? `${location.latitude},${location.longitude}` : null, initialAutoCheckLocationKey, selectedLocationKey: locationKey });
            if (autoCheckKey) setInitialAutoCheckLocationKey(autoCheckKey);
            else {
              suppressInitialLiveCheckForSession(() => window.sessionStorage);
              setInitialAutoCheckLocationKey(null);
            }
            setLocation(saved);
          }
        } catch {
          setLocationMessage("saveLocationFailed");
        }
      }).catch(() => {
        if (isCurrentGeolocationRequest(requestId, geolocationRequestRef.current, controller.signal)) {
          setLocationMessage("locationFailed");
        }
      }).finally(() => {
        if (isCurrentGeolocationRequest(requestId, geolocationRequestRef.current, controller.signal)) {
          geolocationControllerRef.current = null;
          setLocating(false);
        }
      });
    }, (error) => {
      if (requestId !== geolocationRequestRef.current) return;
      setLocationMessage(locationErrorMessage(error.code)); setLocating(false);
    },
    { enableHighAccuracy: false, maximumAge: 300_000, timeout: 15_000 });
  }, [initialAutoCheckLocationKey, location, locale, storageReady]);

  const openPicker = useCallback(() => {
    invalidateGeolocationRequest();
    setCandidate(location ? { ...location } : null);
    setPickerMode("search"); setSearchQuery(""); setSearchResults([]); setShowAllSearchResults(false); setSearchError(null); setSearchNotice(null); setHasSearched(false); setSearching(false);
    setLocationMessage(null); setPickerOpen(true);
  }, [invalidateGeolocationRequest, location]);

  const submitPlaceSearch = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const coordinateQuery = parseCoordinateQuery(searchQuery);
    if (coordinateQuery.kind === "coordinates") {
      setCandidate({ latitude: coordinateQuery.latitude, longitude: coordinateQuery.longitude, label: "Selected coordinates", source: "search" });
      setSearchError(null); setSearchResults([]); setShowAllSearchResults(false); setSearchNotice(null); setHasSearched(false); setSearching(false);
      return;
    }
    if (coordinateQuery.kind === "invalid") {
      setSearchError("invalidCoordinates");
      setSearchResults([]); setShowAllSearchResults(false); setSearchNotice(null); setHasSearched(false); setSearching(false);
      return;
    }
    if (Array.from(searchQuery.trim()).length < MIN_PLACE_QUERY_LENGTH) { setSearchError("queryTooShort"); setSearchResults([]); setShowAllSearchResults(false); setSearchNotice(null); setHasSearched(false); return; }
    immediateSearchRef.current = true;
    setSearchError(null); setSearchNotice(null); setShowAllSearchResults(false); setSearchRevision((revision) => revision + 1);
  }, [searchQuery]);

  useEffect(() => {
    if (!pickerOpen || pickerMode !== "search") return;
    const query = searchQuery.trim();
    if (parseCoordinateQuery(query).kind !== "not-coordinate") return;
    if (Array.from(query).length < MIN_PLACE_QUERY_LENGTH) return;
    const requestId = ++searchRequestRef.current;
    const controller = new AbortController();
    const delay = immediateSearchRef.current ? 0 : PLACE_SEARCH_DEBOUNCE_MS;
    immediateSearchRef.current = false;
    const timer = window.setTimeout(() => {
      setSearching(true); setSearchError(null);
      void searchPlaces(query, controller.signal, undefined, localeRef.current).then(({ results, fallbackMessageKey }) => {
        if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
        setSearchResults(results); setShowAllSearchResults(false); setSearchNotice(fallbackMessageKey ?? null); setHasSearched(true);
      }).catch(() => {
        if (controller.signal.aborted || requestId !== searchRequestRef.current) return;
        setSearchError("searchUnavailable");
        setSearchResults([]); setShowAllSearchResults(false); setSearchNotice(null); setHasSearched(true);
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
    setSearchQuery(query); setSearchResults([]); setShowAllSearchResults(false); setSearchError(null); setSearchNotice(null); setHasSearched(false); setSearching(false);
    const coordinateQuery = parseCoordinateQuery(query);
    if (coordinateQuery.kind === "coordinates") {
      setCandidate({ latitude: coordinateQuery.latitude, longitude: coordinateQuery.longitude, label: "Selected coordinates", source: "search" });
    } else {
      setCandidate((current) => current?.label === "Selected coordinates" ? null : current);
      if (coordinateQuery.kind === "invalid") setSearchError("invalidCoordinates");
    }
  }, []);

  const switchPickerMode = useCallback((mode: "search" | "map") => {
    setSearching(false); setShowAllSearchResults(false); setPickerMode(mode);
  }, []);

  const selectPlace = useCallback((place: PlaceResult) => {
    reverseControllerRef.current?.abort(); confirmRequestRef.current += 1; setResolvingLocation(false);
    setCandidate(place); setPickerMode("map"); setSearchError(null);
  }, []);

  const pickMapPoint = useCallback((latitude: number, longitude: number) => {
    reverseControllerRef.current?.abort(); confirmRequestRef.current += 1; setResolvingLocation(false);
    setCandidate({ ...reduceLocationPrecision(latitude, longitude), source: "map" });
  }, []);

  const cancelPicker = useCallback(() => {
    searchRequestRef.current += 1; confirmRequestRef.current += 1; reverseControllerRef.current?.abort();
    setPickerOpen(false); setCandidate(null); setSearchError(null); setSearchNotice(null); setSearchResults([]); setShowAllSearchResults(false); setSearching(false); setResolvingLocation(false);
  }, []);

  const confirmCandidate = useCallback(async () => {
    if (!candidate || resolvingLocation) return;
    const requestId = ++confirmRequestRef.current;
    const controller = new AbortController();
    reverseControllerRef.current = controller;
    setResolvingLocation(true); setLocationMessage(null);
    let selection = candidate;
    if (candidate.source === "map") {
      try {
        const metadata = await reverseGeocodeLocation(candidate.latitude, candidate.longitude, controller.signal, fetch, locale);
        if (metadata) selection = { ...candidate, ...metadata };
      } catch {
        if (controller.signal.aborted || requestId !== confirmRequestRef.current) return;
      }
    }
    if (controller.signal.aborted || requestId !== confirmRequestRef.current) return;
    try {
      const saved = saveMonitoredLocation(localStorage, selection);
      if (!saved) return;
      const locationKey = `${saved.latitude},${saved.longitude}`;
      const autoCheckKey = firstLocationAutoCheckKey({ storageReady, currentLocationKey: location ? `${location.latitude},${location.longitude}` : null, initialAutoCheckLocationKey, selectedLocationKey: locationKey });
      if (autoCheckKey) setInitialAutoCheckLocationKey(autoCheckKey);
      else {
        suppressInitialLiveCheckForSession(() => window.sessionStorage);
        setInitialAutoCheckLocationKey(null);
      }
      setLocation(saved); setLocationMessage(null); setPickerOpen(false); setCandidate(null);
    } catch {
      setLocationMessage("saveSelectionFailed");
    } finally {
      if (requestId === confirmRequestRef.current) setResolvingLocation(false);
    }
  }, [candidate, initialAutoCheckLocationKey, location, locale, resolvingLocation, storageReady]);

  const highestWindow = useMemo(() => calculateStrongestSignalWindow(hours), [hours]);
  const visibleSearchResults = visiblePlaceResults(searchResults, showAllSearchResults);
  const selected = hours.find((hour) => hour.time === selectedTime) ?? hours[0];
  const forecastContext: ForecastContext | null = forecast && !loading ? {
    risk: highestWindow?.risk ?? "low",
    headline: forecastHeadline(locale, highestWindow?.risk ?? "low"),
    summary: summarizeSignal(highestWindow, highestWindow ? period(highestWindow.start, highestWindow.end, forecast.timezone, locale) : "", locale),
    strongestWindow: highestWindow ? period(highestWindow.start, highestWindow.end, forecast.timezone, locale) : null,
  } : null;
  const locationPicker = pickerOpen && <section className="location-picker" aria-label={t(locale, "choosePoint")}>
    <div className="picker-heading"><div><p className="eyebrow">{t(locale, "location")}</p><h2>{t(locale, "choosePoint")}</h2></div><button className="text-button" type="button" onClick={cancelPicker}>{t(locale, "cancel")}</button></div>
    <div className="picker-tabs" role="group" aria-label={t(locale, "choosePoint")}>
      <button className={`secondary-button ${pickerMode === "search" ? "is-active" : ""}`} type="button" aria-pressed={pickerMode === "search"} disabled={resolvingLocation} onClick={() => switchPickerMode("search")}>{t(locale, "searchPlace")}</button>
      <button className={`secondary-button ${pickerMode === "map" ? "is-active" : ""}`} type="button" aria-pressed={pickerMode === "map"} disabled={resolvingLocation} onClick={() => switchPickerMode("map")}>{t(locale, "pickOnMap")}</button>
    </div>
    {pickerMode === "search" ? <>
      <form className="place-search" onSubmit={submitPlaceSearch}>
        <label className="visually-hidden" htmlFor="place-search">{t(locale, "searchPlace")}</label>
        <input id="place-search" type="search" value={searchQuery} onChange={(event) => changeSearchQuery(event.target.value)} placeholder={t(locale, "searchPlaceholder")} autoComplete="off" />
        <button className="secondary-button" type="submit">{searching ? t(locale, "searching") : t(locale, "search")}</button>
      </form>
      {searchError && <p className="inline-error" role="alert">{t(locale, searchError, { count: MIN_PLACE_QUERY_LENGTH })}</p>}
      {searching && <p className="picker-note" role="status">{t(locale, "searchingPlaces")}</p>}
      {searchNotice && <p className="picker-note" role="status">{t(locale, searchNotice)}</p>}
      {!searching && hasSearched && !searchError && searchResults.length === 0 && <p className="picker-note" role="status">{t(locale, "noPlaces")}</p>}
      {searchResults.length > 0 && <ul className="place-results" aria-label={t(locale, "search")}>{visibleSearchResults.map((place, index) => <li key={`${place.latitude}:${place.longitude}:${index}`}>
        <button type="button" onClick={() => selectPlace(place)}><strong>{place.label}</strong><span>{[place.admin1, place.country].filter(Boolean).join(", ") || formatCoordinates(place.latitude, place.longitude)}</span></button>
      </li>)}</ul>}
      {searchResults.length > INITIAL_VISIBLE_PLACE_RESULTS && !showAllSearchResults && <button className="text-button" type="button" onClick={() => setShowAllSearchResults(true)}>{t(locale, "showMore")}</button>}
    </> : <>
      <p className="picker-note">{t(locale, "mapInstruction")}</p>
      <LocationMap candidate={candidate} onPick={pickMapPoint} locale={locale} />
      <p className="picker-note">{t(locale, "mapAttribution")}</p>
    </>}
    {candidate && <div className="candidate-row"><p><strong>{visibleLocationLabel(candidate, locale)}</strong><span>{displayLocationCoordinates(candidate)}</span></p><button className="primary-button" type="button" onClick={() => void confirmCandidate()} disabled={resolvingLocation}>{resolvingLocation ? candidate.source === "map" ? t(locale, "findingPlace") : t(locale, "savingLocation") : t(locale, "useThisLocation")}</button></div>}
    {candidate?.source === "map" && <p className="picker-note">{t(locale, "mapPrivacy")}</p>}
  </section>;

  if (!storageReady) return <main className="page-shell"><div className="loading-state" role="status">{t(locale, "openingForecast")}</div></main>;

  return <main className="page-shell">
    <header className="topbar">
      <Link className="brand" href="/" aria-label={t(locale, "brandHome")}><span className="brand-mark" aria-hidden="true">↯</span><span>LIGHTNING <b>NEARBY</b></span></Link>
      <div className="topbar-tools"><div className="locale-switch" role="group" aria-label="Language / Dil">
        <button type="button" lang="tr" aria-pressed={locale === "tr"} onClick={() => changeLocale("tr")}>TR</button><span aria-hidden="true">/</span><button type="button" lang="en" aria-pressed={locale === "en"} onClick={() => changeLocale("en")}>EN</button>
      </div><span className="edition">{t(locale, "edition")} <span aria-hidden="true">·</span> {t(locale, "editionPeriod")}</span></div>
    </header>

    {!location ? <section className="welcome-panel" aria-labelledby="welcome-title">
      <p className="eyebrow">{t(locale, "welcomeEyebrow")}</p>
      <h1 id="welcome-title">{t(locale, "welcomeTitle")}<br /><em>{t(locale, "welcomeEmphasis")}</em></h1>
      <p className="welcome-copy">{t(locale, "welcomeCopy")}</p>
      <button className="primary-button" type="button" onClick={requestLocation} disabled={locating}><span aria-hidden="true">⌖</span>{locating ? t(locale, "findingLocation") : t(locale, "useMyLocation")}</button>
      <button className="text-button picker-open-button" type="button" onClick={openPicker}>{t(locale, "openPicker")}</button>
      {locationPicker}
      {locationMessage && <p className="inline-error" role="alert">{t(locale, locationMessage)}</p>}
      <p className="permission-note">{t(locale, "permissionNote")}</p>
      <div className="welcome-rule" /><p className="micro-copy">{t(locale, "disclaimerShort")}</p>
    </section> : <section className="overview" aria-labelledby="overview-title">
      <div className="location-line"><div><p className="eyebrow">{t(locale, "monitoredLocation")}</p><p className="coordinates">{location.label || location.country ? visibleLocationLabel(location, locale) : formatCoordinates(location.latitude, location.longitude)}</p>{(location.label || location.country) && <p className="location-coordinates">{displayLocationCoordinates(location)}</p>}</div>
        <div className="location-actions">
          <button className="text-button" type="button" onClick={refreshForecast} disabled={loading || locating || refreshingForecast}>{refreshingForecast ? t(locale, "refreshing") : t(locale, "refreshForecast")}</button>
          <button className="text-button" type="button" onClick={requestLocation} disabled={locating}>{locating ? t(locale, "locating") : t(locale, "useCurrentLocation")}</button>
          <button className="text-button" type="button" onClick={openPicker}>{t(locale, "searchMap")}</button>
        </div></div>
      {locationPicker}
      {locationMessage && <p className="inline-error" role="alert">{t(locale, locationMessage)}</p>}
      {loading && <div className="loading-state" role="status">{t(locale, "gettingForecast")}</div>}
      {forecastError && !loading && <div className="error-panel" role="alert"><div><strong>{t(locale, "forecastUnavailable")}</strong><p>{t(locale, "forecastError")}</p></div><button className="secondary-button" type="button" onClick={() => setLocation({ ...location })}>{t(locale, "tryAgain")}</button></div>}
      <LiveObservation key={`${location.latitude},${location.longitude}`} latitude={location.latitude} longitude={location.longitude} forecast={forecastContext} locale={locale} autoCheckEligible={isInitialLiveCheckEligible({ storageReady, hasLocation: true, isFirstLocationForSession: initialAutoCheckLocationKey === `${location.latitude},${location.longitude}` })} />
      {forecast && !loading && <>
        <TodayBriefing daily={forecast.daily} timezone={forecast.timezone} currentTemperatureC={forecast.currentTemperatureC} locale={locale} />
        <section className="timeline-section" aria-labelledby="timeline-title">
          <div className="section-heading"><div><p className="eyebrow">{t(locale, "hoursAhead")}</p><h2 id="timeline-title">{t(locale, "hourlyOutlook")}</h2></div><span className="timezone-label">{t(locale, "localTime")}</span></div>
          <p className="timeline-instruction">{t(locale, "timelineInstruction")}</p>
          <div className="timeline-scroll" role="group" aria-label={t(locale, "timelineScroll")}><ol className="timeline">
            {hours.map((hour, index) => {
              const previous = hours[index - 1];
              const showDate = index === 0 || !previous || localDateKey(previous.time, forecast.timezone) !== localDateKey(hour.time, forecast.timezone);
              const isSelected = selectedTime === hour.time;
              return <li key={hour.time} className={`hour-slot ${isSelected ? "is-selected" : ""}`}>
                {showDate && <span className="day-label">{dayLabel(hour.time, forecast.timezone, locale)}</span>}
                <button type="button" className={`hour-button ${hour.signal.kind === "qualitative" ? `risk-${hour.signal.risk}` : ""}`} aria-pressed={isSelected} aria-label={`${localTime(hour.time, forecast.timezone, locale)}, ${hour.signal.kind === "qualitative" ? t(locale, "hourRisk", { risk: riskLabel(locale, hour.signal.risk) }) : t(locale, "signalUnavailable")}`} onClick={() => setSelectedTime(hour.time)}>
                  <span className="hour-time">{localTime(hour.time, forecast.timezone, locale).slice(0, 2)}</span><span className="risk-bar" aria-hidden="true"><span /></span><span className="hour-risk">{hour.signal.kind === "qualitative" ? riskLabel(locale, hour.signal.risk) : "—"}</span>
                </button>
              </li>;
            })}
          </ol></div>
          <div className="legend" aria-label={t(locale, "riskLegend")}><span><i className="legend-dot low" />{t(locale, "low")}</span><span><i className="legend-dot elevated" />{t(locale, "elevated")}</span><span><i className="legend-dot high" />{t(locale, "high")}</span><span className="derived-label">{t(locale, "derivedOutlook")}</span></div>
        </section>
        {selected && <section className="details-section" aria-live="polite" aria-labelledby="details-title">
          <div className="details-top"><div><p className="eyebrow">{t(locale, "selectedHour")}</p><h2 id="details-title">{dayLabel(selected.time, forecast.timezone, locale)} · {localTime(selected.time, forecast.timezone, locale)}</h2></div>{selected.signal.kind === "qualitative" && <span className={`small-risk risk-${selected.signal.risk}`}>{riskLabel(locale, selected.signal.risk)}</span>}</div>
          <p className="details-note">{t(locale, "forecastValues")}</p>
          <dl className="forecast-values">
            {selected.weatherCode != null && <div><dt>{t(locale, "weather")}</dt><dd>{describeWeatherCode(selected.weatherCode, locale)}</dd></div>}
            {selected.evidence.providerProbability != null && <div><dt>{t(locale, "thunderstormProbability")}</dt><dd>{Math.round(selected.evidence.providerProbability)}% · {t(locale, "providerValue")}</dd></div>}
            {selected.evidence.ensemble && selected.evidence.ensemble.supportingMembers > 0 && <div><dt>{t(locale, "nearbyModelSupport")}</dt><dd>{t(locale, "present")}</dd></div>}
            {selected.precipitationProbability != null && <div><dt>{t(locale, "precipitationChance")}</dt><dd>{Math.round(selected.precipitationProbability)}%</dd></div>}
          </dl>
          <p className="classification-note">{selected.signal.kind === "unavailable" ? t(locale, "insufficientHour") : isThunderstormCode(selected.weatherCode) && selected.evidence.providerProbability != null && selected.evidence.providerProbability < RISK_THRESHOLDS.directThunderstormProbabilityElevated ? t(locale, "contradictoryForecast") : t(locale, "classificationNote")}</p>
        </section>}
        <div className="update-line">{t(locale, "forecastUpdated", { time: formatClock(forecast.fetchedAt, forecast.timezone, locale) })}</div>
      </>}
    </section>}

    <footer className="disclaimer"><span className="disclaimer-mark" aria-hidden="true">i</span><p><strong>{t(locale, "disclaimerLead")}</strong> {t(locale, "disclaimerBody")}</p></footer>
    <div className="footer-meta"><span>{t(locale, "weatherBy")} <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open‑Meteo</a>{location && <> · {t(locale, "poweredBy")} <a href="https://www.xweather.com/" target="_blank" rel="noreferrer">Vaisala Xweather</a></>}</span><span>{t(locale, "privacyFooter")}</span><nav className="footer-debug-links" aria-label={t(locale, "developerPages")}><a href="/debug/forecast">{t(locale, "forecastDebug")}</a><a href="/debug/lightning">{t(locale, "lightningDebug")}</a></nav></div>
  </main>;
}
