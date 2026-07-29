/**
 * Admin panel: import zone SHP, review attribute table, set assignment field.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Upload, Trash2, RefreshCw, Check, X } from 'lucide-react';
import type { Project, ZoneLayer, ZonePolygon } from '../types';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import {
  parseZoneShapefileZip,
  suggestAssignmentField,
  suggestLabelField,
  type ParsedZoneFeature,
} from '../lib/parseShapefile';
import { updateProjectSegments } from '../lib/projects';
import { ASSIGNED_ZONE_BUFFER_METERS } from '../lib/pointInPolygon';

interface ZoneLayerPanelProps {
  project: Project;
  onClose?: () => void;
  onChanged?: (layer: ZoneLayer | null) => void;
}

export const ZoneLayerPanel: React.FC<ZoneLayerPanelProps> = ({
  project,
  onClose,
  onChanged,
}) => {
  const [layer, setLayer] = useState<ZoneLayer | null>(null);
  const [polygons, setPolygons] = useState<ZonePolygon[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingFeatures, setPendingFeatures] = useState<ParsedZoneFeature[] | null>(null);
  const [pendingFields, setPendingFields] = useState<string[]>([]);
  const [assignmentField, setAssignmentField] = useState<string>('');
  const [labelField, setLabelField] = useState<string>('');
  const [layerName, setLayerName] = useState('Zones');
  const [strictGeofence, setStrictGeofence] = useState(true);

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
      const current = items[0] || null;
      setLayer(current);
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

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { features, attributeFields } = await parseZoneShapefileZip(file);
      setPendingFeatures(features);
      setPendingFields(attributeFields);
      const suggestedAssign = suggestAssignmentField(attributeFields);
      const suggestedLabel = suggestLabelField(attributeFields);
      setAssignmentField(suggestedAssign || '');
      setLabelField(suggestedLabel || suggestedAssign || '');
      setLayerName(file.name.replace(/\.zip$/i, '') || 'Zones');
      setNotice(`Parsed ${features.length} polygon(s). Choose assignment & label fields, then Import.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingFeatures(null);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!pendingFeatures?.length) return;
    if (!assignmentField) {
      setError('Select an assignment field from the attribute table.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await zoneLayersApi.importLayer({
        projectId: project.id,
        name: layerName || 'Zones',
        assignmentField,
        labelField: labelField || assignmentField || null,
        attributeFields: pendingFields,
        strictGeofence,
        polygons: pendingFeatures.map((f) => {
          const raw = f.properties[assignmentField];
          const assignValue =
            raw === null || raw === undefined || String(raw).trim() === ''
              ? null
              : String(raw).trim();
          return {
            assignValue,
            properties: f.properties,
            geometry: f.geometry,
          };
        }),
      });
      setPendingFeatures(null);
      setPendingFields([]);
      setLayer(result.layer);
      setPolygons(result.polygons);
      try {
        await updateProjectSegments(project.id, { questionnaireGeofence: strictGeofence });
      } catch (syncErr) {
        console.warn('Could not sync project questionnaireGeofence after import', syncErr);
      }
      setNotice(`Imported ${result.polygons.length} zone(s). Assign enumerators in User Management.`);
      notifyChanged(result.layer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  const removeLayer = async () => {
    if (!layer) return;
    if (!confirm('Delete this zone layer and all polygons for the project?')) return;
    setBusy(true);
    try {
      await zoneLayersApi.deleteLayer(layer.id);
      setLayer(null);
      setPolygons([]);
      setPendingFeatures(null);
      setNotice('Zone layer deleted. Questionnaire-only mode until a new SHP is imported.');
      notifyChanged(null);
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Layer name</span>
            <input
              value={layerName}
              onChange={(e) => setLayerName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Assignment field
            </span>
            <select
              value={assignmentField}
              onChange={(e) => setAssignmentField(e.target.value)}
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
              onChange={(e) => setLabelField(e.target.value)}
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
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={strictGeofence}
            onChange={(e) => setStrictGeofence(e.target.checked)}
            className="rounded border-slate-300 text-sky-600"
          />
          Strict geofence — surveys are allowed inside assigned zones and up to{' '}
          {ASSIGNED_ZONE_BUFFER_METERS} m outside their boundaries
        </label>

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
          {pendingFeatures && (
            <button
              type="button"
              disabled={busy || !assignmentField}
              onClick={() => void doImport()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={16} />
              Import {pendingFeatures.length} zones
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
          {layer && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeLayer()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 text-red-700 text-sm font-semibold hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={16} />
              Delete layer
            </button>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Attribute table
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
        </div>
      </div>
    </div>
  );
};
