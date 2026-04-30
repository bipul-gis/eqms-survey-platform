import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Polygon, useMapEvents, Circle, CircleMarker, GeoJSON, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { GeoFeature } from '../types';
import { useGeoLocation } from './GeoLocationProvider';
import { useAuth } from './AuthProvider';
import { db } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { MapPin, Navigation, Info, Layers, Plus, Minus } from 'lucide-react';
import landmarkGeoJsonUrl from '../data/CCC_all_Landmark.geojson?url';
import { staticLandmarkMatchesAssignedWards, wardMatchesAssignedList } from '../lib/wardGeometry';

const LANDMARK_ICON_SCALE_KEY = 'eqms_geosurvey_landmark_icon_scale_v1';
const LANDMARK_ATTRIBUTE_ORDER = ['FID', 'name', 'Category', 'Type', 'Ownership', 'Ward_Name', 'Zone'] as const;

const clampScale = (n: number) => Math.min(2.4, Math.max(0.6, Math.round(n * 10) / 10));

const readStoredLandmarkIconScale = (): number => {
  try {
    const raw = localStorage.getItem(LANDMARK_ICON_SCALE_KEY);
    if (!raw) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return clampScale(n);
  } catch {
    return 1;
  }
};

const normalizeLandmarkAttributesForDisplay = (attrs: Record<string, any>) => {
  const normalized: Record<string, any> = {
    FID: attrs?.FID ?? '',
    name: attrs?.name ?? attrs?.Name ?? '',
    Category: attrs?.Category ?? '',
    Type: attrs?.Type ?? '',
    Ownership: attrs?.Ownership ?? '',
    Ward_Name: attrs?.Ward_Name ?? attrs?.WARDNAME ?? attrs?.WardName ?? '',
    Zone: attrs?.Zone ?? ''
  };

  const seen = new Set<string>(Object.keys(normalized));
  const extra = Object.entries(attrs || {})
    .filter(([k]) => !seen.has(k) && !k.startsWith('__'))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const ordered = LANDMARK_ATTRIBUTE_ORDER.map((k) => [k, normalized[k]]);
  return [...ordered, ...extra] as Array<[string, any]>;
};

// Fix for default marker icons in Leaflet with React
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface MapComponentProps {
  features: GeoFeature[];
  wards: any; // Using any for GeoJSON FeatureCollection
  /** When set (e.g. ward-tasked enumerators), GeoJSON-only landmark dots must match one of these wards; ward polygons stay full layer via `wards`. */
  enumeratorLandmarkWardFilter?: string[];
  onFeatureSelect: (feature: GeoFeature) => void;
  onRequestMoveFeature?: (feature: GeoFeature) => void;
  onCancelMoveFeature?: () => void;
  onLandmarkPointSelect?: (point: { lat: number; lng: number; properties: Record<string, any> }) => void;
  selectedFeatureId?: string;
  featureFocusRequestKey?: number;
  movingFeatureId?: string | null;
  onMapClick?: (lat: number, lng: number) => void;
  addFeatureType: 'point' | 'line' | 'polygon' | null;
  showPointAddBuffer?: boolean;
}

const MapEvents = ({ onClick }: { onClick: (lat: number, lng: number) => void }) => {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

const FocusOnUserForPointAdd = ({
  enabled,
  location
}: {
  enabled: boolean;
  location: { lat: number; lng: number; accuracy: number } | null;
}) => {
  const map = useMap();
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      hasFocusedRef.current = false;
      return;
    }
    if (!location || hasFocusedRef.current) return;
    // Zoom to user location when entering point-add mode.
    map.flyTo([location.lat, location.lng], Math.max(map.getZoom(), 19), {
      duration: 0.6
    });
    hasFocusedRef.current = true;
  }, [enabled, location, map]);

  return null;
};

const FocusOnSelectedFeature = ({
  feature,
  focusRequestKey
}: {
  feature: GeoFeature | null;
  focusRequestKey?: number;
}) => {
  const map = useMap();
  const lastFocusedFeatureIdRef = useRef<string | null>(null);
  const lastFocusRequestKeyRef = useRef<number | null>(null);

  useEffect(() => {
    if (!feature) {
      lastFocusedFeatureIdRef.current = null;
      lastFocusRequestKeyRef.current = null;
      return;
    }

    if (typeof focusRequestKey === 'number') {
      if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    } else if (lastFocusedFeatureIdRef.current === feature.id) {
      return;
    }

    const coords = feature.geometry?.coordinates;
    if (feature.type === 'point' && Array.isArray(coords) && coords.length >= 2) {
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      map.setView([lat, lng], Math.max(map.getZoom(), 18), { animate: false });
      lastFocusedFeatureIdRef.current = feature.id;
      if (typeof focusRequestKey === 'number') lastFocusRequestKeyRef.current = focusRequestKey;
      return;
    }

    if (feature.type === 'line' && Array.isArray(coords) && coords.length > 0) {
      const latLngs = coords
        .map((c: [number, number]) => [Number(c[1]), Number(c[0])] as [number, number])
        .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (latLngs.length > 0) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 18, animate: false });
        lastFocusedFeatureIdRef.current = feature.id;
        if (typeof focusRequestKey === 'number') lastFocusRequestKeyRef.current = focusRequestKey;
      }
      return;
    }

    if (feature.type === 'polygon' && Array.isArray(coords) && Array.isArray(coords[0])) {
      const latLngs = coords[0]
        .map((c: [number, number]) => [Number(c[1]), Number(c[0])] as [number, number])
        .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (latLngs.length > 0) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 18, animate: false });
        lastFocusedFeatureIdRef.current = feature.id;
        if (typeof focusRequestKey === 'number') lastFocusRequestKeyRef.current = focusRequestKey;
      }
    }
  }, [feature, focusRequestKey, map]);

  return null;
};

// Memoized point marker to prevent map shaking during updates
const PointMarker = React.memo(({
  feature,
  isSelected,
  isMoveTarget,
  isPulsing,
  color,
  radius,
  onFeatureSelect,
  onRequestMoveFeature,
  onCancelMoveFeature
}: {
  feature: GeoFeature;
  isSelected: boolean;
  isMoveTarget: boolean;
  isPulsing: boolean;
  color: string;
  radius: number;
  onFeatureSelect: (f: GeoFeature) => void;
  onRequestMoveFeature?: (f: GeoFeature) => void;
  onCancelMoveFeature?: () => void;
}) => (
  <CircleMarker
    center={[feature.geometry.coordinates[1], feature.geometry.coordinates[0]]}
    radius={radius}
    pathOptions={{ 
      color: isMoveTarget ? '#2563eb' : color,
      fillColor: isMoveTarget ? '#3b82f6' : color, 
      fillOpacity: 0.9,
      weight: isMoveTarget ? 4 : isSelected ? (isPulsing ? 4 : 3) : 2
    }}
  >
    <Popup autoPan={false}>
      <div className="min-w-[240px]">
        <p className="text-xs font-bold text-gray-700 mb-2">Landmark Attributes</p>
        <div className="max-h-48 overflow-auto border border-gray-100 rounded">
          <table className="w-full text-[10px]">
            <tbody>
              {normalizeLandmarkAttributesForDisplay(feature.attributes || {}).map(([k, v]) => (
                <tr key={k} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-2 py-1 font-semibold text-gray-600 bg-gray-50">{k}</td>
                  <td className="px-2 py-1 text-gray-700">{String(v ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          className="mt-2 w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700"
          onClick={() => onFeatureSelect(feature)}
        >
          Edit Attributes
        </button>
        <button
          className="mt-2 w-full bg-indigo-600 text-white text-xs font-medium py-1.5 rounded hover:bg-indigo-700"
          onClick={() => onRequestMoveFeature?.(feature)}
        >
          {isMoveTarget ? 'Move Mode Active' : 'Move Point'}
        </button>
        {isMoveTarget && (
          <button
            className="mt-2 w-full bg-slate-100 text-slate-700 text-xs font-medium py-1.5 rounded hover:bg-slate-200"
            onClick={() => onCancelMoveFeature?.()}
          >
            Cancel Move
          </button>
        )}
      </div>
    </Popup>
  </CircleMarker>
));

PointMarker.displayName = 'PointMarker';

// Memoized line renderer
const LineMarker = React.memo(({
  feature,
  isSelected,
  color,
  onFeatureSelect
}: {
  feature: GeoFeature;
  isSelected: boolean;
  color: string;
  onFeatureSelect: (f: GeoFeature) => void;
}) => (
  <Polyline
    positions={feature.geometry.coordinates.map((coord: [number, number]) => [coord[1], coord[0]])}
    pathOptions={{ 
      color: isSelected ? '#3b82f6' : color, 
      weight: isSelected ? 6 : 4 
    }}
    eventHandlers={{
      click: () => onFeatureSelect(feature)
    }}
  />
));

LineMarker.displayName = 'LineMarker';

// Memoized polygon renderer
const PolygonMarker = React.memo(({
  feature,
  isSelected,
  color,
  onFeatureSelect
}: {
  feature: GeoFeature;
  isSelected: boolean;
  color: string;
  onFeatureSelect: (f: GeoFeature) => void;
}) => (
  <Polygon
    positions={feature.geometry.coordinates[0].map((coord: [number, number]) => [coord[1], coord[0]])}
    pathOptions={{ 
      color: isSelected ? '#3b82f6' : color, 
      fillColor: color, 
      fillOpacity: 0.4,
      weight: isSelected ? 3 : 1
    }}
    eventHandlers={{
      click: () => onFeatureSelect(feature)
    }}
  />
));

PolygonMarker.displayName = 'PolygonMarker';

// Memoized landmark point from GeoJSON
const LandmarkGeoJsonPoint = React.memo(({
  p,
  idx,
  radius,
  onLandmarkPointSelect
}: {
  p: { lat: number; lng: number; properties: Record<string, any> };
  idx: number;
  radius: number;
  onLandmarkPointSelect?: (point: { lat: number; lng: number; properties: Record<string, any> }) => void;
}) => (
  <CircleMarker
    center={[p.lat, p.lng]}
    radius={radius}
    pathOptions={{
      color: '#f59e0b',
      fillColor: '#f59e0b',
      fillOpacity: 0.9,
      weight: 2
    }}
  >
    <Popup>
      <div className="min-w-[220px]">
        <p className="text-xs font-bold text-gray-700 mb-2">Landmark (GeoJSON)</p>
        <div className="max-h-44 overflow-auto border border-gray-100 rounded">
          <table className="w-full text-[10px]">
            <tbody>
              {normalizeLandmarkAttributesForDisplay(p.properties || {}).map(([k, v]) => (
                <tr key={k} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-2 py-1 font-semibold text-gray-600 bg-gray-50">{k}</td>
                  <td className="px-2 py-1 text-gray-700">{String(v ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          className="mt-2 w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700"
          onClick={() => onLandmarkPointSelect?.(p)}
        >
          Edit Attributes
        </button>
      </div>
    </Popup>
  </CircleMarker>
));

LandmarkGeoJsonPoint.displayName = 'LandmarkGeoJsonPoint';

export const MapComponent: React.FC<MapComponentProps> = ({ 
  features, 
  wards,
  enumeratorLandmarkWardFilter,
  onFeatureSelect, 
  onRequestMoveFeature,
  onCancelMoveFeature,
  onLandmarkPointSelect,
  selectedFeatureId,
  featureFocusRequestKey,
  movingFeatureId,
  onMapClick,
  addFeatureType,
  showPointAddBuffer = false
}) => {
  const { location } = useGeoLocation();
  const { user, userProfile } = useAuth();
  const [showWards, setShowWards] = useState(true);
  const [showLandmarks, setShowLandmarks] = useState(true);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [baseMap, setBaseMap] = useState<'osm' | 'satellite' | 'hybrid'>('osm');
  const [landmarkIconScale, setLandmarkIconScale] = useState(readStoredLandmarkIconScale);
  const [landmarkPoints, setLandmarkPoints] = useState<Array<{ lat: number; lng: number; properties: Record<string, any> }>>([]);
  const [pulseFeatureId, setPulseFeatureId] = useState<string | null>(null);
  const isAddingFeature = !!addFeatureType;
  const landmarkScaleHydratedRef = useRef(false);
  const pulseTimerRef = useRef<number | null>(null);

  const selectedFeature = selectedFeatureId
    ? features.find((f) => f.id === selectedFeatureId) || null
    : null;

  const clampLandmarkRadius = (r: number) => Math.min(24, Math.max(3, Math.round(r)));
  const radiusForLandmark = (base: number, selected: boolean, pulsing: boolean) =>
    clampLandmarkRadius(base * landmarkIconScale * (selected ? (pulsing ? 1.9 : 1.35) : 1));

  useEffect(() => {
    if (!selectedFeatureId) return;
    setPulseFeatureId(selectedFeatureId);
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => {
      setPulseFeatureId((curr) => (curr === selectedFeatureId ? null : curr));
    }, 1400);
  }, [selectedFeatureId]);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    landmarkScaleHydratedRef.current = true;
  }, []);

  useEffect(() => {
    const remote = userProfile?.landmarkIconScale;
    if (typeof remote === 'number' && Number.isFinite(remote)) {
      const clamped = clampScale(remote);
      setLandmarkIconScale(clamped);
    }
  }, [userProfile?.landmarkIconScale]);

  useEffect(() => {
    if (!landmarkScaleHydratedRef.current) return;
    try {
      localStorage.setItem(LANDMARK_ICON_SCALE_KEY, String(landmarkIconScale));
    } catch {
      /* ignore */
    }
  }, [landmarkIconScale]);

  const syncLandmarkScaleToFirestore = useCallback(async (clamped: number) => {
    if (!user) return;
    try {
      await setDoc(
        doc(db, 'users', user.uid),
        { landmarkIconScale: clamped },
        { merge: true }
      );
    } catch (e) {
      console.error('Failed to persist landmark icon scale', e);
    }
  }, [user]);

  const bumpLandmarkScale = useCallback(
    (delta: number) => {
      setLandmarkIconScale((prev) => {
        const next = clampScale(prev + delta);
        void syncLandmarkScaleToFirestore(next);
        return next;
      });
    },
    [syncLandmarkScaleToFirestore]
  );

  useEffect(() => {
    let mounted = true;

    const loadLandmarks = async () => {
      try {
        // Use Vite asset URL so this works in production (e.g., Vercel) and local dev.
        const resp = await fetch(landmarkGeoJsonUrl);
        if (!resp.ok) return;
        const geo = await resp.json();
        const points = Array.isArray(geo?.features)
          ? geo.features
              .filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f?.geometry?.coordinates))
              .map((f: any) => ({
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0],
                properties: f.properties || {}
              }))
          : [];
        if (mounted) setLandmarkPoints(points);
      } catch (e) {
        console.error('Failed to load CCC_all_Landmark.geojson', e);
      }
    };

    loadLandmarks();
    return () => {
      mounted = false;
    };
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'verified': return '#22c55e';
      case 'rejected': return '#ef4444';
      default: return '#f59e0b';
    }
  };

  const isNewlyAddedFeature = (feature: GeoFeature) =>
    typeof feature.newFeatureRemarks === 'string' && feature.newFeatureRemarks.trim().length > 0;

  const getFeatureColor = (feature: GeoFeature) =>
    isNewlyAddedFeature(feature) ? '#7c3aed' : getStatusColor(feature.status);

  const normalizeLandmarkFid = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : undefined;
  };

  const fidsEqual = (a: unknown, b: unknown) => {
    if (a === b) return true;
    const na = normalizeLandmarkFid(a);
    const nb = normalizeLandmarkFid(b);
    if (na === undefined || nb === undefined) return false;
    return na === nb;
  };

  const findMatchingFirestorePoint = (p: { lat: number; lng: number; properties: Record<string, any> }) => {
    const fid = normalizeLandmarkFid(p.properties?.FID);
    return features.find((f) => {
      if (f.type !== 'point') return false;
      if (fid !== undefined) return fidsEqual(f.attributes?.FID, fid);
      if (!Array.isArray(f.geometry?.coordinates)) return false;
      return (
        Math.abs((f.geometry.coordinates[1] ?? 0) - p.lat) < 0.0000001 &&
        Math.abs((f.geometry.coordinates[0] ?? 0) - p.lng) < 0.0000001
      );
    });
  };

  const wardStyleForFeature = (feature: any) => {
    const wardName = String(
      feature?.properties?.WARDNAME ??
      feature?.properties?.Ward_Name ??
      feature?.properties?.WardName ??
      ''
    ).trim();
    const assigned = enumeratorLandmarkWardFilter ?? [];
    const isAssignedEnumerator =
      userProfile?.role === 'enumerator' &&
      userProfile?.status === 'approved' &&
      assigned.length > 0;
    const isAssignedWard = isAssignedEnumerator && wardName && wardMatchesAssignedList(wardName, assigned);

    if (isAssignedWard) {
      return {
        color: '#166534', // dark bold green border for assigned wards
        weight: 4,
        opacity: 1,
        fillColor: 'transparent',
        fillOpacity: 0,
        dashArray: undefined as string | undefined
      };
    }

    return {
      color: '#ef4444',
      weight: 2,
      opacity: 0.8,
      fillColor: 'transparent',
      fillOpacity: 0,
      dashArray: '5, 5'
    };
  };

  // Memoize callbacks to prevent marker re-renders
  const handleFeatureSelect = useCallback(onFeatureSelect, [onFeatureSelect]);
  const handleRequestMoveFeature = useCallback((f: GeoFeature) => onRequestMoveFeature?.(f), [onRequestMoveFeature]);
  const handleCancelMoveFeature = useCallback(() => onCancelMoveFeature?.(), [onCancelMoveFeature]);
  const handleLandmarkPointSelect = useCallback((p: { lat: number; lng: number; properties: Record<string, any> }) => onLandmarkPointSelect?.(p), [onLandmarkPointSelect]);

  return (
    <div className="relative w-full h-full">
      <MapContainer 
        center={[22.3569, 91.7832]} // Chattogram, Bangladesh
        zoom={13} 
        className="w-full h-full"
      >
        <FocusOnSelectedFeature feature={selectedFeature} focusRequestKey={featureFocusRequestKey} />
        {baseMap === 'osm' && (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
        )}
        {baseMap === 'satellite' && (
          <TileLayer
            attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          />
        )}
        {baseMap === 'hybrid' && (
          <TileLayer
            attribution='Map data &copy; Google'
            url="https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
            subdomains={['mt0', 'mt1', 'mt2', 'mt3']}
            maxZoom={20}
          />
        )}

        {/* Ward Boundaries (Non-editable) */}
        {showWards && wards && (
          <GeoJSON 
            data={wards} 
            style={wardStyleForFeature}
            onEachFeature={(feature, layer) => {
              if (feature.properties && feature.properties.WARDNAME) {
                layer.bindTooltip(feature.properties.WARDNAME, {
                  permanent: true,
                  direction: 'center',
                  className: 'ward-label'
                });
              }
            }}
          />
        )}

        {/* Existing Features */}
        {features.map(feature => {
          const isSelected = feature.id === selectedFeatureId;
          const isMoveTarget = feature.id === movingFeatureId;
          const isPulsing = feature.id === pulseFeatureId;
          const color = getFeatureColor(feature);

          if (feature.type === 'point') {
            if (!showLandmarks) return null;
            return (
              <PointMarker
                key={feature.id}
                feature={feature}
                isSelected={isSelected}
                isMoveTarget={isMoveTarget}
                isPulsing={isPulsing}
                color={color}
                radius={radiusForLandmark(7, isSelected, isPulsing)}
                onFeatureSelect={handleFeatureSelect}
                onRequestMoveFeature={handleRequestMoveFeature}
                onCancelMoveFeature={handleCancelMoveFeature}
              />
            );
          }

          if (feature.type === 'line') {
            return (
              <LineMarker
                key={feature.id}
                feature={feature}
                isSelected={isSelected}
                color={color}
                onFeatureSelect={handleFeatureSelect}
              />
            );
          }

          if (feature.type === 'polygon') {
            return (
              <PolygonMarker
                key={feature.id}
                feature={feature}
                isSelected={isSelected}
                color={color}
                onFeatureSelect={handleFeatureSelect}
              />
            );
          }

          return null;
        })}

        {/* Landmark points from CCC_all_Landmark.geojson (read-only visual layer).
            Hide a GeoJSON point when a matching Firestore feature exists so users
            always interact with the live/editable record after first edit/create. */}
        {showLandmarks && landmarkPoints
          .filter((p) =>
            staticLandmarkMatchesAssignedWards(
              p.lng,
              p.lat,
              p.properties,
              enumeratorLandmarkWardFilter ?? [],
              wards
            )
          )
          .filter((p) => {
            // If a Firestore record exists for this landmark, render ONLY the Firestore marker
            // (same status symbology) to avoid double-markers.
            return !findMatchingFirestorePoint(p);
          })
          .map((p, idx) => (
            <LandmarkGeoJsonPoint
              key={`landmark_geojson_${idx}`}
              p={p}
              idx={idx}
              radius={radiusForLandmark(5, false, false)}
              onLandmarkPointSelect={handleLandmarkPointSelect}
            />
          ))}

        {/* Enumerator Live Location */}
        {location && (
          <>
            <FocusOnUserForPointAdd enabled={showPointAddBuffer} location={location} />
            <Circle 
              center={[location.lat, location.lng]} 
              radius={location.accuracy} 
              pathOptions={{ color: '#3b82f6', fillOpacity: 0.1, weight: 1 }} 
            />
            {showPointAddBuffer && (
              <Circle
                center={[location.lat, location.lng]}
                radius={10}
                pathOptions={{
                  color: '#16a34a',
                  fillColor: '#22c55e',
                  fillOpacity: 0,
                  weight: 2,
                  dashArray: '4, 4'
                }}
              />
            )}
            <Marker 
              position={[location.lat, location.lng]}
              icon={L.divIcon({
                html: `<div class="bg-blue-600 p-2 rounded-full border-2 border-white shadow-lg shadow-blue-500/50 animate-pulse"><svg viewBox="0 0 24 24" width="20" height="20" stroke="white" stroke-width="2" fill="none" class="lucide lucide-navigation"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg></div>`,
                className: '',
                iconSize: [36, 36],
                iconAnchor: [18, 18]
              })}
            />
          </>
        )}

        {(isAddingFeature || !!movingFeatureId) && onMapClick && <MapEvents onClick={onMapClick} />}
      </MapContainer>

      {/* Click-to-open layer panel */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
        <button
          onClick={() => setShowLayerPanel((v) => !v)}
          className="p-3 rounded-xl shadow-lg bg-white text-blue-600 hover:bg-blue-50 transition-all"
          title="Layers"
        >
          <Layers size={20} />
        </button>
        {showLayerPanel && (
          <div className="w-56 bg-white rounded-xl shadow-xl border border-slate-200 p-3 text-xs space-y-3">
            <div>
              <p className="font-bold text-slate-700 mb-2">Basemap</p>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="basemap" checked={baseMap === 'osm'} onChange={() => setBaseMap('osm')} />
                  <span>OpenStreetMap</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="basemap" checked={baseMap === 'satellite'} onChange={() => setBaseMap('satellite')} />
                  <span>Satellite Imagery</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="basemap" checked={baseMap === 'hybrid'} onChange={() => setBaseMap('hybrid')} />
                  <span>Google Hybrid</span>
                </label>
              </div>
            </div>
            <div className="border-t pt-2">
              <div className="flex items-center justify-between gap-2 font-medium text-slate-700 mb-2">
                <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
                  <input type="checkbox" checked={showLandmarks} onChange={(e) => setShowLandmarks(e.target.checked)} />
                  <span className="truncate">Landmarks</span>
                </label>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => bumpLandmarkScale(-0.1)}
                    className="h-7 w-7 flex items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                    title="Smaller landmark dots"
                    disabled={landmarkIconScale <= 0.6}
                  >
                    <Minus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => bumpLandmarkScale(0.1)}
                    className="h-7 w-7 flex items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                    title="Larger landmark dots"
                    disabled={landmarkIconScale >= 2.4}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                <input type="checkbox" checked={showWards} onChange={(e) => setShowWards(e.target.checked)} />
                <span>Ward Boundaries</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
