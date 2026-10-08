import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Polygon, useMapEvents, Circle, CircleMarker, GeoJSON, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { GeoFeature, type FeatureType, type SurveyLayerAction } from '../types';
import {
  shouldShowSlumNumericFields,
  SLUM_DEMOGRAPHIC_KEYS,
  SLUM_DEMOGRAPHIC_KEY_SET
} from '../lib/slumFeatureFields';
import { useGeoLocation } from './GeoLocationProvider';
import { useAuth } from './AuthProvider';
import { geosurveyApi } from '../lib/geosurveyApi';
import { MapPin, Navigation, Info, Layers, Plus, Minus, LocateFixed } from 'lucide-react';
import { staticLandmarkMatchesAssignedWards, wardMatchesAssignedList } from '../lib/wardGeometry';
import { findMatchingFirestoreLandmark } from '../lib/landmarkMatch';
import { useLandmarkGeoJsonPoints } from '../hooks/useLandmarkGeoJsonPoints';
import { NEW_POINT_ADD_PROXIMITY_METERS } from '../lib/newPointProximity';
import { DEFAULT_MAP_LAYER_STYLE, mapLayerStyleKey, mapPopupAttributeEntries, readMapLayerSettings, subscribeMapLayerSettings, type MapPopupSettings } from '../lib/mapLayerSettings';

const LANDMARK_ICON_SCALE_KEY = 'eqms_geosurvey_landmark_icon_scale_v1';
const MAP_LAYER_VISIBILITY_PREFIX = 'eqms.mapLayerVisibility:';
const MAP_ZONE_VISIBILITY_PREFIX = 'eqms.mapZoneVisibility:';
const MAP_ZONE_LAYER_VISIBILITY_PREFIX = 'eqms.mapZoneLayerVisibility:';
const LANDMARK_ATTRIBUTE_ORDER = ['name', 'Category', 'Type', 'Ownership', 'Ward_Name'] as const;
const HIDDEN_LANDMARK_POPUP_KEYS = new Set([
  'FID',
  'Zone',
  'ZONE',
  'WardName',
  'WARDNAME',
  'ChangeAt',
  'ChangeBy'
]);

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

const readStoredMapLayerVisibility = (projectId?: string): Record<string, boolean> => {
  if (!projectId || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(`${MAP_LAYER_VISIBILITY_PREFIX}${projectId}`);
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const readStoredZoneVisibility = (projectId?: string, fallback = true): boolean => {
  if (!projectId || typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`${MAP_ZONE_VISIBILITY_PREFIX}${projectId}`);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
};

const readStoredZoneLayerVisibility = (projectId?: string): Record<string, boolean> => {
  if (!projectId || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(`${MAP_ZONE_LAYER_VISIBILITY_PREFIX}${projectId}`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const importedLayerName = (feature: GeoFeature): string => {
  const attrs = feature.attributes || {};
  const name = String(attrs.__layerName || attrs.layerName || (feature as any).layerName || '').trim();
  if (name) return name;
  const isImported =
    attrs.__source === 'geojson_upload' ||
    attrs.__source === 'shapefile_upload' ||
    Boolean(attrs.projectId || (feature as any).projectId);
  return isImported ? 'Unassigned layer' : '';
};

const polygonGeometryKey = (geometry: any): string => {
  if (!geometry || typeof geometry.type !== 'string' || !Array.isArray(geometry.coordinates)) return '';
  const rounded = (value: any): any => Array.isArray(value)
    ? value.map(rounded)
    : typeof value === 'number'
      ? Math.round(value * 1_000_000) / 1_000_000
      : value;
  return `${geometry.type}:${JSON.stringify(rounded(geometry.coordinates))}`;
};

const surveyLayerKeyMatches = (keys: string[], key: string) => {
  const normalize = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();
  const expected = normalize(key);
  return keys.some((candidate) => normalize(candidate) === expected);
};

const labelHaloShadow = (color: string) => [
  `-1.5px -1.5px 0 ${color}`, `0 -1.5px 0 ${color}`, `1.5px -1.5px 0 ${color}`,
  `-1.5px 0 0 ${color}`, `1.5px 0 0 ${color}`,
  `-1.5px 1.5px 0 ${color}`, `0 1.5px 0 ${color}`, `1.5px 1.5px 0 ${color}`,
].join(', ');
const safeLabelColor = (color: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
const escapeTooltipText = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const MapZoomListener: React.FC<{ onZoomChange: (zoom: number) => void }> = ({ onZoomChange }) => {
  const map = useMap();
  useEffect(() => {
    const update = () => onZoomChange(map.getZoom());
    update();
    map.on('zoomend', update);
    return () => { map.off('zoomend', update); };
  }, [map, onZoomChange]);
  return null;
};

const ScaleAwareZoneLayer: React.FC<{
  data: GeoJSON.FeatureCollection;
  color: string;
  fillColor: string;
  borderWidth?: number;
  opacity: number;
  labelsVisible: boolean;
  labelsFromZoom: number;
  labelField: string;
  labelColor: string;
  haloColor: string;
  fontSize: number;
  layerName: string;
  surveyLayerKey: string;
  projectId?: string;
  interactive: boolean;
  onFeatureSelect?: (feature: GeoFeature) => void;
}> = ({ data, color, fillColor, borderWidth, opacity, labelsVisible, labelsFromZoom, labelField, labelColor, haloColor, fontSize, layerName, surveyLayerKey, projectId, interactive, onFeatureSelect }) => {
  const map = useMap();
  const geoJsonRef = useRef<L.GeoJSON | null>(null);
  const strokeWidth = Math.max(0.5, Number(borderWidth ?? 2));
  useEffect(() => {
    const updateLabels = () => {
      const zoom = map.getZoom();
      geoJsonRef.current?.eachLayer((layer: any) => {
        const feature = layer.feature as GeoJSON.Feature | undefined;
        if (!feature) return;
        layer.options.interactive = interactive;
        if (typeof layer.setStyle === 'function') {
          layer.setStyle({ color, weight: strokeWidth, fillColor, fillOpacity: opacity, interactive });
        }
        const pathElement = layer.getElement?.() as SVGElement | undefined;
        if (pathElement) pathElement.style.pointerEvents = interactive ? 'auto' : 'none';
        const properties = feature.properties || {};
        const value = labelField ? properties[labelField] : properties.__label || properties.__assignValue || properties.NAME || properties.Name;
        const text = value == null ? '' : String(value);
        const textColor = safeLabelColor(labelColor, '#0f172a');
        const outlineColor = safeLabelColor(haloColor, '#ffffff');
        const safeSize = Math.min(48, Math.max(4, Number(fontSize) || 11));
        const content = `<span style="color:${textColor};font-size:${safeSize}px;text-shadow:${labelHaloShadow(outlineColor)}">${escapeTooltipText(text)}</span>`;
        if (!layer.getTooltip()) layer.bindTooltip(content, { permanent: true, direction: 'center', className: 'zone-label', opacity: 1 });
        else layer.setTooltipContent(content);
        const visible = labelsVisible && !!text && zoom >= labelsFromZoom;
        if (visible) layer.openTooltip();
        else layer.closeTooltip();
        layer.off('click');
        if (interactive && onFeatureSelect) {
          layer.on('click', (event: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event);
            onFeatureSelect({
              id: String(feature.id || properties.__zoneId || ''),
              type: 'polygon',
              geometry: feature.geometry as any,
              attributes: { ...properties, __layerName: layerName, layerName, __source: 'zone_layer', __surveyLayerKey: surveyLayerKey, projectId },
              status: 'pending',
              createdBy: '',
              updatedBy: '',
              updatedAt: '',
            } as GeoFeature);
          });
        }
      });
    };
    updateLabels();
    map.on('zoomend', updateLabels);
    return () => { map.off('zoomend', updateLabels); };
  }, [map, data, color, fillColor, strokeWidth, opacity, labelsVisible, labelsFromZoom, labelField, labelColor, haloColor, fontSize, interactive, onFeatureSelect, layerName, surveyLayerKey, projectId]);

  return <GeoJSON key={`${layerName}:${interactive ? 'active' : 'inactive'}:${color}:${fillColor}:${strokeWidth}:${opacity}:${labelField}:${labelsVisible}:${labelColor}:${haloColor}:${fontSize}`} ref={geoJsonRef as any} data={data} style={() => ({ color, weight: strokeWidth, fillColor, fillOpacity: opacity, interactive })} onEachFeature={(_feature, layer) => {
    if (!layer.getTooltip()) layer.bindTooltip('', { permanent: true, direction: 'center', className: 'zone-label', opacity: 1 });
  }} />;
};

const normalizeLandmarkAttributesForDisplay = (
  attrs: Record<string, any>,
  featureType: FeatureType = 'point'
) => {
  const a = attrs || {};
  const selectedCategory = String(a.Category ?? a.category ?? '').trim();
  const showOwnership = selectedCategory === 'Health Facilities';
  const normalized: Record<string, any> = {
    name: a.name ?? a.Name ?? '',
    Category: a.Category ?? '',
    Type: a.Type ?? '',
    Ward_Name: a.Ward_Name ?? a.WARDNAME ?? a.WardName ?? ''
  };
  if (showOwnership) {
    normalized.Ownership = a.Ownership ?? '';
  }

  const slum = shouldShowSlumNumericFields(a, featureType);
  if (slum) {
    for (const k of SLUM_DEMOGRAPHIC_KEYS) {
      normalized[k] = a[k] ?? '';
    }
  }

  const seen = new Set<string>(Object.keys(normalized));
  const extra = Object.entries(a)
    .filter(([k]) => {
      if (SLUM_DEMOGRAPHIC_KEY_SET.has(k) && !slum) return false;
      if (!showOwnership && k.toLowerCase() === 'ownership') return false;
      return !seen.has(k) && !k.startsWith('__') && !HIDDEN_LANDMARK_POPUP_KEYS.has(k);
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  const order = [
    ...LANDMARK_ATTRIBUTE_ORDER.filter((k) => (k === 'Ownership' ? showOwnership : true)),
    ...(slum ? SLUM_DEMOGRAPHIC_KEYS : [])
  ];
  const ordered = order.map((k) => [k, normalized[k] ?? a[k] ?? '']);
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
  className?: string;
  features: GeoFeature[];
  /** Project scope used to persist map layer visibility preferences. */
  projectId?: string;
  /** Optional reference ward polygons (legacy CCC). Omit/null when using project zone SHP. */
  wards?: any | null;
  /** Approved admin only: show enumerator display name on landmark point popups (ward-based; falls back to `updatedBy`). */
  getAdminLandmarkEnumeratorDisplayName?: (feature: GeoFeature) => string;
  /** When set (e.g. ward-tasked enumerators), GeoJSON-only landmark dots must match one of these wards; ward polygons stay full layer via `wards`. */
  enumeratorLandmarkWardFilter?: string[];
  onFeatureSelect: (feature: GeoFeature) => void;
  activeSurveyLayerKeys?: string[];
  projectMapLayerStyles?: Record<string, import('../lib/mapLayerSettings').MapLayerStyle>;
  projectMapLayerStylesByProject?: Record<string, Record<string, import('../lib/mapLayerSettings').MapLayerStyle>>;
  focusSelectedFeatures?: boolean;
  onRequestMoveFeature?: (feature: GeoFeature) => void;
  onCancelMoveFeature?: () => void;
  onLandmarkPointSelect?: (point: { lat: number; lng: number; properties: Record<string, any> }) => void;
  /** Direct action to launch questionnaire survey linked to this geospatial feature */
  onFillQuestionnaire?: (feature: GeoFeature) => void;
  surveyLayerActions?: Record<string, SurveyLayerAction>;
  /** Ask enumerators which action to take on an active survey boundary. */
  onSurveyActionRequest?: (feature: GeoFeature) => void;
  selectedFeatureId?: string;
  featureFocusRequestKey?: number;
  movingFeatureId?: string | null;
  onMapClick?: (lat: number, lng: number) => void;
  addFeatureType: 'point' | 'line' | 'polygon' | null;
  showPointAddBuffer?: boolean;
  /** Bump (e.g. admin refresh) to reload bundled landmark GeoJSON overlay from the network. */
  landmarkGeoJsonRefreshKey?: number;
  /**
   * Initial visibility for the landmark layer. Defaults to `true` to keep
   * the geospatial-survey tab's behaviour unchanged. The admin Responses
   * map embeds passes `false` because admins reviewing submissions don't
   * need the landmark dataset visible by default and it just clutters the
   * map. Users can still toggle it on via the layer panel.
   */
  defaultShowLandmarks?: boolean;
  /** Initial visibility for optional ward polygons. Defaults to true when wards provided. */
  defaultShowWards?: boolean;
  /**
   * Optional "HH Survey Location" layer â€” one point per questionnaire
   * response with a captured GPS. Toggleable from the layer panel. When
   * omitted (`undefined`), the layer + its toggle don't render at all,
   * so call sites that don't care about questionnaire responses (e.g.
   * the standalone feature-editor preview) aren't forced to deal with
   * them.
   */
  surveyLocations?: SurveyLocationMarker[];
  /** Initial visibility for the survey-locations layer. Defaults to `true`. */
  defaultShowSurveyLocations?: boolean;
  /** Fires when the HH Survey Location layer is toggled (for parent Firestore gating). */
  onSurveyLocationsVisibilityChange?: (visible: boolean) => void;
  /** Optional zone boundary FeatureCollection (imported SHP polygons). */
  zoneBoundaries?: GeoJSON.FeatureCollection | null;
  importedZoneLayers?: Array<{ id: string; projectId?: string; name: string; featureCount: number; data: GeoJSON.FeatureCollection }>;
  /** Force fit-to-zones when this changes (project / layer id). */
  zoneFitKey?: string;
  /** Uploaded polygon layer and attribute values that define the enumerator's assigned area. */
  assignedBoundaryLayerKey?: string | null;
  assignedBoundaryField?: string | null;
  assignedBoundaryValues?: string[];
  /** Initial basemap. Enumerators with zones default to satellite. */
  defaultBaseMap?: 'osm' | 'satellite' | 'hybrid';
  /** Show assigned zone outlines (default true when zoneBoundaries provided). */
  defaultShowZones?: boolean;
  /** One-shot request to fit the viewport to a successfully imported feature batch. */
  importedExtentRequest?: {
    key: number;
    extent: { south: number; west: number; north: number; east: number };
  } | null;
  /** Captures and restores the current map viewport around survey/editor overlays. */
  onMapViewChange?: (view: { center: [number, number]; zoom: number }) => void;
  mapViewRestoreRequest?: {
    key: number;
    view: { center: [number, number]; zoom: number };
  } | null;
}

export interface SurveyLocationMarker {
  id: string;
  lat: number;
  lng: number;
  accuracy?: number;
  respondentName?: string;
  respondentEmail?: string;
  questionnaireId?: string;
  /** Optional questionnaire display name â€” populated by the caller when known. */
  questionnaireTitle?: string;
  status?: 'draft' | 'submitted' | 'reviewed' | 'queued';
  submittedAt?: unknown;
  capturedAt?: unknown;
  ward?: string;
}

const MapEvents = ({ onClick }: { onClick: (lat: number, lng: number) => void }) => {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

const MapViewBridge = ({
  onMapViewChange,
  restoreRequest,
}: {
  onMapViewChange?: MapComponentProps['onMapViewChange'];
  restoreRequest?: MapComponentProps['mapViewRestoreRequest'];
}) => {
  const map = useMap();
  const lastRestoreKeyRef = useRef<number | null>(null);

  useEffect(() => {
    if (!onMapViewChange) return;
    const reportView = () => {
      const center = map.getCenter();
      onMapViewChange({ center: [center.lat, center.lng], zoom: map.getZoom() });
    };
    reportView();
    map.on('moveend', reportView);
    map.on('zoomend', reportView);
    return () => {
      map.off('moveend', reportView);
      map.off('zoomend', reportView);
    };
  }, [map, onMapViewChange]);

  useEffect(() => {
    if (!restoreRequest || lastRestoreKeyRef.current === restoreRequest.key) return;
    const { center, zoom } = restoreRequest.view;
    if (!center.every(Number.isFinite) || !Number.isFinite(zoom)) return;
    map.setView(center, zoom, { animate: false });
    lastRestoreKeyRef.current = restoreRequest.key;
  }, [map, restoreRequest]);

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

const FocusOnEnumeratorLocation = ({
  enabled,
  location,
  focusRequestKey
}: {
  enabled: boolean;
  location: { lat: number; lng: number; accuracy: number } | null;
  focusRequestKey: number;
}) => {
  const map = useMap();
  const lastFocusRequestKeyRef = useRef<number>(-1);

  useEffect(() => {
    // Show the live location marker by default without replacing the initial
    // project-data extent. Only recenter after the enumerator requests it.
    if (!enabled || !location || focusRequestKey <= 0) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    map.flyTo([location.lat, location.lng], Math.max(map.getZoom(), 18), { duration: 0.6 });
    lastFocusRequestKeyRef.current = focusRequestKey;
  }, [enabled, location, focusRequestKey, map]);

  return null;
};

const FitToZoneBoundaries = ({
  data,
  fitKey = '',
}: {
  data: GeoJSON.FeatureCollection | null | undefined;
  /** Change this (e.g. projectId:layerId) to force a fresh fit when opening a project. */
  fitKey?: string;
}) => {
  const map = useMap();
  const fittedKeyRef = useRef<string>('');
  useEffect(() => {
    if (!data?.features?.length) return;
    const key = `${fitKey}|${data.features.length}|${String(data.features[0]?.id ?? '')}`;
    if (fittedKeyRef.current === key) return;
    try {
      const layer = L.geoJSON(data as GeoJSON.GeoJsonObject);
      const b = layer.getBounds();
      if (b.isValid()) {
        map.invalidateSize();
        map.fitBounds(b, { padding: [48, 48], maxZoom: 17, animate: false });
        fittedKeyRef.current = key;
      }
    } catch {
      /* ignore bad geometry */
    }
  }, [data, fitKey, map]);
  return null;
};

const FitToImportedExtent = ({
  request
}: {
  request?: {
    key: number;
    extent: { south: number; west: number; north: number; east: number };
  } | null;
}) => {
  const map = useMap();
  const lastFitKeyRef = useRef<number | null>(null);

  useEffect(() => {
    if (!request || lastFitKeyRef.current === request.key) return;
    const { south, west, north, east } = request.extent;
    if (![south, west, north, east].every(Number.isFinite)) return;
    const bounds = L.latLngBounds([south, west], [north, east]);
    if (!bounds.isValid()) return;
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 18, animate: true, duration: 0.6 });
    lastFitKeyRef.current = request.key;
  }, [request, map]);

  return null;
};

const FitToImportedFeatures = ({ features, projectId, assignedLayerKey, assignedField, assignedValues = [] }: { features: GeoFeature[]; projectId?: string; assignedLayerKey?: string | null; assignedField?: string | null; assignedValues?: string[] }) => {
  const map = useMap();
  const fittedProjectRef = useRef<string>('');

  useEffect(() => {
    const fitKey = `${projectId || 'assigned-imported-features'}:${assignedLayerKey || ''}:${assignedValues.join('|')}`;
    if (fittedProjectRef.current === fitKey) return;
    const imported = features.filter((feature) => importedLayerName(feature));
    if (!imported.length) return;
    const layerName = assignedLayerKey?.startsWith('feature:') ? assignedLayerKey.slice('feature:'.length) : '';
    const assignedValueKeys = new Set(assignedValues.map((value) => String(value).trim().toLowerCase()));
    const assignedPolygons = layerName && assignedField && assignedValueKeys.size
      ? imported.filter((feature) => {
          const featureLayerName = String(feature.attributes?.__layerName || feature.attributes?.layerName || (feature as any).layerName || '');
          const value = String(feature.attributes?.[assignedField] ?? '').trim().toLowerCase();
          return featureLayerName === layerName && ['Polygon', 'MultiPolygon'].includes(String(feature.geometry?.type)) && assignedValueKeys.has(value);
        })
      : [];
    if (layerName && assignedValueKeys.size && !assignedPolygons.length) return;
    const fitFeatures = assignedPolygons.length ? assignedPolygons : imported;
    try {
      const collection: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: fitFeatures.map((feature) => ({
          type: 'Feature' as const,
          id: feature.id,
          geometry: feature.geometry as GeoJSON.Geometry,
          properties: feature.attributes || {},
        })),
      };
      const bounds = L.geoJSON(collection).getBounds();
      if (!bounds.isValid()) return;
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17, animate: false });
      fittedProjectRef.current = fitKey;
    } catch {
      // Ignore invalid uploaded geometries and let the map keep its current view.
    }
  }, [features, map, projectId, assignedLayerKey, assignedField, assignedValues]);

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
  interactive = true,
  color,
  boundaryColor,
  borderWidth,
  opacity,
  labelText,
  labelColor,
  haloColor,
  fontSize,
  radius,
  adminEnumeratorDisplayName,
  onFeatureSelect,
  onRequestMoveFeature,
  onCancelMoveFeature,
  onFillQuestionnaire,
  allowAttributeEdit = true,
  allowMoveActions = true,
  popupSettings
}: {
  feature: GeoFeature;
  isSelected: boolean;
  isMoveTarget: boolean;
  isPulsing: boolean;
  interactive?: boolean;
  color: string;
  boundaryColor?: string;
  borderWidth?: number;
  opacity?: number;
  labelText?: string;
  labelColor: string;
  haloColor: string;
  fontSize: number;
  radius: number;
  /** Approved admin only: enumerator full name for landmark popup header. */
  adminEnumeratorDisplayName?: string;
  onFeatureSelect: (f: GeoFeature) => void;
  onRequestMoveFeature?: (f: GeoFeature) => void;
  onCancelMoveFeature?: () => void;
  onFillQuestionnaire?: (f: GeoFeature) => void;
  allowAttributeEdit?: boolean;
  allowMoveActions?: boolean;
  popupSettings?: MapPopupSettings;
}) => {
  const baseWeight = Math.max(0.5, Number(borderWidth ?? 2));
  const isUploadedFeature = feature.attributes?.__source === 'geojson_upload' || feature.attributes?.__source === 'shapefile_upload' || feature.attributes?.projectId;
  const popupAttributes = isUploadedFeature
    ? mapPopupAttributeEntries(feature.attributes || {}, popupSettings)
    : normalizeLandmarkAttributesForDisplay(feature.attributes || {}, feature.type);
  return (
  <CircleMarker
    interactive={interactive}
    center={[feature.geometry.coordinates[1], feature.geometry.coordinates[0]]}
    radius={radius}
    pathOptions={{ 
      className: interactive ? undefined : 'survey-layer-inactive',
      color: isMoveTarget ? '#2563eb' : boundaryColor || color,
      fillColor: isMoveTarget ? '#3b82f6' : color,
      fillOpacity: opacity ?? 0.9,
      weight: isMoveTarget ? baseWeight + 2 : isSelected ? (isPulsing ? baseWeight + 2 : baseWeight + 1) : baseWeight
    }}
  >
    {labelText && <Tooltip permanent direction="top" offset={[0, -6]} className="map-feature-label"><span style={{ color: labelColor, fontSize, textShadow: labelHaloShadow(haloColor) }}>{labelText}</span></Tooltip>}
    {interactive && <Popup autoPan={false}>
      <div className="min-w-[240px]">
        {adminEnumeratorDisplayName ? (
          <div className="mb-2 pb-2 border-b border-amber-100">
            <p className="text-[10px] font-semibold text-amber-800 uppercase tracking-wide">Enumerator</p>
            <p className="text-sm font-bold text-slate-900 leading-snug">{adminEnumeratorDisplayName}</p>
          </div>
        ) : null}
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-bold text-gray-700">
            {feature.attributes?.__source === 'geojson_upload' || feature.attributes?.__source === 'shapefile_upload' || feature.attributes?.projectId ? 'Feature Attributes' : 'Landmark Attributes'}
          </p>
          {(feature.attributes?.__layerName || feature.attributes?.layerName) && (
            <span className="text-[10px] bg-sky-100 text-sky-800 font-semibold px-2 py-0.5 rounded-full">
              {feature.attributes?.__layerName || feature.attributes?.layerName}
            </span>
          )}
        </div>
        <div className="max-h-48 overflow-auto border border-gray-100 rounded">
          <table className="w-full text-[10px]">
            <tbody>
              {popupAttributes.map(([k, v]) => (
                <tr key={k} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-2 py-1 font-semibold text-gray-600 bg-gray-50">{k}</td>
                  <td className="px-2 py-1 text-gray-700">{String(v ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isMoveTarget && allowAttributeEdit && (
          <button
            type="button"
            className="mt-2 w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700"
            onClick={(e) => {
              e.stopPropagation();
              onFeatureSelect(feature);
            }}
          >
            Edit Attributes
          </button>
        )}
        {!isMoveTarget && onFillQuestionnaire && (
          <button
            type="button"
            className="mt-1.5 w-full bg-emerald-600 text-white text-xs font-medium py-1.5 rounded hover:bg-emerald-700 flex items-center justify-center gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              onFillQuestionnaire(feature);
            }}
          >
            Fill Questionnaire Survey
          </button>
        )}
        {allowMoveActions && <button
          type="button"
          className="mt-2 w-full bg-indigo-600 text-white text-xs font-medium py-1.5 rounded hover:bg-indigo-700"
          onClick={(e) => {
            e.stopPropagation();
            onRequestMoveFeature?.(feature);
          }}
        >
          {isMoveTarget ? 'Move Mode Active' : 'Move Point'}
        </button>}
        {isMoveTarget && (
          <button
            type="button"
            className="mt-2 w-full bg-slate-100 text-slate-700 text-xs font-medium py-1.5 rounded hover:bg-slate-200"
            onClick={(e) => {
              e.stopPropagation();
              onCancelMoveFeature?.();
            }}
          >
            Cancel Move
          </button>
        )}
      </div>
    </Popup>}
  </CircleMarker>
  );
});

PointMarker.displayName = 'PointMarker';

// Memoized line renderer
const LineMarker = React.memo(({
  feature,
  isSelected,
  color,
  boundaryColor,
  borderWidth,
  opacity,
  labelText,
  interactive = true,
  labelColor,
  haloColor,
  fontSize,
  onFeatureSelect,
  onFillQuestionnaire,
  allowAttributeEdit = true,
  popupSettings,
}: {
  feature: GeoFeature;
  isSelected: boolean;
  color: string;
  boundaryColor?: string;
  borderWidth?: number;
  opacity?: number;
  labelText?: string;
  interactive?: boolean;
  labelColor: string;
  haloColor: string;
  fontSize: number;
  onFeatureSelect: (f: GeoFeature) => void;
  onFillQuestionnaire?: (f: GeoFeature) => void;
  allowAttributeEdit?: boolean;
  popupSettings?: MapPopupSettings;
}) => {
  const baseWeight = Math.max(0.5, Number(borderWidth ?? 3));
  const popupAttributes = mapPopupAttributeEntries(feature.attributes || {}, popupSettings);
  return (
  <Polyline
    interactive={interactive}
    positions={feature.geometry.coordinates.map((coord: [number, number]) => [coord[1], coord[0]])}
    pathOptions={{ 
      className: interactive ? undefined : 'survey-layer-inactive',
      color: isSelected ? '#3b82f6' : boundaryColor || color,
      opacity: opacity ?? 1,
      weight: isSelected ? baseWeight + 2 : baseWeight
    }}
    eventHandlers={{}}
  >
    {labelText && <Tooltip permanent direction="center" className="map-feature-label"><span style={{ color: labelColor, fontSize, textShadow: labelHaloShadow(haloColor) }}>{labelText}</span></Tooltip>}
    {interactive && <Popup autoPan={false}>
      <div className="min-w-[220px]">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <span>Line Feature</span>
            {(feature.attributes?.__layerName || feature.attributes?.layerName) && (
              <span className="text-[10px] bg-indigo-50 text-indigo-700 font-semibold px-1.5 py-0.5 rounded border border-indigo-100">
                {feature.attributes?.__layerName || feature.attributes?.layerName}
              </span>
            )}
          </p>
          <span className="text-[10px] text-slate-400 font-mono">#{feature.id.slice(0, 8)}</span>
        </div>
        <div className="max-h-40 overflow-auto border border-gray-100 rounded mb-2">
          <table className="w-full text-[10px]">
            <tbody>
              {popupAttributes.map(([k, v]) => (
                  <tr key={k} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-2 py-1 font-semibold text-gray-600 bg-gray-50">{k}</td>
                    <td className="px-2 py-1 text-gray-700">{String(v ?? '')}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {allowAttributeEdit && <button
          type="button"
          className="w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700"
          onClick={(e) => {
            e.stopPropagation();
            onFeatureSelect(feature);
          }}
        >
          Edit Attributes
        </button>}
        {onFillQuestionnaire && (
          <button
            type="button"
            className="mt-1.5 w-full bg-emerald-600 text-white text-xs font-medium py-1.5 rounded hover:bg-emerald-700 flex items-center justify-center gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              onFillQuestionnaire(feature);
            }}
          >
            Fill Questionnaire Survey
          </button>
        )}
      </div>
    </Popup>}
  </Polyline>
  );
});

LineMarker.displayName = 'LineMarker';

// Memoized polygon renderer
const PolygonMarker = React.memo(({
  feature,
  isSelected,
  color,
  fillColor,
  boundaryColor,
  borderWidth,
  opacity,
  labelText,
  interactive = true,
  labelColor,
  haloColor,
  fontSize,
  onFeatureSelect,
  onFillQuestionnaire,
  allowAttributeEdit = true,
  popupSettings,
}: {
  feature: GeoFeature;
  isSelected: boolean;
  color: string;
  fillColor?: string;
  boundaryColor?: string;
  borderWidth?: number;
  opacity?: number;
  labelText?: string;
  interactive?: boolean;
  labelColor: string;
  haloColor: string;
  fontSize: number;
  onFeatureSelect: (f: GeoFeature) => void;
  onFillQuestionnaire?: (f: GeoFeature) => void;
  allowAttributeEdit?: boolean;
  popupSettings?: MapPopupSettings;
}) => {
  const baseWeight = Math.max(0.5, Number(borderWidth ?? 1.5));
  const popupAttributes = mapPopupAttributeEntries(feature.attributes || {}, popupSettings);
  return (
  <Polygon
    interactive={interactive}
    positions={feature.geometry.coordinates[0].map((coord: [number, number]) => [coord[1], coord[0]])}
    pathOptions={{ 
      className: interactive ? undefined : 'survey-layer-inactive',
      color: isSelected ? '#3b82f6' : boundaryColor || color,
      fillColor: fillColor || color,
      fillOpacity: opacity ?? 0.4,
      weight: isSelected ? baseWeight + 2 : baseWeight
    }}
    eventHandlers={{}}
  >
    {labelText && <Tooltip permanent direction="center" className="map-feature-label"><span style={{ color: labelColor, fontSize, textShadow: labelHaloShadow(haloColor) }}>{labelText}</span></Tooltip>}
    {interactive && <Popup autoPan={false}>
      <div className="min-w-[220px]">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <span>Polygon Feature</span>
            {(feature.attributes?.__layerName || feature.attributes?.layerName) && (
              <span className="text-[10px] bg-teal-50 text-teal-700 font-semibold px-1.5 py-0.5 rounded border border-teal-100">
                {feature.attributes?.__layerName || feature.attributes?.layerName}
              </span>
            )}
          </p>
          <span className="text-[10px] text-slate-400 font-mono">#{feature.id.slice(0, 8)}</span>
        </div>
        <div className="max-h-40 overflow-auto border border-gray-100 rounded mb-2">
          <table className="w-full text-[10px]">
            <tbody>
              {popupAttributes.map(([k, v]) => (
                  <tr key={k} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-2 py-1 font-semibold text-gray-600 bg-gray-50">{k}</td>
                    <td className="px-2 py-1 text-gray-700">{String(v ?? '')}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {allowAttributeEdit && <button
          type="button"
          className="w-full bg-blue-600 text-white text-xs font-medium py-1.5 rounded hover:bg-blue-700"
          onClick={(e) => {
            e.stopPropagation();
            onFeatureSelect(feature);
          }}
        >
          Edit Attributes
        </button>}
        {onFillQuestionnaire && (
          <button
            type="button"
            className="mt-1.5 w-full bg-emerald-600 text-white text-xs font-medium py-1.5 rounded hover:bg-emerald-700 flex items-center justify-center gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              onFillQuestionnaire(feature);
            }}
          >
            Fill Questionnaire Survey
          </button>
        )}
      </div>
    </Popup>}
  </Polygon>
  );
});

PolygonMarker.displayName = 'PolygonMarker';

// Memoized landmark point from GeoJSON
const LandmarkGeoJsonPoint = React.memo(({
  p,
  idx,
  radius,
  adminEnumeratorDisplayName,
  onLandmarkPointSelect
}: {
  p: { lat: number; lng: number; properties: Record<string, any> };
  idx: number;
  radius: number;
  adminEnumeratorDisplayName?: string;
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
        {adminEnumeratorDisplayName ? (
          <div className="mb-2 pb-2 border-b border-amber-100">
            <p className="text-[10px] font-semibold text-amber-800 uppercase tracking-wide">Enumerator</p>
            <p className="text-sm font-bold text-slate-900 leading-snug">{adminEnumeratorDisplayName}</p>
          </div>
        ) : null}
        <p className="text-xs font-bold text-gray-700 mb-2">Landmark (GeoJSON)</p>
        <div className="max-h-44 overflow-auto border border-gray-100 rounded">
          <table className="w-full text-[10px]">
            <tbody>
              {normalizeLandmarkAttributesForDisplay(p.properties || {}, 'point').map(([k, v]) => (
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

// SurveyLocationCircle â€” renders a single HH-Survey GPS marker (one per
// questionnaire response). Dark-ash fill is distinct from existing layers
// (amber landmarks, status-coloured features) so the layer reads
// instantly. Outline encodes status so reviewers can tell drafts apart
// from submitted/reviewed at a glance.
const SURVEY_LOCATION_FILL = '#374151'; // gray-700 â€” dark ash
const SURVEY_LOCATION_OUTLINE_BY_STATUS: Record<string, string> = {
  draft: '#9ca3af',     // gray-400 â€” provisional / still in progress (pale ash)
  submitted: '#111827', // gray-900 â€” accepted, awaiting review (near-black ring)
  reviewed: '#16a34a'   // green-600 â€” fully processed (kept green for "done")
};
function formatSurveyTimestamp(value: unknown): string {
  if (!value) return 'â€”';
  try {
    // Firestore Timestamps expose `.toDate()`; ISO strings are also accepted.
    if (typeof value === 'object' && value && typeof (value as any).toDate === 'function') {
      return (value as any).toDate().toLocaleString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
  } catch {
    /* fall through to placeholder */
  }
  return 'â€”';
}
const SurveyLocationCircle: React.FC<{ point: SurveyLocationMarker }> = React.memo(({ point }) => {
  const status = point.status ?? 'submitted';
  const outline = SURVEY_LOCATION_OUTLINE_BY_STATUS[status] || SURVEY_LOCATION_OUTLINE_BY_STATUS.submitted;
  const tsLabel = formatSurveyTimestamp(point.submittedAt || point.capturedAt);
  return (
    <CircleMarker
      center={[point.lat, point.lng]}
      radius={6}
      pathOptions={{
        color: outline,
        fillColor: SURVEY_LOCATION_FILL,
        fillOpacity: 0.85,
        weight: 2
      }}
    >
      <Popup>
        <div className="min-w-[220px]">
          <div className="mb-2 pb-2 border-b border-slate-200">
            <p className="text-[10px] font-semibold text-slate-700 uppercase tracking-wide">
              HH Survey Location
            </p>
            <p className="text-sm font-bold text-slate-900 leading-snug">
              {point.respondentName || 'Unknown enumerator'}
            </p>
            {point.respondentEmail ? (
              <p className="text-[11px] text-slate-500">{point.respondentEmail}</p>
            ) : null}
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 font-semibold text-gray-600">Status</td>
                <td className="py-1 text-gray-800 capitalize">{status}</td>
              </tr>
              {point.questionnaireTitle ? (
                <tr className="border-b border-gray-100">
                  <td className="py-1 pr-2 font-semibold text-gray-600">Questionnaire</td>
                  <td className="py-1 text-gray-800">{point.questionnaireTitle}</td>
                </tr>
              ) : null}
              {point.ward ? (
                <tr className="border-b border-gray-100">
                  <td className="py-1 pr-2 font-semibold text-gray-600">Ward</td>
                  <td className="py-1 text-gray-800">{point.ward}</td>
                </tr>
              ) : null}
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 font-semibold text-gray-600">Lat</td>
                <td className="py-1 text-gray-800 font-mono">{point.lat.toFixed(6)}</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-2 font-semibold text-gray-600">Lng</td>
                <td className="py-1 text-gray-800 font-mono">{point.lng.toFixed(6)}</td>
              </tr>
              {typeof point.accuracy === 'number' ? (
                <tr className="border-b border-gray-100">
                  <td className="py-1 pr-2 font-semibold text-gray-600">Accuracy</td>
                  <td className="py-1 text-gray-800">Â±{Math.round(point.accuracy)} m</td>
                </tr>
              ) : null}
              <tr>
                <td className="py-1 pr-2 font-semibold text-gray-600">When</td>
                <td className="py-1 text-gray-800">{tsLabel}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Popup>
    </CircleMarker>
  );
});
SurveyLocationCircle.displayName = 'SurveyLocationCircle';

export const MapComponent: React.FC<MapComponentProps> = ({ 
  className,
  features, 
  projectId,
  wards = null,
  getAdminLandmarkEnumeratorDisplayName,
  enumeratorLandmarkWardFilter,
  onFeatureSelect, 
  activeSurveyLayerKeys = [],
  projectMapLayerStyles = {},
  projectMapLayerStylesByProject = {},
  surveyLayerActions = {},
  focusSelectedFeatures = true,
  onRequestMoveFeature,
  onCancelMoveFeature,
  onLandmarkPointSelect,
  onFillQuestionnaire,
  onSurveyActionRequest,
  selectedFeatureId,
  featureFocusRequestKey,
  movingFeatureId,
  onMapClick,
  addFeatureType,
  showPointAddBuffer = false,
  landmarkGeoJsonRefreshKey = 0,
  defaultShowLandmarks = true,
  defaultShowWards,
  surveyLocations,
  defaultShowSurveyLocations = true,
  onSurveyLocationsVisibilityChange,
  zoneBoundaries = null,
  importedZoneLayers,
  zoneFitKey = '',
  assignedBoundaryLayerKey = null,
  assignedBoundaryField = null,
  assignedBoundaryValues = [],
  defaultBaseMap = 'osm',
  defaultShowZones = true,
  importedExtentRequest = null,
  onMapViewChange,
  mapViewRestoreRequest = null,
}) => {
  const { location, requestLocation } = useGeoLocation();
  const { user, userProfile } = useAuth();
  const isAdminUser = userProfile?.role === 'admin';
  const isApprovedAdmin =
    userProfile?.role === 'admin' && userProfile?.status === 'approved';
  const isEnumeratorUser = userProfile?.role === 'enumerator';
  const hasWardLayer = !!(wards && Array.isArray(wards.features) && wards.features.length > 0);
  const [showWards, setShowWards] = useState(
    defaultShowWards ?? hasWardLayer
  );
  const [showZones, setShowZones] = useState(() => readStoredZoneVisibility(projectId, defaultShowZones));
  const [zoneLayerVisibility, setZoneLayerVisibility] = useState<Record<string, boolean>>(() => readStoredZoneLayerVisibility(projectId));
  const [mapLayerSettings, setMapLayerSettings] = useState(() => ({ ...readMapLayerSettings(projectId), ...projectMapLayerStyles }));
  const [showLandmarks, setShowLandmarks] = useState(defaultShowLandmarks);
  const [showSurveyLocations, setShowSurveyLocations] = useState(defaultShowSurveyLocations);
  // Multi-layer support: track visibility of user-imported layers (default: all visible)
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>(
    () => readStoredMapLayerVisibility(projectId)
  );

  useEffect(() => {
    onSurveyLocationsVisibilityChange?.(showSurveyLocations);
  }, [showSurveyLocations, onSurveyLocationsVisibilityChange]);
  const [showEnumeratorLocation, setShowEnumeratorLocation] = useState(true);
  const [enumeratorLocationFocusKey, setEnumeratorLocationFocusKey] = useState(0);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const layerControlContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showLayerPanel) return;
    const handleOutsideClick = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (layerControlContainerRef.current && target && !layerControlContainerRef.current.contains(target)) {
        setShowLayerPanel(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick, true);
    };
  }, [showLayerPanel]);
  const [baseMap, setBaseMap] = useState<'osm' | 'satellite' | 'hybrid'>(defaultBaseMap);
  const [mapZoom, setMapZoom] = useState(0);
  useEffect(() => {
    setBaseMap(defaultBaseMap);
  }, [defaultBaseMap]);
  useEffect(() => {
    setShowLandmarks(defaultShowLandmarks);
  }, [defaultShowLandmarks]);
  useEffect(() => {
    setShowWards(defaultShowWards ?? hasWardLayer);
  }, [defaultShowWards, hasWardLayer]);
  useEffect(() => {
    if (!projectId) return;
    try {
      window.localStorage.setItem(`${MAP_LAYER_VISIBILITY_PREFIX}${projectId}`, JSON.stringify(layerVisibility));
    } catch {
      /* storage unavailable */
    }
  }, [projectId, layerVisibility]);
  useEffect(() => {
    if (!projectId) return;
    try {
      window.localStorage.setItem(`${MAP_ZONE_VISIBILITY_PREFIX}${projectId}`, String(showZones));
    } catch {
      /* storage unavailable */
    }
  }, [projectId, showZones]);
  useEffect(() => {
    if (!projectId) return;
    try {
      window.localStorage.setItem(`${MAP_ZONE_LAYER_VISIBILITY_PREFIX}${projectId}`, JSON.stringify(zoneLayerVisibility));
    } catch {
      /* storage unavailable */
    }
  }, [projectId, zoneLayerVisibility]);
  useEffect(() => {
    setMapLayerSettings({ ...readMapLayerSettings(projectId), ...projectMapLayerStyles });
    return subscribeMapLayerSettings(() => setMapLayerSettings({ ...readMapLayerSettings(projectId), ...projectMapLayerStyles }));
  }, [projectId, projectMapLayerStyles]);
  const landmarksLayerEnabled = defaultShowLandmarks;
  const [landmarkIconScale, setLandmarkIconScale] = useState(readStoredLandmarkIconScale);
  const landmarkPoints = useLandmarkGeoJsonPoints(
    landmarksLayerEnabled ? landmarkGeoJsonRefreshKey : -1
  );
  const [pulseFeatureId, setPulseFeatureId] = useState<string | null>(null);
  const isAddingFeature = !!addFeatureType;
  const landmarkScaleHydratedRef = useRef(false);
  const pulseTimerRef = useRef<number | null>(null);

  // Group imported features by their layer name
  const distinctImportedLayers = useMemo(() => {
    const layerMap = new Map<string, { count: number; types: Set<string> }>();
    for (const f of features) {
      const name = importedLayerName(f);
      if (!name) continue;
      const existing = layerMap.get(name) || { count: 0, types: new Set<string>() };
      existing.count++;
      existing.types.add(f.type);
      layerMap.set(name, existing);
    }
    return Array.from(layerMap.entries()).map(([name, info]) => ({
      name,
      count: info.count,
      types: Array.from(info.types),
    }));
  }, [features]);

  const getLayerStyle = (kind: 'feature' | 'zone', id: string, layerProjectId?: string) => {
    const key = mapLayerStyleKey(kind, id);
    const projectStyles = layerProjectId ? projectMapLayerStylesByProject[layerProjectId] : undefined;
    const savedStyle = projectStyles
      ? projectStyles[key]
      : mapLayerSettings[key];
    return {
      ...DEFAULT_MAP_LAYER_STYLE,
      ...(kind === 'zone' ? { labelsVisible: true } : {}),
      ...savedStyle,
    };
  };

  const duplicateZonePolygonFeatureIds = useMemo(() => {
    if (!isEnumeratorUser) return new Set<string>();
    const zoneGeometryKeys = new Set<string>();
    const addZoneFeatures = (collection?: GeoJSON.FeatureCollection | null) => {
      for (const feature of collection?.features || []) {
        const geometryKey = polygonGeometryKey(feature.geometry);
        if (!geometryKey) continue;
        const projectKey = String(feature.properties?.__projectId || '');
        zoneGeometryKeys.add(`${projectKey}:${geometryKey}`);
      }
    };
    addZoneFeatures(zoneBoundaries);
    importedZoneLayers?.forEach((layer) => addZoneFeatures(layer.data));

    return new Set(
      features
        .filter((feature) => {
          if (feature.type !== 'polygon') return false;
          const projectKey = String(feature.attributes?.projectId || (feature as any).projectId || '');
          const geometryKey = polygonGeometryKey(feature.geometry);
          return !!geometryKey && zoneGeometryKeys.has(`${projectKey}:${geometryKey}`);
        })
        .map((feature) => feature.id)
    );
  }, [isEnumeratorUser, features, zoneBoundaries, importedZoneLayers]);

  const isFeatureLayerVisible = useCallback((f: GeoFeature) => {
    if (duplicateZonePolygonFeatureIds.has(f.id)) return false;
    const name = importedLayerName(f);
    if (!name) return true; // Default features without layer name are visible
    return layerVisibility[name] !== false; // Visible unless explicitly unchecked
  }, [duplicateZonePolygonFeatureIds, layerVisibility]);

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
    if (!userProfile?.uid) return;
    try {
      await geosurveyApi.updateUser(userProfile.uid, { landmarkIconScale: clamped });
    } catch (e) {
      console.error('Failed to persist landmark icon scale', e);
    }
  }, [userProfile?.uid]);

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

  const findMatchingFirestorePoint = (p: { lat: number; lng: number; properties: Record<string, any> }) =>
    findMatchingFirestoreLandmark(p, features);

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

  const landmarkGeoJsonAsFeature = useCallback(
    (p: { lat: number; lng: number; properties: Record<string, any> }): GeoFeature => ({
      id: '__landmark_geojson_popup__',
      type: 'point',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      attributes: p.properties || {},
      status: 'pending',
      createdBy: '',
      updatedBy: '',
      updatedAt: ''
    }),
    []
  );

  const combinedImportedZoneData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!importedZoneLayers?.length) return null;
    const visibleLayers = importedZoneLayers.filter(
      (layer) => zoneLayerVisibility[layer.id] !== false && layer.data?.features?.length > 0
    );
    if (!visibleLayers.length) return null;
    const allFeatures = visibleLayers.flatMap((layer) => layer.data.features);
    if (!allFeatures.length) return null;
    return {
      type: 'FeatureCollection',
      features: allFeatures,
    };
  }, [importedZoneLayers, zoneLayerVisibility]);

  const fallbackZoneStyle = useMemo(() => {
    const layerId = String(zoneBoundaries?.features?.[0]?.properties?.__layerId || '');
    const layerProjectId = String(zoneBoundaries?.features?.[0]?.properties?.__projectId || projectId || '');
    return getLayerStyle('zone', layerId, layerProjectId);
  }, [zoneBoundaries, mapLayerSettings, projectMapLayerStylesByProject, projectId]);

  return (
    <div className={`relative h-full ${className || 'w-full'}`}>
      <MapContainer 
        center={[23.7, 90.4]}
        zoom={7}
        zoomControl={false}
        attributionControl={false}
        maxZoom={30}
        className="w-full h-full"
      >
        <MapZoomListener onZoomChange={setMapZoom} />
        <FocusOnSelectedFeature feature={focusSelectedFeatures ? selectedFeature : null} focusRequestKey={featureFocusRequestKey} />
        <FitToImportedExtent request={importedExtentRequest} />
        <FitToImportedFeatures features={features} projectId={projectId} assignedLayerKey={assignedBoundaryLayerKey} assignedField={assignedBoundaryField} assignedValues={assignedBoundaryValues} />
        {combinedImportedZoneData && (
          <FitToZoneBoundaries data={combinedImportedZoneData} fitKey={zoneFitKey} />
        )}
        <MapViewBridge onMapViewChange={onMapViewChange} restoreRequest={mapViewRestoreRequest} />
        {baseMap === 'osm' && (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxNativeZoom={19}
            maxZoom={30}
          />
        )}
        {baseMap === 'satellite' && (
          <TileLayer
            attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={30}
          />
        )}
        {baseMap === 'hybrid' && (
          <TileLayer
            attribution='Map data &copy; Google'
            url="https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
            subdomains={['mt0', 'mt1', 'mt2', 'mt3']}
            maxNativeZoom={20}
            maxZoom={30}
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

        {/* Assigned / project zone boundaries from SHP import */}
        {importedZoneLayers?.map((zoneLayer) => {
          if (zoneLayerVisibility[zoneLayer.id] === false) return null;
          const style = getLayerStyle('zone', zoneLayer.id, zoneLayer.projectId);
          if (mapZoom < style.showFromZoom) return null;
          return (
          <React.Fragment key={`zone-layer-${zoneLayer.id}`}>
            <ScaleAwareZoneLayer
              data={zoneLayer.data}
              color={style.boundaryColor}
              fillColor={style.fillColor}
              borderWidth={style.borderWidth}
              opacity={style.opacity}
              labelsVisible={style.labelsVisible}
              labelsFromZoom={style.labelsFromZoom}
              labelField={style.labelField}
              labelColor={style.labelColor}
              haloColor={style.haloColor}
              fontSize={style.fontSize}
              layerName={zoneLayer.name}
              surveyLayerKey={`zone:${zoneLayer.id}`}
              projectId={projectId}
              interactive={surveyLayerKeyMatches(activeSurveyLayerKeys, `zone:${zoneLayer.id}`)}
              onFeatureSelect={onSurveyActionRequest}
            />
          </React.Fragment>
          );
        })}
        {(!importedZoneLayers?.length) && showZones && zoneBoundaries && zoneBoundaries.features?.length > 0 && (
          <>
            <FitToZoneBoundaries data={zoneBoundaries} fitKey={zoneFitKey} />
            {mapZoom >= fallbackZoneStyle.showFromZoom && <ScaleAwareZoneLayer
              data={zoneBoundaries}
              color={fallbackZoneStyle.boundaryColor}
              fillColor={fallbackZoneStyle.fillColor}
              borderWidth={fallbackZoneStyle.borderWidth}
              opacity={fallbackZoneStyle.opacity}
              labelsVisible={fallbackZoneStyle.labelsVisible}
              labelsFromZoom={fallbackZoneStyle.labelsFromZoom}
              labelField={fallbackZoneStyle.labelField}
              labelColor={fallbackZoneStyle.labelColor}
              haloColor={fallbackZoneStyle.haloColor}
              fontSize={fallbackZoneStyle.fontSize}
              layerName={String(zoneBoundaries.features[0]?.properties?.__label || 'Zones')}
              surveyLayerKey={`zone:${String(zoneBoundaries.features[0]?.properties?.__layerId || '')}`}
              projectId={projectId}
              interactive={surveyLayerKeyMatches(activeSurveyLayerKeys, `zone:${String(zoneBoundaries.features[0]?.properties?.__layerId || '')}`)}
              onFeatureSelect={onSurveyActionRequest}
            />}
          </>
        )}

        {/* Existing Features */}
        {features.filter(isFeatureLayerVisible).map(feature => {
          const isSelected = feature.id === selectedFeatureId;
          const isMoveTarget = feature.id === movingFeatureId;
          const isPulsing = feature.id === pulseFeatureId;
          const color = getFeatureColor(feature);
          const layerName = importedLayerName(feature);
          const isImportedLayerFeature = Boolean(layerName);
          const surveySelectable = isImportedLayerFeature && surveyLayerKeyMatches(activeSurveyLayerKeys, `feature:${layerName}`);
          const surveyAction = Object.entries(surveyLayerActions).find(([key]) => key.trim().normalize('NFKC').toLocaleLowerCase() === `feature:${layerName}`.trim().normalize('NFKC').toLocaleLowerCase())?.[1] || 'both';
          const featureProjectId = String(feature.attributes?.projectId || (feature as any).projectId || projectId || '');
          const layerStyle = isImportedLayerFeature ? getLayerStyle('feature', layerName, featureProjectId) : undefined;
          if (layerStyle && mapZoom < layerStyle.showFromZoom) return null;
          const fillColor = layerStyle?.fillColor || color;
          const boundaryColor = layerStyle?.boundaryColor || color;
          const borderWidth = layerStyle?.borderWidth;
          const opacity = layerStyle?.opacity;
          const labelField = layerStyle?.labelField;
          const labelText = layerStyle?.labelsVisible && mapZoom >= layerStyle.labelsFromZoom
            ? String((labelField ? feature.attributes?.[labelField] : undefined) ?? feature.attributes?.name ?? feature.attributes?.Name ?? feature.attributes?.label ?? '')
            : '';

          if (feature.type === 'point') {
            // For legacy CCC landmark points, respect showLandmarks. For generic uploaded / project features, show them on the map.
            const isLegacyCccLandmark = !feature.attributes?.__source && !feature.attributes?.projectId && !(feature as any).projectId;
            if (isLegacyCccLandmark && !showLandmarks) return null;
            const adminEnumeratorDisplayName =
              isApprovedAdmin && getAdminLandmarkEnumeratorDisplayName
                ? getAdminLandmarkEnumeratorDisplayName(feature)
                : undefined;
            return (
              <PointMarker
                key={`${feature.id}:${feature.status ?? 'pending'}:${surveySelectable ? 'active' : 'inactive'}`}
                feature={feature}
                isSelected={isSelected}
                isMoveTarget={isMoveTarget}
                isPulsing={isPulsing}
                color={fillColor}
                boundaryColor={boundaryColor}
                borderWidth={borderWidth}
                opacity={opacity}
                labelText={labelText}
                interactive={surveySelectable}
                labelColor={layerStyle?.labelColor || DEFAULT_MAP_LAYER_STYLE.labelColor}
                haloColor={layerStyle?.haloColor || DEFAULT_MAP_LAYER_STYLE.haloColor}
                fontSize={layerStyle?.fontSize ?? DEFAULT_MAP_LAYER_STYLE.fontSize}
                radius={radiusForLandmark(7, isSelected, isPulsing)}
                adminEnumeratorDisplayName={adminEnumeratorDisplayName}
                onFeatureSelect={handleFeatureSelect}
                onRequestMoveFeature={handleRequestMoveFeature}
                onCancelMoveFeature={handleCancelMoveFeature}
                onFillQuestionnaire={surveySelectable && surveyAction !== 'edit' ? onFillQuestionnaire : undefined}
                allowAttributeEdit={surveyAction !== 'questionnaire'}
                allowMoveActions={!isImportedLayerFeature}
                popupSettings={layerStyle}
              />
            );
          }

          if (feature.type === 'line') {
            return (
              <LineMarker
                key={`${feature.id}:${feature.status ?? 'pending'}:${surveySelectable ? 'active' : 'inactive'}`}
                feature={feature}
                isSelected={isSelected}
                color={fillColor}
                boundaryColor={boundaryColor}
                borderWidth={borderWidth}
                opacity={opacity}
                labelText={labelText}
                interactive={surveySelectable}
                labelColor={layerStyle?.labelColor || DEFAULT_MAP_LAYER_STYLE.labelColor}
                haloColor={layerStyle?.haloColor || DEFAULT_MAP_LAYER_STYLE.haloColor}
                fontSize={layerStyle?.fontSize ?? DEFAULT_MAP_LAYER_STYLE.fontSize}
                onFeatureSelect={handleFeatureSelect}
                onFillQuestionnaire={surveySelectable && surveyAction !== 'edit' ? onFillQuestionnaire : undefined}
                allowAttributeEdit={surveyAction !== 'questionnaire'}
                popupSettings={layerStyle}
              />
            );
          }

          if (feature.type === 'polygon') {
            return (
              <PolygonMarker
                key={`${feature.id}:${feature.status ?? 'pending'}:${surveySelectable ? 'active' : 'inactive'}`}
                feature={feature}
                isSelected={isSelected}
                color={fillColor}
                fillColor={fillColor}
                boundaryColor={boundaryColor}
                borderWidth={borderWidth}
                opacity={opacity}
                labelText={labelText}
                interactive={surveySelectable}
                labelColor={layerStyle?.labelColor || DEFAULT_MAP_LAYER_STYLE.labelColor}
                haloColor={layerStyle?.haloColor || DEFAULT_MAP_LAYER_STYLE.haloColor}
                fontSize={layerStyle?.fontSize ?? DEFAULT_MAP_LAYER_STYLE.fontSize}
                onFeatureSelect={handleFeatureSelect}
                onFillQuestionnaire={surveySelectable && surveyAction !== 'edit' ? onFillQuestionnaire : undefined}
                allowAttributeEdit={surveyAction !== 'questionnaire'}
                popupSettings={layerStyle}
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
              enumeratorLandmarkWardFilter,
              wards
            )
          )
          .filter((p) => {
            // If a Firestore record exists for this landmark, render ONLY the Firestore marker
            // (same status symbology) to avoid double-markers.
            return !findMatchingFirestorePoint(p);
          })
          .map((p, idx) => {
            const adminEnumeratorDisplayName =
              isApprovedAdmin && getAdminLandmarkEnumeratorDisplayName
                ? getAdminLandmarkEnumeratorDisplayName(landmarkGeoJsonAsFeature(p))
                : undefined;
            return (
              <LandmarkGeoJsonPoint
                key={`landmark_geojson_${idx}`}
                p={p}
                idx={idx}
                radius={radiusForLandmark(5, false, false)}
                adminEnumeratorDisplayName={adminEnumeratorDisplayName}
                onLandmarkPointSelect={handleLandmarkPointSelect}
              />
            );
          })}

        {/* HH Survey Location layer â€” one CircleMarker per questionnaire
            response GPS. Distinct violet fill keeps it readable against
            both green/red feature markers and amber landmark dots. Status
            tints the outline so reviewers can tell drafts apart from
            submitted/reviewed responses at a glance. */}
        {showSurveyLocations && Array.isArray(surveyLocations) && surveyLocations.map((p) => (
          <SurveyLocationCircle key={`survey_loc_${p.id}`} point={p} />
        ))}

        {/* Live GPS overlay:
            - Admins / point-add mode: accuracy circle + icon
            - Enumerator "My Current Location" toggle: icon only */}
        {location && ((isAdminUser && showEnumeratorLocation) || showPointAddBuffer) && (
          <>
            <FocusOnUserForPointAdd enabled={showPointAddBuffer} location={location} />
            <FocusOnEnumeratorLocation
              enabled={(isEnumeratorUser || isAdminUser) && showEnumeratorLocation}
              location={location}
              focusRequestKey={enumeratorLocationFocusKey}
            />
            <Circle 
              center={[location.lat, location.lng]} 
              radius={location.accuracy} 
              pathOptions={{ color: '#3b82f6', fillOpacity: 0.1, weight: 1 }} 
            />
            {showPointAddBuffer && (
              <Circle
                center={[location.lat, location.lng]}
                radius={NEW_POINT_ADD_PROXIMITY_METERS}
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
        {location && isEnumeratorUser && showEnumeratorLocation && !showPointAddBuffer && !isAdminUser && (
          <>
            <FocusOnEnumeratorLocation
              enabled={true}
              location={location}
              focusRequestKey={enumeratorLocationFocusKey}
            />
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
      <div ref={layerControlContainerRef} className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
        <button
          onClick={() => setShowLayerPanel((v) => !v)}
          className="p-3 rounded-xl shadow-lg bg-white text-blue-600 hover:bg-blue-50 transition-all"
          title="Layers"
        >
          <Layers size={20} />
        </button>
        {(isAdminUser || isEnumeratorUser) && showEnumeratorLocation && (
          <button
            type="button"
            onClick={() => {
              if (!location) requestLocation();
              setEnumeratorLocationFocusKey((key) => key + 1);
            }}
            className="rounded-xl bg-white p-3 text-blue-600 shadow-lg transition-all hover:bg-blue-50"
            title="Move map to my current location"
            aria-label="Move map to my current location"
          >
            <LocateFixed size={20} />
          </button>
        )}
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
              {defaultShowLandmarks && (
                <div className="flex items-center justify-between gap-2 font-medium text-slate-700 mb-2">
                  <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={showLandmarks}
                      onChange={(e) => setShowLandmarks(e.target.checked)}
                    />
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
              )}
              {hasWardLayer && (
                <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                  <input type="checkbox" checked={showWards} onChange={(e) => setShowWards(e.target.checked)} />
                  <span>Ward Boundaries</span>
                </label>
              )}
              {importedZoneLayers && importedZoneLayers.length > 0 ? (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Uploaded SHP layers</p>
                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {importedZoneLayers.map((item) => (
                      <label key={item.id} className="flex items-center justify-between gap-2 cursor-pointer font-medium text-slate-700">
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={zoneLayerVisibility[item.id] !== false}
                            onChange={(event) => setZoneLayerVisibility((previous) => ({ ...previous, [item.id]: event.target.checked }))}
                          />
                          <span className="truncate">{item.name}</span>
                        </span>
                        <span className="shrink-0 text-[11px] font-normal text-slate-500">({item.data.features.length})</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : zoneBoundaries && zoneBoundaries.features?.length > 0 ? (
                <label className="mt-2 flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={showZones}
                    onChange={(e) => setShowZones(e.target.checked)}
                  />
                  <span>
                    Zone Boundaries
                    <span className="text-[11px] font-normal text-slate-500">
                      {' '}
                      ({zoneBoundaries.features.length})
                    </span>
                  </span>
                </label>
              ) : null}
              {/* Only render the HH Survey Location toggle when the parent
                  actually supplies the layer data. Hiding the control when
                  there's nothing to show keeps the panel uncluttered for
                  consumers that don't care about questionnaire responses. */}
              {Array.isArray(surveyLocations) && (
                <label className="mt-2 flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={showSurveyLocations}
                    onChange={(e) => setShowSurveyLocations(e.target.checked)}
                  />
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full border-2"
                      style={{ backgroundColor: '#374151', borderColor: '#111827' }}
                      aria-hidden
                    />
                    HH Survey Location
                    <span className="text-[11px] font-normal text-slate-500">
                      ({surveyLocations.length})
                    </span>
                  </span>
                </label>
              )}
              {(isAdminUser || isEnumeratorUser) && (
                <label className="mt-2 flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={showEnumeratorLocation}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setShowEnumeratorLocation(checked);
                      if (checked) {
                        requestLocation();
                        setEnumeratorLocationFocusKey((k) => k + 1);
                      }
                    }}
                  />
                  <span className="flex items-center gap-1.5">
                    <LocateFixed className="h-4 w-4 text-blue-600" aria-hidden="true" />
                    My Current Location
                  </span>
                </label>
              )}
            </div>

            {/* Imported Geospatial Survey Layers */}
            {distinctImportedLayers.length > 0 && (
              <div className="border-t pt-2 mt-2">
                <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                  <span>Geospatial Layers</span>
                  <span className="text-[10px] bg-sky-50 text-sky-700 font-semibold px-1.5 py-0.5 rounded border border-sky-100">
                    {distinctImportedLayers.length}
                  </span>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {distinctImportedLayers.map((lyr) => {
                    const isVisible = layerVisibility[lyr.name] !== false;
                    const legendStyle = getLayerStyle('feature', lyr.name, projectId);
                    const legendBorderWidth = Math.max(1, Number(legendStyle.borderWidth ?? 2));
                    return (
                      <div key={lyr.name} className="rounded-lg hover:bg-slate-50">
                      <div className="flex items-center gap-2 p-1.5 text-xs">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isVisible}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setLayerVisibility((prev) => ({
                                ...prev,
                                [lyr.name]: checked,
                              }));
                            }}
                            className="rounded text-sky-600 focus:ring-sky-500"
                          />
                          <div className="flex shrink-0 items-center gap-0.5">
                            {lyr.types.map((type) => (
                              <span key={type} title={`${type} legend`} aria-label={`${type} legend`} className="flex h-5 w-5 items-center justify-center">
                                {type === 'point' ? (
                                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: legendStyle.fillColor, border: `${legendBorderWidth}px solid ${legendStyle.boundaryColor}` }} />
                                ) : type === 'line' ? (
                                  <span className="block w-4" style={{ borderTop: `${legendBorderWidth}px solid ${legendStyle.boundaryColor}` }} />
                                ) : (
                                  <span className="h-3 w-4 rounded-[2px]" style={{ backgroundColor: legendStyle.opacity === 0 ? 'transparent' : legendStyle.fillColor, border: `${legendBorderWidth}px solid ${legendStyle.boundaryColor}` }} />
                                )}
                              </span>
                            ))}
                          </div>
                          <span className={`min-w-0 whitespace-normal break-words font-medium leading-tight ${isVisible ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                            {lyr.name}
                          </span>
                        </label>
                        <span className="text-right text-[10px] text-slate-400">({lyr.count})</span>
                      </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
