/**
 * Admin panel: import zone SHP, review attribute table, set assignment field.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Upload, Trash2, RefreshCw, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { Project, ZoneLayer, ZonePolygon } from '../types';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import {
  parseZoneShapefileZip,
  suggestAssignmentField,
  suggestLabelField,
  type ParsedZoneFeature,
  type ParsedZoneLayer,
} from '../lib/parseShapefile';
import { updateProjectSegments } from '../lib/projects';
import { ASSIGNED_ZONE_BUFFER_METERS } from '../lib/pointInPolygon';
import { startGeospatialServerTask } from '../lib/geospatialUploadManager';

interface ZoneLayerPanelProps {
  project: Project;
  onClose?: () => void;
  onChanged?: (layer: ZoneLayer | null) => void;
}

interface PendingZoneLayer extends ParsedZoneLayer {
  assignmentField: string;
  labelField: string;
}

export const ZoneLayerPanel: React.FC<ZoneLayerPanelProps> = ({
  project,
  onClose,
  onChanged,
}) => {
  const [layer, setLayer] = useState<ZoneLayer | null>(null);
  const [layers, setLayers] = useState<ZoneLayer[]>([]);
  const [polygons, setPolygons] = useState<ZonePolygon[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingFeatures, setPendingFeatures] = useState<ParsedZoneFeature[] | null>(null);
  const [pendingLayers, setPendingLayers] = useState<PendingZoneLayer[]>([]);
  const [activePendingLayer, setActivePendingLayer] = useState(0);
  const [pendingFields, setPendingFields] = useState<string[]>([]);
  const [assignmentField, setAssignmentField] = useState<string>('');
  const [labelField, setLabelField] = useState<string>('');
  const [layerName, setLayerName] = useState('Zones');
  const [strictGeofence, setStrictGeofence] = useState(true);
  const [showAttributeTable, setShowAttributeTable] = useState(false);

  // Keep parent callback stable so load()/effects never loop on identity churn.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const notifyChanged = useCallback((next: ZoneLayer | null) => {
    onChangedRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await zoneLayersApi.listLayers(project.id);
      setLayers(items);
      const current = items[0] || null;
      setLayer(current);
      setShowAttributeTable(false);
      if (current) {
        setAssignmentField(current.assignmentField || '');
        setLabelField(current.labelField || current.assignmentField || '');
        setLayerName(current.name || 'Zones');
        setStrictGeofence(current.strictGeofence !== false);
        const { items: polys } = await zoneLayersApi.listPolygons({ layerId: current.id });
        setPolygons(polys);
      } else {
        setPolygons([]);
      }
      // Do not call onChanged here — initial/refresh load must not bump parent state
      // (that caused an infinite Loading… flash loop).
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const tableRows = useMemo(() => {
    if (pendingFeatures) {
      return pendingFeatures.map((f, i) => ({
        id: `p_${i}`,
        properties: f.properties,
      }));
    }
    return polygons.map((p) => ({ id: p.id, properties: p.properties }));
  }, [pendingFeatures, polygons]);

  const columns = useMemo(() => {
    if (pendingFields.length) return pendingFields;
    if (layer?.attributeFields?.length) return layer.attributeFields;
    const keys = new Set<string>();
    for (const r of tableRows) {
      Object.keys(r.properties || {}).forEach((k) => keys.add(k));
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [pendingFields, layer, tableRows]);

  const choosePendingLayer = (index: number) => {
    const item = pendingLayers[index];
    if (!item) return;
    setActivePendingLayer(index);
    setPendingFeatures(item.features);
    setPendingFields(item.attributeFields);
    setAssignmentField(item.assignmentField);
    setLabelField(item.labelField);
    setLayerName(item.name);
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const parsed = await parseZoneShapefileZip(file);
      const nextLayers = parsed.layers.map((item) => {
        const suggestedAssign = suggestAssignmentField(item.attributeFields);
        const suggestedLabel = suggestLabelField(item.attributeFields);
        return {
          ...item,
          assignmentField: suggestedAssign || '',
          labelField: suggestedLabel || suggestedAssign || '',
        };
      });
      const first = nextLayers[0];
      setPendingLayers(nextLayers);
      setActivePendingLayer(0);
      setPendingFeatures(first.features);
      setPendingFields(first.attributeFields);
      setAssignmentField(first.assignmentField);
      setLabelField(first.labelField);
      setLayerName(first.name);
      setNotice(`Parsed ${nextLayers.length} SHP layer(s) with ${parsed.features.length.toLocaleString()} polygon(s). Review each layer, then import.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingFeatures(null);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!pendingLayers.length) return;
    const layersToImport = pendingLayers.map((item, index) => index === activePendingLayer
      ? { ...item, name: layerName || item.name, assignmentField, labelField }
      : item);
    if (layersToImport.some((item) => !item.assignmentField)) {
      setError('Select an assignment field for every SHP layer before importing.');
      return;
    }
    setBusy(true);
    setError(null);
    startGeospatialServerTask({
      projectId: project.id,
      projectName: project.name,
      label: `${layersToImport.length} SHP layers`,
      total: layersToImport.reduce((sum, item) => sum + item.features.length, 0),
      run: async () => {
      try {
      const results = [];
      for (const item of layersToImport) {
        const result = await zoneLayersApi.importLayer({
          projectId: project.id,
          name: item.name,
          assignmentField: item.assignmentField,
          labelField: item.labelField || item.assignmentField || null,
          attributeFields: item.attributeFields,
          strictGeofence,
          polygons: item.features.map((f) => {
            const raw = f.properties[item.assignmentField];
            const assignValue = raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw).trim();
            return { assignValue, properties: f.properties, geometry: f.geometry };
          }),
        });
        results.push(result);
      }
      setPendingFeatures(null);
      setPendingLayers([]);
      setPendingFields([]);
      const activeResult = results[results.length - 1];
      setLayer(activeResult.layer);
      setPolygons(activeResult.polygons);
      setLayers((previous) => [...results.map((result) => result.layer).reverse(), ...previous.filter((item) => !results.some((result) => result.layer.id === item.id))]);
      setShowAttributeTable(false);
      try {
        await updateProjectSegments(project.id, { questionnaireGeofence: strictGeofence });
      } catch (syncErr) {
        console.warn('Could not sync project questionnaireGeofence after import', syncErr);
      }
      setNotice(`Imported ${results.length} SHP layer(s) and ${results.reduce((sum, result) => sum + result.polygons.length, 0).toLocaleString()} zone(s). Assign enumerators in User Management.`);
      notifyChanged(activeResult.layer);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(false);
      }
      }
    });
  };

  const saveMeta = async () => {
    if (!layer) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await zoneLayersApi.updateLayer(layer.id, {
        name: layerName,
        assignmentField: assignmentField || null,
        labelField: labelField || null,
        strictGeofence,
      });
      setLayer(updated);
      setLayers((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      const { items: polys } = await zoneLayersApi.listPolygons({ layerId: updated.id });
      setPolygons(polys);
      // Keep project "merge · strict geofence" segment aligned with zone setting.
      try {
        await updateProjectSegments(project.id, { questionnaireGeofence: strictGeofence });
      } catch (syncErr) {
        console.warn('Could not sync project questionnaireGeofence', syncErr);
      }
      setNotice('Zone layer settings saved.');
      notifyChanged(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectLayer = async (selected: ZoneLayer) => {
    setLayer(selected);
    setAssignmentField(selected.assignmentField || '');
    setLabelField(selected.labelField || selected.assignmentField || '');
    setLayerName(selected.name || 'Zones');
    setStrictGeofence(selected.strictGeofence !== false);
    setShowAttributeTable(false);
    setLoading(true);
    setError(null);
    try {
      const { items } = await zoneLayersApi.listPolygons({ layerId: selected.id });
      setPolygons(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const removeLayer = async (target: ZoneLayer) => {
    if (!confirm(`Delete "${target.name}" and all ${target.featureCount} polygon(s) from the server? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await zoneLayersApi.deleteLayer(target.id);
      const remaining = layers.filter((item) => item.id !== target.id);
      setLayers(remaining);
      setPendingFeatures(null);
      if (layer?.id === target.id) {
        const next = remaining[0] || null;
        setLayer(next);
        setPolygons([]);
        setShowAttributeTable(false);
        if (next) {
          setAssignmentField(next.assignmentField || '');
          setLabelField(next.labelField || next.assignmentField || '');
          setLayerName(next.name || 'Zones');
          setStrictGeofence(next.strictGeofence !== false);
          const { items } = await zoneLayersApi.listPolygons({ layerId: next.id });
          setPolygons(items);
        }
        if (remaining.length === 0) setNotice('No SHP layers remain for this project.');
      } else {
        setNotice(`Deleted SHP layer "${target.name}".`);
      }
      notifyChanged(remaining[0] || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-sky-50 to-emerald-50">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0">
            <Layers size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-slate-900 truncate">Zone boundaries</h3>
            <p className="text-[11px] text-slate-500 truncate">
              {project.name} · import SHP → assign by attribute
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy}
            className="p-2 text-slate-500 hover:bg-white/70 rounded-lg"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {onClose && (
            <button type="button" onClick={onClose} className="p-2 text-slate-500 hover:bg-white/70 rounded-lg">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
        {notice && (
          <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {notice}
          </div>
        )}

        <section className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between bg-slate-50 px-3 py-2">
            <div>
              <h4 className="text-xs font-bold text-slate-800">Uploaded SHP layers</h4>
              <p className="text-[10px] text-slate-500">{layers.length} layer(s) · newest layer is active for assignment/geofencing</p>
            </div>
          </div>
          {layers.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-400">No SHP layers uploaded yet.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {layers.map((item, index) => (
                <div key={item.id} className={`flex items-center gap-2 px-3 py-2 ${item.id === layer?.id ? 'bg-sky-50/70' : 'bg-white'}`}>
                  <button type="button" onClick={() => void selectLayer(item)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-semibold text-slate-800">{item.name}</span>
                    <span className="block text-[10px] text-slate-500">{item.featureCount} polygons · {item.assignmentField || 'No assignment field'}</span>
                  </button>
                  {index === 0 && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-700">Active</span>}
                  <button type="button" onClick={() => void removeLayer(item)} disabled={busy} className="rounded p-1.5 text-red-500 hover:bg-red-50 disabled:opacity-40" title={`Delete ${item.name} from server`} aria-label={`Delete ${item.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {pendingLayers.length > 1 && (
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">SHP layers in this ZIP</span>
            <select value={activePendingLayer} onChange={(event) => choosePendingLayer(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
              {pendingLayers.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name} · {item.features.length.toLocaleString()} polygons</option>)}
            </select>
          </label>
        )}

        {(layer || pendingLayers.length > 0) && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Layer name</span>
            <input
              value={layerName}
              onChange={(e) => {
                const value = e.target.value;
                setLayerName(value);
                if (pendingLayers.length) setPendingLayers((previous) => previous.map((item, index) => index === activePendingLayer ? { ...item, name: value } : item));
              }}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Assignment field
            </span>
            <select
              value={assignmentField}
              onChange={(e) => {
                const value = e.target.value;
                setAssignmentField(value);
                if (pendingLayers.length) setPendingLayers((previous) => previous.map((item, index) => index === activePendingLayer ? { ...item, assignmentField: value } : item));
              }}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">— select —</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-slate-400">
              Used to assign enumerators in User Management.
            </span>
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Label field
            </span>
            <select
              value={labelField}
              onChange={(e) => {
                const value = e.target.value;
                setLabelField(value);
                if (pendingLayers.length) setPendingLayers((previous) => previous.map((item, index) => index === activePendingLayer ? { ...item, labelField: value } : item));
              }}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">— select —</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-slate-400">
              Shown as the zone name on the map.
            </span>
          </label>
        </div>}

        {layer && pendingLayers.length === 0 && <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={strictGeofence}
            onChange={(e) => setStrictGeofence(e.target.checked)}
            className="rounded border-slate-300 text-sky-600"
          />
          Strict geofence — surveys are allowed inside assigned zones and up to{' '}
          {ASSIGNED_ZONE_BUFFER_METERS} m outside their boundaries
        </label>}

        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold cursor-pointer hover:bg-sky-700 disabled:opacity-50">
            <Upload size={16} />
            {busy ? 'Working…' : 'Upload SHP ZIP'}
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              disabled={busy}
              onChange={(e) => void onPickFile(e.target.files?.[0] || null)}
            />
          </label>
          {pendingLayers.length > 0 && (
            <button
              type="button"
              disabled={busy || pendingLayers.some((item, index) => !(index === activePendingLayer ? assignmentField : item.assignmentField))}
              onClick={() => void doImport()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={16} />
              Import {pendingLayers.length} layer{pendingLayers.length === 1 ? '' : 's'} · {pendingLayers.reduce((sum, item) => sum + item.features.length, 0).toLocaleString()} zones
            </button>
          )}
          {layer && !pendingFeatures && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveMeta()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900 disabled:opacity-50"
            >
              Save settings
            </button>
          )}
        </div>

        {layer && <div>
          <button type="button" aria-expanded={showAttributeTable} onClick={() => setShowAttributeTable((shown) => !shown)} className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50">
            <span>
              <span className="block text-xs font-bold uppercase tracking-wider text-slate-600">Attribute table</span>
              <span className="block text-[10px] text-slate-400">{tableRows.length} row(s) · {layer.name}</span>
            </span>
            {showAttributeTable ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {showAttributeTable && <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              {layer.name}
            </h4>
            <span className="text-[11px] text-slate-400">{tableRows.length} row(s)</span>
          </div>
          {loading && tableRows.length === 0 ? (
            <p className="text-sm text-slate-400 italic">Loading…</p>
          ) : tableRows.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              No zones yet. Upload a polygon shapefile ZIP to begin.
            </p>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-auto max-h-72">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c}
                        className={`px-2 py-1.5 text-left font-bold text-slate-600 whitespace-nowrap ${
                          c === assignmentField
                            ? 'bg-sky-100 text-sky-800'
                            : c === labelField
                              ? 'bg-emerald-100 text-emerald-800'
                              : ''
                        }`}
                      >
                        {c}
                        {c === assignmentField ? ' ★' : ''}
                        {c === labelField ? ' ◆' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.slice(0, 500).map((row) => (
                    <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                      {columns.map((c) => (
                        <td key={c} className="px-2 py-1 whitespace-nowrap text-slate-700 max-w-[12rem] truncate">
                          {row.properties[c] == null ? '' : String(row.properties[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {tableRows.length > 500 && (
                <p className="text-[10px] text-slate-400 px-2 py-1">Showing first 500 rows.</p>
              )}
            </div>
          )}
          </div>}
        </div>}
      </div>
    </div>
  );
};
