"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import type { LocationSelection } from "@/lib/location";

interface LocationMapProps {
  candidate: LocationSelection | null;
  onPick: (latitude: number, longitude: number) => void;
}

export default function LocationMap({ candidate, onPick }: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markerRef = useRef<Leaflet.Marker | null>(null);
  const onPickRef = useRef(onPick);
  const [mapError, setMapError] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  useEffect(() => {
    let cancelled = false;
    let resizeTimer: number | null = null;
    const container = containerRef.current;
    if (!container) return;
    void import("leaflet").then((L) => {
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      const initialCenter: Leaflet.LatLngExpression = candidate ? [candidate.latitude, candidate.longitude] : [20, 0];
      const map = L.map(container, { zoomControl: true, scrollWheelZoom: false })
        .setView(initialCenter, candidate ? 12 : 2);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
      }).addTo(map);
      const icon = L.divIcon({ className: "location-marker-icon", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });
      map.on("click", (event) => onPickRef.current(event.latlng.lat, event.latlng.lng));
      mapRef.current = map;
      markerRef.current = candidate ? L.marker(initialCenter, { icon }).addTo(map) : null;
      setMapReady(true);
      resizeTimer = window.setTimeout(() => { if (!cancelled) map.invalidateSize(); }, 0);
    }).catch(() => setMapError(true));

    return () => {
      cancelled = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      leafletRef.current = null;
      setMapReady(false);
    };
  // Initialize once for each mount; candidate changes are reflected by the marker effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !candidate) return;
    const point: Leaflet.LatLngExpression = [candidate.latitude, candidate.longitude];
    if (!markerRef.current) {
      const icon = L.divIcon({ className: "location-marker-icon", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });
      markerRef.current = L.marker(point, { icon }).addTo(map);
    } else markerRef.current.setLatLng(point);
    map.setView(point, Math.max(map.getZoom(), 12), { animate: false });
  }, [candidate]);

  return <div className="map-frame">
    {!mapReady && !mapError && <p className="map-status" role="status">Loading map…</p>}
    {mapError && <p className="inline-error" role="alert">The map could not be loaded. You can still search for a place.</p>}
    <div ref={containerRef} className="map-canvas" aria-label="Choose a location on the map" />
  </div>;
}
