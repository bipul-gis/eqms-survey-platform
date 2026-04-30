import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Polygon, useMapEvents, Circle, CircleMarker, GeoJSON, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { GeoFeature, WardBoundary } from '../types';
import { useGeoLocation } from './GeoLocationProvider';
import { MapPin, Navigation, Info, Layers } from 'lucide-react';
import landmarkGeoJsonUrl from '../data/CCC_all_Landmark.geojson?url';

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
  onFeatureSelect: (feature: GeoFeature) => void;
  onLandmarkPointSelect?: (point: { lat: number; lng: number; properties: Record<string, any> }) => void;
  selectedFeatureId?: string;
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

  useEffect(() => {
    if (!enabled || !location) return;
    // Zoom to user location when entering point-add mode.
    map.flyTo([location.lat, location.lng], Math.max(map.getZoom(), 19), {
      duration: 0.6
    });
  }, [enabled, location, map]);

  return null;
};

export const MapComponent: React.FC<MapComponentProps> = ({ 
  features, 
  wards, 
  onFeatureSelect, 
  onLandmarkPointSelect,
  selectedFeatureId,
  onMapClick,
  addFeatureType,
  showPointAddBuffer = false
}) => {
  const { location } = useGeoLocation();
  const [showWards, setShowWards] = useState(true);
  const [landmarkPoints, setLandmarkPoints] = useState<Array<{ lat: number; lng: number; properties: Record<string, any> }>>([]);
  const isAddingFeature = !!addFeatureType;

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

  const wardStyle = {
    color: '#ef4444', // Red boundary
    weight: 2,
    opacity: 0.8,
    fillColor: 'transparent', // No fill
    fillOpacity: 0,
    dashArray: '5, 5' // Dashed line for better visibility
  };

  return (
    <div className="relative w-full h-full">
      <MapContainer 
        center={[22.3569, 91.7832]} // Chattogram, Bangladesh
        zoom={13} 
        className="w-full h-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Ward Boundaries (Non-editable) */}
        {showWards && wards && (
          <GeoJSON 
            data={wards} 
            style={wardStyle}
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
          const color = getStatusColor(feature.status);

          if (feature.type === 'point') {
            return (
              <CircleMarker
                key={feature.id}
                center={[feature.geometry.coordinates[1], feature.geometry.coordinates[0]]}
                radius={isSelected ? 10 : 7}
                pathOptions={{ 
                  color: isSelected ? '#3b82f6' : color, 
                  fillColor: color, 
                  fillOpacity: 0.9,
                  weight: isSelected ? 3 : 2
                }}
              >
                <Popup>
                  <div className="min-w-[240px]">
                    <p className="text-xs font-bold text-gray-700 mb-2">Landmark Attributes</p>
                    <div className="max-h-48 overflow-auto border border-gray-100 rounded">
                      <table className="w-full text-[10px]">
                        <tbody>
                          {Object.entries(feature.attributes || {}).map(([k, v]) => (
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
                  </div>
                </Popup>
              </CircleMarker>
            );
          }

          if (feature.type === 'line') {
            return (
              <Polyline
                key={feature.id}
                positions={feature.geometry.coordinates.map((coord: [number, number]) => [coord[1], coord[0]])}
                pathOptions={{ 
                  color: isSelected ? '#3b82f6' : color, 
                  weight: isSelected ? 6 : 4 
                }}
                eventHandlers={{
                  click: () => onFeatureSelect(feature)
                }}
              />
            );
          }

          if (feature.type === 'polygon') {
            return (
              <Polygon
                key={feature.id}
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
            );
          }

          return null;
        })}

        {/* Landmark points from CCC_all_Landmark.geojson (read-only visual layer).
            Hide a GeoJSON point when a matching Firestore feature exists so users
            always interact with the live/editable record after first edit/create. */}
        {landmarkPoints
          .filter((p) => {
            const fid = p.properties?.FID;
            const hasFirestoreMatch = features.some((f) => {
              if (f.type !== 'point') return false;
              if (fid !== undefined && f.attributes?.FID === fid) return true;
              if (!Array.isArray(f.geometry?.coordinates)) return false;
              return (
                Math.abs((f.geometry.coordinates[1] ?? 0) - p.lat) < 0.0000001 &&
                Math.abs((f.geometry.coordinates[0] ?? 0) - p.lng) < 0.0000001
              );
            });
            return !hasFirestoreMatch;
          })
          .map((p, idx) => (
          <CircleMarker
            key={`landmark_geojson_${idx}`}
            center={[p.lat, p.lng]}
            radius={5}
            pathOptions={{
              color: '#1d4ed8',
              fillColor: '#3b82f6',
              fillOpacity: 0.85,
              weight: 1.5
            }}
          >
            <Popup>
              <div className="min-w-[220px]">
                <p className="text-xs font-bold text-gray-700 mb-2">Landmark (GeoJSON)</p>
                <div className="max-h-44 overflow-auto border border-gray-100 rounded">
                  <table className="w-full text-[10px]">
                    <tbody>
                      {Object.entries(p.properties).map(([k, v]) => (
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

        {isAddingFeature && onMapClick && <MapEvents onClick={onMapClick} />}
      </MapContainer>

      {/* Map UI Controls */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-2">
        <button 
          onClick={() => setShowWards(!showWards)}
          className={`p-3 rounded-xl shadow-lg transition-all ${showWards ? 'bg-white text-blue-600' : 'bg-gray-100 text-gray-500'}`}
          title="Toggle Wards"
        >
          <Layers size={20} />
        </button>
      </div>

    </div>
  );
};
