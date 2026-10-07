"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import { ACTIVITY_MAP_MAX_ZOOM, ACTIVITY_MAP_MIN_ZOOM, activityEventMarkerStyle, activityMapInteraction, type ActivityMapData } from "@/lib/live-activity";
import { t, type Locale } from "@/lib/i18n";

export default function LiveActivityMap({ data, locale }: { data: ActivityMapData; locale: Locale }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [panningEnabled, setPanningEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    void import("leaflet").then(L => {
      if (cancelled) return;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      setCoarsePointer(coarse);
      const map = L.map(container, {
        ...activityMapInteraction(coarse),
        zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
        minZoom: ACTIVITY_MAP_MIN_ZOOM, maxZoom: ACTIVITY_MAP_MAX_ZOOM,
      });
      mapRef.current = map;
      leafletRef.current = L;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !coarsePointer) return;
    if (panningEnabled) map.dragging.enable();
    else map.dragging.disable();
  }, [coarsePointer, panningEnabled, ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layers = layerRef.current;
    if (!ready || !L || !map || !layers) return;
    layers.clearLayers();
    const locationIcon = L.divIcon({ className: "activity-location-marker", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9] });
    for (const item of data.events.filter(item => !item.nearest)) {
      L.circleMarker(item.point, activityEventMarkerStyle(item.distanceKm, false).options).addTo(layers);
    }
    L.marker(data.monitored, { icon: locationIcon, interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(layers);
    const nearest = data.events.find(item => item.nearest);
    if (nearest) {
      const style = activityEventMarkerStyle(nearest.distanceKm, true);
      L.circleMarker(nearest.point, { radius: style.options.radius + 4, color: "#ffffff", weight: 0,
        fillColor: "#ffffff", fillOpacity: .45, interactive: false }).addTo(layers);
      L.circleMarker(nearest.point, style.options).addTo(layers);
    }
    map.invalidateSize({ animate: false, pan: false });
    map.fitBounds(data.bounds, { padding: [30, 30], maxZoom: ACTIVITY_MAP_MAX_ZOOM, animate: false });
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false, pan: false }));
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [data, ready]);

  return <figure className="activity-map">
    <div className="activity-map-frame">
      {!ready && !error && <p className="activity-map-status" role="status">{t(locale, "mapLoading")}</p>}
      {error && <p className="activity-map-status" role="status">{t(locale, "activityMapError")}</p>}
      <div ref={containerRef} className={`activity-map-canvas${panningEnabled && coarsePointer ? " is-panning" : ""}`} role="group" aria-label={t(locale, "activityMapLabel", { count: data.events.length })} />
      {ready && coarsePointer && <button type="button" className="activity-map-pan-toggle" aria-pressed={panningEnabled}
        onClick={() => setPanningEnabled(enabled => !enabled)}>{t(locale, panningEnabled ? "activityMapPanOff" : "activityMapPanOn")}</button>}
    </div>
    <figcaption>
      <span><i className="activity-key-location" aria-hidden="true" />{t(locale, "activityMapLocation")}</span>
      <span><i className="activity-key-nearest" aria-hidden="true" />{t(locale, "activityMapNearest")}</span>
      {data.events.length > 1 && <span><i className="activity-key-other" aria-hidden="true" />{t(locale, "activityMapOther")}</span>}
    </figcaption>
  </figure>;
}
