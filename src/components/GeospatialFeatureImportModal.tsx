import React, { useState } from 'react';
import { Upload, X, Check, FileJson, AlertCircle, MapPin, Eye } from 'lucide-react';
import type { GeoFeature, FeatureType } from '../types';
import { geosurveyApi } from '../lib/geosurveyApi';

interface GeospatialFeatureImportModalProps {
  projectId: string;
  projectName: string;
  currentUserEmail?: string;
  currentUserUid?: string;
  onClose: () => void;
  onSuccess: (count: number) => void;
}

interface ParsedFeatureItem {
  id: string;
  type: FeatureType;
  geometry: any;
  attributes: Record<string, any>;
  propertiesCount: number;
}

export const GeospatialFeatureImportModal: React.FC<GeospatialFeatureImportModalProps> = ({
  projectId,
  projectName,
  currentUserEmail,
  currentUserUid,
  onClose,
  onSuccess,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [parsedFeatures, setParsedFeatures] = useState<ParsedFeatureItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<{ points: number; lines: number; polygons: number } | null>(null);

  const handleFileChange = async (selectedFile: File | null) => {
    if (!selectedFile) return;
    setError(null);
    setFile(selectedFile);
    setIsProcessing(true);

    try {
      const text = await selectedFile.text();
      let rawJson: any;
      try {
        rawJson = JSON.parse(text);
      } catch (jsonErr) {
        throw new Error('Invalid JSON format. Please upload a valid .geojson or .json file.');
      }

      let rawFeatures: any[] = [];
      if (rawJson.type === 'FeatureCollection' && Array.isArray(rawJson.features)) {
        rawFeatures = rawJson.features;
      } else if (rawJson.type === 'Feature') {
        rawFeatures = [rawJson];
      } else if (Array.isArray(rawJson)) {
        rawFeatures = rawJson.filter((item) => item && (item.type === 'Feature' || item.geometry));
      } else if (rawJson.geometry) {
        rawFeatures = [{ type: 'Feature', geometry: rawJson.geometry, properties: rawJson.properties || {} }];
      } else {
        throw new Error('Unrecognized GeoJSON structure. Expected FeatureCollection or Feature.');
      }

      if (rawFeatures.length === 0) {
        throw new Error('No geospatial features found in this file.');
      }

      const items: ParsedFeatureItem[] = [];
      let points = 0;
      let lines = 0;
      let polygons = 0;

      for (let i = 0; i < rawFeatures.length; i++) {
        const feat = rawFeatures[i];
        const geom = feat.geometry;
        if (!geom || !geom.type || !geom.coordinates) continue;

        let type: FeatureType = 'point';
        const geomType = String(geom.type).toLowerCase();

        if (geomType === 'point' || geomType === 'multipoint') {
          type = 'point';
          points++;
        } else if (geomType === 'linestring' || geomType === 'multilinestring') {
          type = 'line';
          lines++;
        } else if (geomType === 'polygon' || geomType === 'multipolygon') {
          type = 'polygon';
          polygons++;
        } else {
          continue; // Skip unsupported geometry types
        }

        const props = (feat.properties && typeof feat.properties === 'object') ? { ...feat.properties } : {};
        const featId = feat.id != null ? String(feat.id) : `feat_${Date.now()}_${i + 1}`;

        items.push({
          id: featId,
          type,
          geometry: geom,
          attributes: {
            ...props,
            __source: 'geojson_upload',
            projectId,
          },
          propertiesCount: Object.keys(props).length,
        });
      }

      if (items.length === 0) {
        throw new Error('No supported Point, LineString, or Polygon features found in this file.');
      }

      setParsedFeatures(items);
      setSummary({ points, lines, polygons });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setParsedFeatures([]);
      setSummary(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = async () => {
    if (parsedFeatures.length === 0) return;
    setIsUploading(true);
    setError(null);

    try {
      const now = new Date().toISOString();
      const featuresToUpload: Record<string, unknown>[] = parsedFeatures.map((item) => ({
        id: item.id,
        type: item.type,
        geometry: item.geometry,
        attributes: item.attributes,
        status: 'pending',
        projectId,
        createdBy: currentUserEmail || 'admin',
        createdByUid: currentUserUid || null,
        updatedBy: currentUserEmail || 'admin',
        updatedAt: now,
      }));

      // Bulk upload in chunks of 500
      const CHUNK_SIZE = 500;
      let totalSaved = 0;

      for (let i = 0; i < featuresToUpload.length; i += CHUNK_SIZE) {
        const chunk = featuresToUpload.slice(i, i + CHUNK_SIZE);
        const res = await geosurveyApi.bulkSaveFeatures(chunk);
        totalSaved += res.count || chunk.length;
      }

      onSuccess(totalSaved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import features to server.');
    } finally {
      setIsUploading(false);
    }
  };

  const sampleAttributes = parsedFeatures[0]?.attributes
    ? Object.entries(parsedFeatures[0].attributes).filter(([k]) => !k.startsWith('__'))
    : [];

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-gradient-to-r from-sky-600 to-indigo-700 px-6 py-4 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/10 rounded-xl">
              <Upload size={22} className="text-white" />
            </div>
            <div>
              <h3 className="text-base font-bold">Import Geospatial Features (GeoJSON)</h3>
              <p className="text-xs text-sky-100">Project: {projectName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="p-1 hover:bg-white/20 rounded-full transition"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3.5 text-xs flex items-start gap-2.5">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{error}</div>
            </div>
          )}

          {/* File input drag/drop box */}
          <div className="border-2 border-dashed border-slate-300 hover:border-sky-500 rounded-2xl p-6 text-center transition-colors bg-slate-50/50">
            <input
              type="file"
              id="geojson-file-upload"
              accept=".geojson,.json,application/json,application/geo+json"
              className="hidden"
              disabled={isProcessing || isUploading}
              onChange={(e) => void handleFileChange(e.target.files?.[0] || null)}
            />
            <label
              htmlFor="geojson-file-upload"
              className="cursor-pointer flex flex-col items-center gap-2 text-slate-600"
            >
              <div className="w-12 h-12 rounded-2xl bg-sky-100 text-sky-700 flex items-center justify-center">
                <FileJson size={26} />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {file ? file.name : 'Choose a GeoJSON / JSON file'}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Points, lines (polylines), and polygons will be imported for this project
                </p>
              </div>
              <span className="mt-2 text-xs font-semibold px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg shadow-sm hover:bg-slate-50">
                Browse File
              </span>
            </label>
          </div>

          {/* Feature Breakdown Summary */}
          {summary && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center justify-between">
                <span>Features Found: {parsedFeatures.length}</span>
                <span className="text-[10px] text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  Valid GeoJSON
                </span>
              </h4>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-base font-bold text-sky-700">{summary.points}</div>
                  <div className="text-[11px] text-slate-500 font-medium">Points</div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-base font-bold text-indigo-700">{summary.lines}</div>
                  <div className="text-[11px] text-slate-500 font-medium">Lines</div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-base font-bold text-teal-700">{summary.polygons}</div>
                  <div className="text-[11px] text-slate-500 font-medium">Polygons</div>
                </div>
              </div>

              {sampleAttributes.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-200">
                  <p className="text-[11px] font-semibold text-slate-600 mb-1 flex items-center gap-1">
                    <Eye size={12} /> Sample Attributes Table ({sampleAttributes.length} columns)
                  </p>
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {sampleAttributes.map(([key, val]) => (
                      <span
                        key={key}
                        className="text-[10px] px-2 py-0.5 bg-white border border-slate-200 rounded text-slate-700 font-mono"
                        title={`${key}: ${String(val)}`}
                      >
                        <strong>{key}</strong>: {String(val).slice(0, 20)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Imported features will appear on the interactive map for this project. Enumerators assigned to this
            project can view them, edit their attribute table, and conduct linked questionnaire surveys.
          </p>
        </div>

        {/* Footer */}
        <div className="bg-slate-50 px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={parsedFeatures.length === 0 || isUploading}
            className="px-4 py-2 text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg shadow-sm flex items-center gap-1.5 transition"
          >
            {isUploading ? (
              <>Uploading to Server…</>
            ) : (
              <>
                <Check size={14} /> Import {parsedFeatures.length > 0 ? `${parsedFeatures.length} Features` : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
