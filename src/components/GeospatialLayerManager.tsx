import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Trash2, X, Loader2, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { GeoFeature, SurveyLayerAction, ZoneLayer, ZonePolygon } from '../types';
import { geosurveyApi } from '../lib/geosurveyApi';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import {
  DEFAULT_MAP_LAYER_STYLE,
  mapLayerStyleKey,
  readMapLayerSettings,
  writeMapLayerStyle,
  type MapLayerStyle,
} from '../lib/mapLayerSettings';

interface Props {
  projectId: string;
  activeSurveyLayerKeys: string[];
  surveyLayerActions: Record<string, SurveyLayerAction>;
  surveyLayerQuestionFields: Record<string, string[]>;
  projectStyles: Record<string, MapLayerStyle>;
  assignmentLayerId?: string | null;
  assignmentField?: string | null;
  features: GeoFeature[];
  zoneLayers: ZoneLayer[];
  onClose: () => void;
  onFeaturesChanged: () => void;
  onZonesChanged: () => void;
  onActiveSurveyLayersChanged: (layerKeys: string[], actions: Record<string, SurveyLayerAction>, questionFields: Record<string, string[]>) => Promise<void>;
  onLayerStylesChanged: (styles: Record<string, MapLayerStyle>) => Promise<void>;
  onAssignmentLayerChanged: (layerId: string | null, field: string | null) => Promise<void>;
}

type ManagedLayer = {
  key: string;
  id: string;
  name: string;
  kind: 'feature' | 'zone';
  count: number;
  fields: string[];
  featureIds?: string[];
  surveyKey: string;
};

const layerNameOf = (feature: GeoFeature) => {
  const attrs = feature.attributes || {};
  const name = String(attrs.__layerName || attrs.layerName || (feature as any).layerName || '').trim();
  if (name) return name;
  return attrs.__source === 'geojson_upload' || attrs.__source === 'shapefile_upload' || attrs.projectId || (feature as any).projectId
    ? 'Unassigned layer'
    : '';
};

export const GeospatialLayerManager: React.FC<Props> = ({
  projectId,
  activeSurveyLayerKeys,
  surveyLayerActions,
  surveyLayerQuestionFields,
  projectStyles,
  assignmentLayerId,
  assignmentField,
  features,
  zoneLayers,
  onClose,
  onFeaturesChanged,
  onZonesChanged,
  onActiveSurveyLayersChanged,
  onLayerStylesChanged,
  onAssignmentLayerChanged,
}) => {
  const managedLayers = useMemo<ManagedLayer[]>(() => {
    const grouped = new Map<string, GeoFeature[]>();
    for (const feature of features) {
      const name = layerNameOf(feature);
      if (!name) continue;
      grouped.set(name, [...(grouped.get(name) || []), feature]);
    }
    const featureLayers = [...grouped.entries()].map(([name, items]) => {
      const fields = new Set<string>();
      items.forEach((feature) => Object.keys(feature.attributes || {}).filter((field) => !field.startsWith('__')).forEach((field) => fields.add(field)));
      return {
        key: mapLayerStyleKey('feature', name), id: name, name, kind: 'feature' as const, surveyKey: `feature:${name}`,
        count: items.length, fields: [...fields].sort((a, b) => a.localeCompare(b)),
        featureIds: items.map((feature) => String(feature.id)),
        isPolygon: items.length > 0 && items.every((feature) => ['Polygon', 'MultiPolygon'].includes(String(feature.geometry?.type))),
      };
    });
    const boundaries = zoneLayers.map((layer) => ({
      key: mapLayerStyleKey('zone', layer.id), id: layer.id, name: layer.name, kind: 'zone' as const, surveyKey: `zone:${layer.id}`,
      count: layer.featureCount, fields: layer.attributeFields || [],
      isPolygon: true,
    }));
    return [...boundaries, ...featureLayers];
  }, [features, zoneLayers]);

  const [selectedKey, setSelectedKey] = useState('');
  const selected = managedLayers.find((item) => item.key === selectedKey) || managedLayers[0] || null;
  const [styles, setStyles] = useState(() => ({ ...readMapLayerSettings(projectId), ...projectStyles }));
  const migratedProjectStylesRef = useRef('');
  const [activeSurveyKeys, setActiveSurveyKeys] = useState(activeSurveyLayerKeys);
  const [layerActions, setLayerActions] = useState(surveyLayerActions);
  const [linkedQuestionFields, setLinkedQuestionFields] = useState(surveyLayerQuestionFields);
  const style: MapLayerStyle = { ...DEFAULT_MAP_LAYER_STYLE, ...(selected?.kind === 'zone' ? { labelsVisible: true } : {}), ...(selected ? styles[selected.key] : {}) };
  const [rows, setRows] = useState<Array<{ id: string; properties: Record<string, unknown> }>>([]);
  const [showAttributeTable, setShowAttributeTable] = useState(false);
  const [attributeSearchQuery, setAttributeSearchQuery] = useState('');
  const [showAllRows, setShowAllRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingSurveyLayer, setSavingSurveyLayer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setActiveSurveyKeys(activeSurveyLayerKeys), [activeSurveyLayerKeys]);
  useEffect(() => setLayerActions(surveyLayerActions), [surveyLayerActions]);
  useEffect(() => setLinkedQuestionFields(surveyLayerQuestionFields), [surveyLayerQuestionFields]);
  useEffect(() => setStyles((current) => ({ ...current, ...projectStyles })), [projectStyles]);
  useEffect(() => {
    if (!projectId || migratedProjectStylesRef.current === projectId) return;
    migratedProjectStylesRef.current = projectId;
    const legacyStyles = readMapLayerSettings(projectId);
    const merged = { ...legacyStyles, ...projectStyles };
    setStyles(merged);
    if (Object.keys(legacyStyles).some((key) => !projectStyles[key])) {
      void onLayerStylesChanged(merged).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [projectId]);

  useEffect(() => {
    setShowAttributeTable(false);
    setAttributeSearchQuery('');
    setShowAllRows(false);
  }, [selected?.key]);

  useEffect(() => {
    if (!selected) {
      setRows([]);
      return;
    }
    if (selected.kind === 'feature') {
      setRows(features.filter((feature) => layerNameOf(feature) === selected.name).map((feature) => ({ id: feature.id, properties: feature.attributes || {} })));
      return;
    }
    let cancelled = false;
    void zoneLayersApi.listPolygons({ layerId: selected.id }).then(({ items }) => {
      if (!cancelled) setRows(items.map((polygon: ZonePolygon) => ({ id: polygon.id, properties: polygon.properties || {} })));
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [selected?.key, features, zoneLayers]);

  const columns = useMemo(() => {
    if (selected?.fields.length) return selected.fields;
    const fields = new Set<string>();
    rows.forEach((row) => Object.keys(row.properties).forEach((field) => fields.add(field)));
    return [...fields].sort((a, b) => a.localeCompare(b));
  }, [selected, rows]);

  const filteredRows = useMemo(() => {
    const query = attributeSearchQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      Object.values(row.properties).some((val) => {
        if (val == null) return false;
        return String(val).toLowerCase().includes(query);
      })
    );
  }, [rows, attributeSearchQuery]);

  const changeLayerStyle = (key: string, patch: Partial<MapLayerStyle>) => {
    const currentStyle = { ...DEFAULT_MAP_LAYER_STYLE, ...(styles[key] || {}) };
    const next = { ...currentStyle, ...patch };
    const updated = { ...styles, [key]: next };
    setStyles(updated);
    writeMapLayerStyle(projectId, key, next);
    void onLayerStylesChanged(updated).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const changeStyle = (patch: Partial<MapLayerStyle>) => {
    if (selected) changeLayerStyle(selected.key, patch);
  };

  const toggleSurveyLayer = async (layerName: string) => {
    if (savingSurveyLayer) return;
    const next = activeSurveyKeys.includes(layerName)
      ? activeSurveyKeys.filter((key) => key !== layerName)
      : [...activeSurveyKeys, layerName];
    setActiveSurveyKeys(next);
    setError(null);
    setSavingSurveyLayer(true);
    try {
      await onActiveSurveyLayersChanged(next, layerActions, linkedQuestionFields);
    } catch (e) {
      setActiveSurveyKeys(activeSurveyKeys);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSurveyLayer(false);
    }
  };

  const changeSurveyLayerAction = async (layerKey: string, action: SurveyLayerAction) => {
    if (savingSurveyLayer) return;
    const next = { ...layerActions, [layerKey]: action };
    setLayerActions(next);
    setSavingSurveyLayer(true);
    setError(null);
    try {
      await onActiveSurveyLayersChanged(activeSurveyKeys, next, linkedQuestionFields);
    } catch (e) {
      setLayerActions(layerActions);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSurveyLayer(false);
    }
  };

  const toggleQuestionField = async (field: string) => {
    if (!selected || savingSurveyLayer) return;
    const current = linkedQuestionFields[selected.surveyKey] || [];
    const fields = current.includes(field) ? current.filter((item) => item !== field) : [...current, field];
    const next = { ...linkedQuestionFields, [selected.surveyKey]: fields };
    setLinkedQuestionFields(next);
    setSavingSurveyLayer(true);
    setError(null);
    try {
      await onActiveSurveyLayersChanged(activeSurveyKeys, layerActions, next);
    } catch (e) {
      setLinkedQuestionFields(linkedQuestionFields);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSurveyLayer(false);
    }
  };

  const removeLayer = async (target: ManagedLayer) => {
    if (!window.confirm(`Delete "${target.name}" and all ${target.count.toLocaleString()} records from the server? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'zone') {
        await zoneLayersApi.deleteLayer(target.id);
        onZonesChanged();
      } else {
        const ids = target.featureIds || [];
        const result = await geosurveyApi.bulkDeleteFeatures(ids);
        if (result.count !== ids.length) throw new Error(`Server deleted ${result.count} of ${ids.length} features. Refresh and retry.`);
        if (activeSurveyKeys.includes(target.surveyKey)) {
          const next = activeSurveyKeys.filter((key) => key !== target.surveyKey);
          const nextActions = { ...layerActions };
          delete nextActions[target.surveyKey];
          const nextQuestionFields = { ...linkedQuestionFields };
          delete nextQuestionFields[target.surveyKey];
          await onActiveSurveyLayersChanged(next, nextActions, nextQuestionFields);
          setLayerActions(nextActions);
          setLinkedQuestionFields(nextQuestionFields);
          setActiveSurveyKeys(next);
        }
        onFeaturesChanged();
      }
      if (target.kind === 'zone' && activeSurveyKeys.includes(target.surveyKey)) {
        const next = activeSurveyKeys.filter((key) => key !== target.surveyKey);
        const nextActions = { ...layerActions };
        delete nextActions[target.surveyKey];
        const nextQuestionFields = { ...linkedQuestionFields };
        delete nextQuestionFields[target.surveyKey];
        await onActiveSurveyLayersChanged(next, nextActions, nextQuestionFields);
        setLayerActions(nextActions);
        setLinkedQuestionFields(nextQuestionFields);
        setActiveSurveyKeys(next);
      }
      if (selectedKey === target.key) setSelectedKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-r border-gray-200 w-full sm:w-[440px] md:w-[500px] lg:w-[540px]" role="dialog" aria-modal="true" aria-label="Manage map layers">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-gray-100 bg-gray-50/70 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-100 flex items-center justify-center text-sky-700 shrink-0">
              <Layers size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-gray-800 text-sm truncate">Manage Map Layers</h2>
              <p className="text-[10px] text-gray-500 truncate">Symbology, labels, attribute table & boundary assignment</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors text-gray-500 shrink-0 ml-2" aria-label="Close layer manager"><X size={20} /></button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <aside className="max-h-64 sm:max-h-72 shrink-0 overflow-y-auto border-b border-slate-200 p-3 bg-slate-50/50">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">Project layers ({managedLayers.length})</p>
            <div className="space-y-1">
              {managedLayers.map((item) => {
                return (
                <div key={item.key} className={`flex items-center gap-2 rounded-lg border px-2 py-2 ${selected?.key === item.key ? 'border-sky-300 bg-sky-50' : 'border-transparent hover:bg-slate-50'}`}>
                  <button type="button" onClick={() => { setSelectedKey(item.key); setError(null); }} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 shrink-0 rounded-sm border" style={{ backgroundColor: (styles[item.key]?.opacity ?? DEFAULT_MAP_LAYER_STYLE.opacity) === 0 ? 'transparent' : (styles[item.key]?.fillColor || DEFAULT_MAP_LAYER_STYLE.fillColor), borderColor: styles[item.key]?.boundaryColor || DEFAULT_MAP_LAYER_STYLE.boundaryColor, borderWidth: `${Math.max(1, Number(styles[item.key]?.borderWidth ?? DEFAULT_MAP_LAYER_STYLE.borderWidth ?? 2))}px`, opacity: 1 }} />
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">{item.name}</span>
                    </span>
                    <span className="block pl-5 text-[10px] text-slate-500">{item.kind === 'zone' ? 'Boundary SHP' : 'Map feature layer'} · {item.count.toLocaleString()} records</span>
                  </button>
                  {activeSurveyKeys.includes(item.surveyKey) && <select aria-label={`${item.name} survey popup actions`} title="Actions available from this layer's map popup" value={layerActions[item.surveyKey] || 'both'} disabled={busy || savingSurveyLayer} onChange={(event) => void changeSurveyLayerAction(item.surveyKey, event.target.value as SurveyLayerAction)} className="max-w-28 rounded border border-emerald-200 bg-white px-1.5 py-1 text-[9px] text-slate-700 disabled:opacity-50">
                    <option value="edit">Edit attributes</option>
                    <option value="questionnaire">Questionnaire survey</option>
                    <option value="both">Both</option>
                  </select>}
                  {item.isPolygon && <label title="Use this polygon layer to assign enumerator boundaries" className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[9px] font-medium text-sky-800"><input type="checkbox" checked={assignmentLayerId === item.key || assignmentLayerId === item.id} disabled={busy} onChange={() => void onAssignmentLayerChanged(assignmentLayerId === item.key || assignmentLayerId === item.id ? null : (item.kind === 'zone' ? item.id : item.key), item.kind === 'zone' ? null : (item.fields[0] || null))} />Boundary assign</label>}
                  {item.kind === 'feature' && assignmentLayerId === item.key && <select aria-label={`${item.name} boundary assignment field`} title="Attribute used to assign boundary areas" value={assignmentField || ''} onChange={(event) => void onAssignmentLayerChanged(item.key, event.target.value || null)} className="max-w-24 rounded border border-sky-200 bg-white px-1 py-1 text-[9px] text-sky-900">{item.fields.map((field) => <option key={field} value={field}>{field}</option>)}</select>}
                  <label title="Allow enumerators to select this layer for questionnaire surveys" className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[9px] font-medium text-emerald-800">
                    <input type="checkbox" checked={activeSurveyKeys.includes(item.surveyKey)} disabled={busy || savingSurveyLayer} onChange={() => void toggleSurveyLayer(item.surveyKey)} />Survey
                  </label>
                  <button type="button" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`} disabled={busy} onClick={() => void removeLayer(item)} className="shrink-0 rounded p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={14} /></button>
                </div>
                );
              })}
              {managedLayers.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">No uploaded map layers in this project.</p>}
            </div>
          </aside>
          {selected ? (
            <main className="min-h-0 flex-1 overflow-y-auto p-3">
              {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
              <div className="mb-4 flex items-start justify-between gap-3">
                <div><h3 className="text-sm font-bold text-slate-900">{selected.name}</h3><p className="text-[10px] text-slate-500">{selected.count.toLocaleString()} records · {selected.kind === 'zone' ? 'Boundary SHP' : 'Map feature layer'}</p></div>
              </div>
              {busy && <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-red-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-red-500" /></div>}
              <section className="mb-4 rounded-xl border border-slate-200 p-3">
                <h4 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-slate-500">Layer management</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-slate-600">Fill color</span>
                      <label title="Disable fill (transparent interior)" className="inline-flex cursor-pointer items-center gap-1 text-[10px] font-medium text-slate-600">
                        <input
                          type="checkbox"
                          checked={style.opacity === 0}
                          onChange={(e) => {
                            if (e.target.checked) {
                              changeStyle({ opacity: 0 });
                            } else {
                              changeStyle({ opacity: 0.25 });
                            }
                          }}
                          className="h-3 w-3 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <span>No fill</span>
                      </label>
                    </div>
                    <input
                      type="color"
                      disabled={style.opacity === 0}
                      value={style.fillColor}
                      onChange={(e) => changeStyle({ fillColor: e.target.value })}
                      className="mt-1 block h-9 w-full cursor-pointer rounded border border-slate-200 p-1 disabled:cursor-not-allowed disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="min-w-0 flex-1 text-[10px] font-semibold text-slate-600">
                      Boundary / line color
                      <input type="color" value={style.boundaryColor} onChange={(e) => changeStyle({ boundaryColor: e.target.value })} className="mt-1 block h-9 w-full cursor-pointer rounded border border-slate-200 p-1" />
                    </label>
                    <label title="Boundary or line stroke width in points/pixels (e.g. 1, 1.5, 2, 3 pt)" className="w-20 shrink-0 text-[10px] font-semibold text-slate-600">
                      Width (pt)
                      <input
                        aria-label="Boundary or line stroke width"
                        type="number"
                        min="0.5"
                        max="20"
                        step="0.1"
                        value={style.borderWidth ?? 2}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!Number.isNaN(val)) {
                            const rounded = Math.round(val * 10) / 10;
                            changeStyle({ borderWidth: rounded });
                          }
                        }}
                        className="mt-1 block h-9 w-full rounded border border-slate-200 px-2 py-1 text-right font-mono text-xs text-slate-800 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                    </label>
                  </div>
                  <label className="text-[10px] font-semibold text-slate-600">Fill opacity · {Math.round(style.opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={style.opacity} onChange={(e) => changeStyle({ opacity: Number(e.target.value) })} className="mt-2 block w-full" /></label>
                  <label className="text-[10px] font-semibold text-slate-600">Label field<select value={style.labelField} onChange={(e) => changeStyle({ labelField: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-2 text-xs"><option value="">Use layer default</option>{columns.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>
                  <label className="flex items-center gap-2 text-[10px] font-semibold text-slate-600">
                    <input type="checkbox" checked={style.showFromZoom > 0} onChange={(e) => changeStyle({ showFromZoom: e.target.checked ? 17 : 0 })} />
                    <span className="flex-1">Show features only from zoom</span>
                    {style.showFromZoom > 0 && <input aria-label="Show features from zoom level" type="number" min="0" max="30" step="1" value={style.showFromZoom} onChange={(e) => changeStyle({ showFromZoom: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} className="h-8 w-14 rounded-lg border border-slate-200 px-2 text-xs font-semibold" />}
                  </label>
                  <div className="col-span-2 grid grid-cols-[minmax(6.5rem,1fr)_auto_auto_minmax(6rem,auto)] items-center gap-2 border-t border-slate-100 pt-2">
                    <label className="flex items-center gap-2 whitespace-nowrap text-[10px] font-semibold text-slate-600">
                      <input type="checkbox" checked={style.labelsVisible} onChange={(e) => changeStyle({ labelsVisible: e.target.checked })} />
                      <span>Show labels only from zoom</span>
                      {style.labelsVisible && <input aria-label="Show labels from zoom level" type="number" min="0" max="30" step="1" value={style.labelsFromZoom} onChange={(e) => changeStyle({ labelsFromZoom: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} className="h-8 w-14 rounded-lg border border-slate-200 px-2 text-xs font-semibold" />}
                    </label>
                    <label title="Label text color" className="flex items-center gap-1 text-[9px] text-slate-500">Text<input aria-label="Label text color" type="color" value={style.labelColor} onChange={(e) => changeStyle({ labelColor: e.target.value })} className="h-7 w-8 cursor-pointer rounded border border-slate-200 p-0.5" /></label>
                    <label title="Label halo color" className="flex items-center gap-1 text-[9px] text-slate-500">Halo<input aria-label="Label halo color" type="color" value={style.haloColor} onChange={(e) => changeStyle({ haloColor: e.target.value })} className="h-7 w-8 cursor-pointer rounded border border-slate-200 p-0.5" /></label>
                    <label title="Label font size in pixels (e.g. 11, 11.5, 12)" className="flex items-center gap-1 text-[9px] text-slate-600 font-medium">
                      Size
                      <div className="flex items-center">
                        <input
                          aria-label="Label font size in pixels"
                          type="number"
                          min="4"
                          max="48"
                          step="0.1"
                          value={style.fontSize ?? 11}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!Number.isNaN(val)) {
                              const rounded = Math.round(val * 10) / 10;
                              changeStyle({ fontSize: rounded });
                            }
                          }}
                          className="h-7 w-16 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs text-slate-800 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                        <span className="ml-1 text-[9px] text-slate-400">px</span>
                      </div>
                    </label>
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-slate-400">Changes apply immediately and sync to enumerator devices. Set each threshold independently; zoom 0 keeps that content visible at every zoom.</p>
              </section>
              <section>
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 transition hover:border-slate-300">
                  <button
                    type="button"
                    aria-expanded={showAttributeTable}
                    onClick={() => setShowAttributeTable((shown) => !shown)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="shrink-0 text-slate-500">
                      {showAttributeTable ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <span className="min-w-0 truncate">
                      <span className="block text-[11px] font-bold uppercase tracking-wide text-slate-700">Attribute table</span>
                      <span className="block text-[10px] text-slate-400">
                        {rows.length.toLocaleString()} record(s) · {showAttributeTable ? (showAllRows ? 'All' : 'Top 5') : 'Click to expand'}
                      </span>
                    </span>
                  </button>

                  {/* Search input appears on the same header line ONLY while the table is expanded */}
                  {showAttributeTable && (
                    <div className="relative flex w-44 shrink-0 items-center animate-in fade-in duration-150 sm:w-52">
                      <Search size={13} className="pointer-events-none absolute left-2 text-slate-400" />
                      <input
                        type="text"
                        value={attributeSearchQuery}
                        onChange={(e) => {
                          setAttributeSearchQuery(e.target.value);
                          setShowAllRows(false);
                        }}
                        placeholder="Search attributes..."
                        className="h-7 w-full rounded-md border border-slate-200 bg-slate-50/70 pl-7 pr-6 text-[11px] text-slate-800 placeholder-slate-400 focus:border-sky-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                      {attributeSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setAttributeSearchQuery('')}
                          className="absolute right-1.5 text-slate-400 hover:text-slate-600"
                          title="Clear search"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {showAttributeTable && (
                  <div className="space-y-2">
                    <div className="max-h-[26vh] overflow-auto rounded-xl border border-slate-200 bg-white">
                      {filteredRows.length > 0 ? (
                        <>
                          <table className="min-w-full text-[10px]">
                            <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm">
                              <tr>
                                <th className="w-8 px-2 py-1.5 text-center font-bold text-slate-400">#</th>
                                {columns.map((field) => (
                                  <th key={field} className="whitespace-nowrap px-2 py-1.5 text-left font-bold text-slate-600">
                                    <div>{field}</div>
                                    {selected && activeSurveyKeys.includes(selected.surveyKey) && (
                                      <label title={`Include ${field} in the linked questionnaire response`} className="mt-1 flex items-center gap-1 text-[9px] font-medium text-emerald-700">
                                        <input
                                          type="checkbox"
                                          checked={(linkedQuestionFields[selected.surveyKey] || []).includes(field)}
                                          disabled={savingSurveyLayer}
                                          onChange={() => void toggleQuestionField(field)}
                                        />
                                        Link
                                      </label>
                                    )}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(showAllRows ? filteredRows : filteredRows.slice(0, 5)).map((row, idx) => (
                                <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                                  <td className="px-2 py-1 text-center font-mono text-[9px] text-slate-400">{idx + 1}</td>
                                  {columns.map((field) => (
                                    <td key={field} className="max-w-48 truncate whitespace-nowrap px-2 py-1 text-slate-700">
                                      {row.properties[field] == null ? '' : String(row.properties[field])}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {filteredRows.length > 5 && (
                            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-3 py-1.5 text-[10px] text-slate-500">
                              <span>
                                Showing {showAllRows ? filteredRows.length : 5} of {filteredRows.length.toLocaleString()} matching row(s)
                              </span>
                              <button
                                type="button"
                                onClick={() => setShowAllRows((prev) => !prev)}
                                className="font-semibold text-sky-600 hover:text-sky-800 hover:underline"
                              >
                                {showAllRows ? 'Show top 5 only' : `Show all ${filteredRows.length.toLocaleString()} rows`}
                              </button>
                            </div>
                          )}
                        </>
                      ) : rows.length === 0 ? (
                        <p className="p-3 text-xs text-slate-400">Loading attribute records…</p>
                      ) : (
                        <p className="p-3 text-xs text-slate-400">No matching attribute records found for "{attributeSearchQuery}".</p>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </main>
          ) : <main className="flex items-center justify-center p-8 text-sm text-slate-400">Select a layer to manage it.</main>}
        </div>
      </div>
    </div>
  );
};
