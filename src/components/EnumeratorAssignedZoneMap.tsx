import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { Circle, CircleMarker, GeoJSON, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { EyeOff, LocateFixed, MapPinned, Navigation } from 'lucide-react';
import type { ZonePolygon } from '../types';
import { zonesToGeoJson } from '../lib/assignedZones';
import {
  ASSIGNED_ZONE_BUFFER_METERS,
  findZoneWithinDistance,
} from '../lib/pointInPolygon';
import { useGeoLocation } from './GeoLocationProvider';

const FitAssignedZones: React.FC<{ zones: ZonePolygon[] }> = ({ zones }) => {
  const map = useMap();

  useEffect(() => {
    if (!zones.length) return;
    const collection = zonesToGeoJson(zones);
    const bounds = L.geoJSON(collection).getBounds();
    if (!bounds.isValid()) return;
    const timer = window.setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [map, zones]);

  return null;
};

const FocusCurrentLocation: React.FC<{
  location: { lat: number; lng: number } | null;
  requestKey: number;
}> = ({ location, requestKey }) => {
  const map = useMap();

  useEffect(() => {
    if (!location || requestKey === 0) return;
    map.setView([location.lat, location.lng], Math.max(map.getZoom(), 17));
  }, [location, map, requestKey]);

  return null;
};

export const EnumeratorAssignedZoneMap: React.FC<{
  zones: ZonePolygon[];
  onHide: () => void;
}> = ({ zones, onHide }) => {
  const { location, error, requestLocation } = useGeoLocation();
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const zoneGeoJson = useMemo(() => zonesToGeoJson(zones), [zones]);
  const zoneProximity = useMemo(
    () =>
      location
        ? findZoneWithinDistance(
            location.lng,
            location.lat,
            zones,
            ASSIGNED_ZONE_BUFFER_METERS
          )
        : null,
    [location, zones]
  );

  const focusLocation = () => {
    requestLocation();
    setFocusRequestKey((key) => key + 1);
  };

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-sky-100 bg-sky-50/80 px-4 py-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white">
          <MapPinned size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-slate-900">Your assigned survey zone</h2>
          <p className="text-[11px] leading-relaxed text-slate-600">
            Submit inside the outlined boundary as usual, or up to {ASSIGNED_ZONE_BUFFER_METERS} m
            outside it.
          </p>
        </div>
        <button
          type="button"
          onClick={onHide}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-600 hover:bg-white"
        >
          <EyeOff size={14} />
          Hide map
        </button>
      </div>

      {zones.length > 0 ? (
        <>
          <div className="relative h-72 w-full sm:h-80">
            <MapContainer
              center={[23.7, 90.4]}
              zoom={7}
              className="h-full w-full"
              zoomControl
              attributionControl
            >
              <TileLayer
                attribution="Tiles &copy; Esri"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              />
              <GeoJSON
                key={zones.map((zone) => zone.id).join(':')}
                data={zoneGeoJson}
                style={{
                  color: '#0ea5e9',
                  weight: 3,
                  opacity: 1,
                  fillColor: '#38bdf8',
                  fillOpacity: 0.15,
                }}
                onEachFeature={(feature, layer) => {
                  const label = String(feature.properties?.__label || '').trim();
                  if (label) layer.bindTooltip(label, { sticky: true });
                }}
              />
              <FitAssignedZones zones={zones} />
              <FocusCurrentLocation location={location} requestKey={focusRequestKey} />
              {location && (
                <>
                  <Circle
                    center={[location.lat, location.lng]}
                    radius={Math.max(location.accuracy || 0, 3)}
                    pathOptions={{
                      color: zoneProximity ? '#16a34a' : '#dc2626',
                      fillColor: zoneProximity ? '#22c55e' : '#ef4444',
                      fillOpacity: 0.12,
                      weight: 1,
                    }}
                  />
                  <CircleMarker
                    center={[location.lat, location.lng]}
                    radius={8}
                    pathOptions={{
                      color: '#ffffff',
                      fillColor: zoneProximity ? '#16a34a' : '#dc2626',
                      fillOpacity: 1,
                      weight: 3,
                    }}
                  >
                    <Tooltip permanent direction="top" offset={[0, -10]}>
                      Your location
                    </Tooltip>
                  </CircleMarker>
                </>
              )}
            </MapContainer>
            <button
              type="button"
              onClick={focusLocation}
              className="absolute bottom-3 right-3 z-[500] inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-bold text-sky-700 shadow-lg ring-1 ring-slate-200 hover:bg-sky-50"
            >
              <LocateFixed size={15} />
              My location
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-xs">
            <span className="text-slate-500">
              {zones.length} assigned zone{zones.length === 1 ? '' : 's'}
            </span>
            {location ? (
              <span
                className={`inline-flex items-center gap-1.5 font-semibold ${
                  zoneProximity ? 'text-green-700' : 'text-red-700'
                }`}
              >
                <Navigation size={13} />
                {zoneProximity?.inside
                  ? 'You are inside your assigned zone'
                  : zoneProximity
                    ? `You are within the ${ASSIGNED_ZONE_BUFFER_METERS} m boundary buffer`
                    : `You are more than ${ASSIGNED_ZONE_BUFFER_METERS} m outside your assigned zone`}
              </span>
            ) : (
              <button
                type="button"
                onClick={focusLocation}
                className="font-semibold text-sky-700 hover:text-sky-900"
              >
                Show my current location
              </button>
            )}
          </div>
          {error && !location && (
            <p className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
              Location unavailable: {error}
            </p>
          )}
        </>
      ) : (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          Loading your assigned zone boundary…
        </div>
      )}
    </section>
  );
};
