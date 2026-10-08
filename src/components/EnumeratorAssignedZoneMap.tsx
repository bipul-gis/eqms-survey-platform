import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { Circle, CircleMarker, GeoJSON, MapContainer, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { EyeOff, Loader2, LocateFixed, MapPin, MapPinned, Navigation } from 'lucide-react';
import type { ZonePolygon } from '../types';
import { zonesToGeoJson } from '../lib/assignedZones';
import {
  ASSIGNED_ZONE_BUFFER_METERS,
  findZoneWithinDistance,
} from '../lib/pointInPolygon';
import { useGeoLocation } from './GeoLocationProvider';
import type { SurveyLocationPoint } from '../hooks/useQuestionnaireSurveyLocations';
import { DEFAULT_MAP_LAYER_STYLE, mapLayerStyleKey, type MapLayerStyle } from '../lib/mapLayerSettings';

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

const SURVEY_POINT_FILL = '#374151';
const SURVEY_POINT_OUTLINE_BY_STATUS: Record<string, string> = {
  draft: '#9ca3af',
  submitted: '#111827',
  reviewed: '#16a34a',
};

function formatSurveyTimestamp(value: unknown): string {
  if (!value) return '-';
  try {
    if (typeof value === 'object' && value && typeof (value as any).toDate === 'function') {
      return (value as any).toDate().toLocaleString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    }
  } catch {
    /* ignore */
  }
  return '-';
}

const SurveyPointMarker: React.FC<{ point: SurveyLocationPoint }> = React.memo(({ point }) => {
  const status = point.status || 'submitted';
  const outline = SURVEY_POINT_OUTLINE_BY_STATUS[status] || SURVEY_POINT_OUTLINE_BY_STATUS.submitted;
  const when = formatSurveyTimestamp(point.submittedAt || point.capturedAt);
  return (
    <CircleMarker
      center={[point.lat, point.lng]}
      radius={6}
      pathOptions={{
        color: outline,
        fillColor: SURVEY_POINT_FILL,
        fillOpacity: 0.9,
        weight: 2,
      }}
    >
      <Popup>
        <div className="min-w-[210px]">
          <div className="mb-2 border-b border-slate-200 pb-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-600">
              Surveyed point
            </p>
            <p className="text-sm font-bold capitalize text-slate-900">{status}</p>
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-1 pr-2 font-semibold text-slate-600">Lat</td>
                <td className="py-1 font-mono text-slate-800">{point.lat.toFixed(6)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1 pr-2 font-semibold text-slate-600">Lng</td>
                <td className="py-1 font-mono text-slate-800">{point.lng.toFixed(6)}</td>
              </tr>
              {typeof point.accuracy === 'number' ? (
                <tr className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-semibold text-slate-600">Accuracy</td>
                  <td className="py-1 text-slate-800">+/- {Math.round(point.accuracy)} m</td>
                </tr>
              ) : null}
              <tr>
                <td className="py-1 pr-2 font-semibold text-slate-600">When</td>
                <td className="py-1 text-slate-800">{when}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Popup>
    </CircleMarker>
  );
});
SurveyPointMarker.displayName = 'SurveyPointMarker';

export const EnumeratorAssignedZoneMap: React.FC<{
  zones: ZonePolygon[];
  onHide: () => void;
  surveyLocations?: SurveyLocationPoint[];
  surveyLocationsLoading?: boolean;
  surveyLocationsError?: Error | null;
  projectMapLayerStyles?: Record<string, MapLayerStyle>;
  projectMapLayerStylesByProject?: Record<string, Record<string, MapLayerStyle>>;
  bufferMeters?: number;
}> = ({ zones, onHide, surveyLocations, surveyLocationsLoading = false, surveyLocationsError, projectMapLayerStyles = {}, projectMapLayerStylesByProject = {}, bufferMeters = ASSIGNED_ZONE_BUFFER_METERS }) => {
  const { location, error, requestLocation } = useGeoLocation();
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [showSurveyLocations, setShowSurveyLocations] = useState(true);
  const zoneGeoJson = useMemo(() => zonesToGeoJson(zones), [zones]);
  const zoneStyleFor = (projectId: string, layerId: string) => {
    const projectStyles = projectMapLayerStylesByProject[projectId];
    const savedStyle = projectStyles?.[mapLayerStyleKey('zone', layerId)]
      ?? projectMapLayerStyles[mapLayerStyleKey('zone', layerId)];
    const style = { ...DEFAULT_MAP_LAYER_STYLE, labelsVisible: true, ...savedStyle };
    const baseWeight = Math.max(0.5, Number(style.borderWidth ?? 2));
    const hoverWeight = Math.max(1, baseWeight + 2);
    return {
      base: { color: style.boundaryColor, weight: baseWeight, opacity: 1, fillColor: style.fillColor, fillOpacity: style.opacity } as L.PathOptions,
      hover: { color: style.boundaryColor, weight: hoverWeight, opacity: 1, fillColor: style.fillColor, fillOpacity: Math.min(1, style.opacity + 0.18) } as L.PathOptions,
      labelsVisible: style.labelsVisible,
      labelField: style.labelField,
      labelColor: style.labelColor,
      haloColor: style.haloColor,
      fontSize: style.fontSize,
      borderWidth: baseWeight,
    };
  };
  const scopedSurveyLocations = useMemo(
    () =>
      (surveyLocations || []).filter((point) =>
        findZoneWithinDistance(
          point.lng,
          point.lat,
          zones,
          bufferMeters
        )
      ),
    [surveyLocations, zones, bufferMeters]
  );
  const zoneProximity = useMemo(
    () =>
      location
        ? findZoneWithinDistance(
            location.lng,
            location.lat,
            zones,
            bufferMeters
          )
        : null,
    [location, zones, bufferMeters]
  );

  const focusLocation = () => {
    requestLocation();
    setFocusRequestKey((key) => key + 1);
  };

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm">
      <div className="border-b border-sky-100 bg-sky-50/80 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white">
            <MapPinned size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h2 className="truncate text-sm font-bold leading-tight text-slate-900">
              Your assigned survey zone
              </h2>
              <button
                type="button"
                onClick={onHide}
                className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-white"
                aria-label="Hide map"
                title="Hide map"
              >
                <EyeOff size={15} />
                <span>Hide map</span>
              </button>
            </div>
            <p className="mt-0.5 text-[11px] leading-tight text-slate-600">
              Stay within {bufferMeters} m buffer of assigned boundary.
            </p>
          </div>
        </div>
      </div>

      {zones.length > 0 ? (
        <>
          <div className="relative h-72 w-full sm:h-80">
            {Array.isArray(surveyLocations) && (
              <label className="absolute right-3 top-3 z-[500] inline-flex max-w-[calc(100%-5.5rem)] items-center gap-1.5 whitespace-nowrap rounded-lg bg-white px-2.5 py-2 text-xs font-bold text-slate-700 shadow-lg ring-1 ring-slate-200">
                <input
                  type="checkbox"
                  checked={showSurveyLocations}
                  onChange={(e) => setShowSurveyLocations(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {surveyLocationsLoading ? (
                  <Loader2 size={13} className="animate-spin text-sky-700" />
                ) : (
                  <MapPin size={13} className="text-slate-600" />
                )}
                <span className="truncate">Survey points ({scopedSurveyLocations.length})</span>
              </label>
            )}
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
                key={`${zones.map((zone) => zone.id).join(':')}:${JSON.stringify(projectMapLayerStylesByProject)}:${JSON.stringify(projectMapLayerStyles)}`}
                data={zoneGeoJson}
                style={(feature) => {
                  const properties = feature?.properties || {};
                  return zoneStyleFor(String(properties.__projectId || ''), String(properties.__layerId || '')).base;
                }}
                onEachFeature={(feature, layer) => {
                  const properties = feature.properties || {};
                  const layerStyle = zoneStyleFor(String(properties.__projectId || ''), String(properties.__layerId || ''));
                  const rawLabel = String((layerStyle.labelField && properties[layerStyle.labelField]) || properties.__label || '').trim();
                  if (layerStyle.labelsVisible && rawLabel) {
                    const textColor = /^#[0-9a-f]{6}$/i.test(layerStyle.labelColor) ? layerStyle.labelColor : '#0f172a';
                    const outlineColor = /^#[0-9a-f]{6}$/i.test(layerStyle.haloColor) ? layerStyle.haloColor : '#ffffff';
                    const safeSize = Math.min(48, Math.max(4, Number(layerStyle.fontSize) || 11));
                    const haloShadow = [
                      `-1.5px -1.5px 0 ${outlineColor}`, `0 -1.5px 0 ${outlineColor}`, `1.5px -1.5px 0 ${outlineColor}`,
                      `-1.5px 0 0 ${outlineColor}`, `1.5px 0 0 ${outlineColor}`,
                      `-1.5px 1.5px 0 ${outlineColor}`, `0 1.5px 0 ${outlineColor}`, `1.5px 1.5px 0 ${outlineColor}`,
                    ].join(', ');
                    const escaped = rawLabel.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
                    const content = `<span style="color:${textColor};font-size:${safeSize}px;text-shadow:${haloShadow}">${escaped}</span>`;
                    layer.bindTooltip(content, {
                      permanent: true,
                      direction: 'center',
                      className: 'zone-label',
                      opacity: 1,
                    });
                  }
                  layer.on({
                    mouseover: (e) => {
                      const target = e.target as L.Path;
                      target.setStyle(layerStyle.hover);
                      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                        target.bringToFront();
                      }
                    },
                    mouseout: (e) => {
                      (e.target as L.Path).setStyle(layerStyle.base);
                    },
                    click: (e) => {
                      L.DomEvent.stopPropagation(e);
                    },
                  });
                }}
              />
              <FitAssignedZones zones={zones} />
              <FocusCurrentLocation location={location} requestKey={focusRequestKey} />
              {showSurveyLocations &&
                scopedSurveyLocations.map((point) => (
                  <SurveyPointMarker key={`assigned_survey_point_${point.id}`} point={point} />
                ))}
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
            <div className="flex flex-wrap items-center gap-2 text-slate-500">
              <span>
                {zones.length} assigned zone{zones.length === 1 ? '' : 's'}
              </span>
              {Array.isArray(surveyLocations) && (
                <span>
                  {scopedSurveyLocations.length} surveyed point
                  {scopedSurveyLocations.length === 1 ? '' : 's'}
                  {!showSurveyLocations ? ' hidden' : ''}
                </span>
              )}
            </div>
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
                  ? `You are within the ${bufferMeters} m boundary buffer`
                    : `You are more than ${bufferMeters} m outside your assigned zone`}
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
          {surveyLocationsError && (
            <p className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
              Survey locations unavailable: {surveyLocationsError.message}
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
