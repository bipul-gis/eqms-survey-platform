export interface MapLayerStyle {
  fillColor: string;
  boundaryColor: string;
  opacity: number;
  labelField: string;
  labelsVisible: boolean;
  labelColor: string;
  haloColor: string;
  fontSize: number;
  borderWidth?: number;
  showFromZoom: number;
  labelsFromZoom: number;
  /** Popup fields omitted by default when explicitly hidden by an admin. */
  popupHiddenFields?: string[];
  /** Popup field names keyed by their source attribute. */
  popupFieldLabels?: Record<string, string>;
}

export type MapPopupSettings = Pick<MapLayerStyle, 'popupHiddenFields' | 'popupFieldLabels'>;

export const DEFAULT_MAP_LAYER_STYLE: MapLayerStyle = {
  fillColor: '#f59e0b',
  boundaryColor: '#b45309',
  opacity: 0.4,
  labelField: '',
  labelsVisible: false,
  labelColor: '#0f172a',
  haloColor: '#ffffff',
  fontSize: 11,
  borderWidth: 2,
  showFromZoom: 0,
  labelsFromZoom: 17,
};

export function mapPopupAttributeEntries(
  attributes: Record<string, unknown>,
  settings?: MapPopupSettings
): Array<[string, unknown]> {
  const hidden = new Set(settings?.popupHiddenFields || []);
  const labels = settings?.popupFieldLabels || {};
  return Object.entries(attributes || {})
    .filter(([field]) => !field.startsWith('_') && !field.startsWith('__') && !hidden.has(field))
    .map(([field, value]) => [labels[field]?.trim() || field, value]);
}

const prefix = 'eqms.mapLayerSettings:';
const eventName = 'eqms-map-layer-settings-updated';

export const mapLayerStyleKey = (kind: 'feature' | 'zone', id: string) => `${kind}:${id}`;

export function readMapLayerSettings(projectId?: string): Record<string, MapLayerStyle> {
  if (!projectId || typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${prefix}${projectId}`) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeMapLayerStyle(projectId: string, key: string, style: MapLayerStyle): void {
  const current = readMapLayerSettings(projectId);
  window.localStorage.setItem(`${prefix}${projectId}`, JSON.stringify({ ...current, [key]: style }));
  window.dispatchEvent(new Event(eventName));
}

export function subscribeMapLayerSettings(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener('storage', listener);
  };
}
