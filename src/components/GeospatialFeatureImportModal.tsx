import React, { useState } from 'react';
import { Upload, X, Check, FileJson, AlertCircle, Layers, Eye } from 'lucide-react';
import shp from 'shpjs';
import type { FeatureType } from '../types';
import { startGeospatialUpload, type ImportedMapExtent } from '../lib/geospatialUploadManager';

interface GeospatialFeatureImportModalProps {
  projectId: string;
  projectName: string;
  currentUserEmail?: string;
  currentUserUid?: string;
  onClose: () => void;
}

interface ParsedFeatureItem {
  id: string;
  type: FeatureType;
  geometry: any;
  attributes: Record<string, any>;
  propertiesCount: number;
  layerIndex: number;
}

export const GeospatialFeatureImportModal: React.FC<GeospatialFeatureImportModalProps> = ({
  projectId,
  projectName,
  currentUserEmail,
  currentUserUid,
  onClose
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [layerNames, setLayerNames] = useState<string[]>([]);
  const [parsedFeatures, setParsedFeatures] = useState<ParsedFeatureItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [summary, setSummary] = useState<{ points: number; lines: number; polygons: number } | null>(null);

  const cleanNameFromFileName = (fileName: string) => {
    return fileName
      .replace(/\.(geojson|json|zip|shp)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
  };

  const handleFileChange = async (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;
    setError(null);
    setFiles(selectedFiles);
    setLayerNames([]);
    setParsedFeatures([]);
    setSummary(null);
    setIsProcessing(true);

    try {
      const nextFeatures: ParsedFeatureItem[] = [];
      const nextLayerNames: string[] = [];
      const nameCounts = new Map<string, number>();
      let points = 0;
      let lines = 0;
      let polygons = 0;

      for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex++) {
        const selectedFile = selectedFiles[fileIndex];
        let rawJson: any;
        const isZip = selectedFile.name.toLowerCase().endsWith('.zip');

        if (isZip) {
          rawJson = await shp(await selectedFile.arrayBuffer());
        } else {
          try {
            rawJson = JSON.parse(await selectedFile.text());
          } catch {
            throw new Error(`${selectedFile.name}: invalid JSON. Choose GeoJSON, JSON, or Shapefile ZIP files.`);
          }
        }

        const rawFeatures: any[] = [];
        const flattenGeoData = (data: any) => {
          if (!data) return;
          if (Array.isArray(data)) {
            data.forEach(flattenGeoData);
          } else if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
            rawFeatures.push(...data.features);
          } else if (data.type === 'Feature') {
            rawFeatures.push(data);
          } else if (typeof data === 'object') {
            Object.values(data).forEach(flattenGeoData);
          }
        }
        flattenGeoData(rawJson);
        if (rawFeatures.length === 0) {
          throw new Error(`${selectedFile.name}: no geospatial features found.`);
        }

        const baseName = cleanNameFromFileName(selectedFile.name) || 'Imported Layer';
        const duplicateCount = (nameCounts.get(baseName.toLowerCase()) || 0) + 1;
        nameCounts.set(baseName.toLowerCase(), duplicateCount);
        nextLayerNames.push(duplicateCount === 1 ? baseName : `${baseName} ${duplicateCount}`);

        let supportedCount = 0;
        for (let i = 0; i < rawFeatures.length; i++) {
          const feat = rawFeatures[i];
          const geom = feat?.geometry;
          if (!geom || !geom.type || !geom.coordinates) continue;

          let type: FeatureType;
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
            continue;
          }

          const props = (feat.properties && typeof feat.properties === 'object') ? { ...feat.properties } : {};
          const sourceId = feat.id == null ? '' : String(feat.id);
          nextFeatures.push({
            id: `import_${Date.now().toString(36)}_${fileIndex}_${i}_${sourceId}`,
            type,
            geometry: geom,
            attributes: {
              ...props,
              ...(sourceId ? { __sourceFeatureId: sourceId } : {}),
              __source: isZip ? 'shapefile_upload' : 'geojson_upload',
              projectId,
            },
            propertiesCount: Object.keys(props).length,
            layerIndex: fileIndex,
          });
          supportedCount++;
        }
        if (supportedCount === 0) {
          throw new Error(`${selectedFile.name}: no supported point, line, or polygon features found.`);
        }
      }

      setLayerNames(nextLayerNames);
      setParsedFeatures(nextFeatures);
      setSummary({ points, lines, polygons });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLayerNames([]);
      setParsedFeatures([]);
      setSummary(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = async () => {
    if (parsedFeatures.length === 0) return;
    const normalizedLayerNames = layerNames.map((name) => name.trim());
    if (normalizedLayerNames.some((name) => !name)) {
      setError('Enter a layer name for every selected file.');
      return;
    }
    if (new Set(normalizedLayerNames.map((name) => name.toLowerCase())).size !== normalizedLayerNames.length) {
      setError('Each selected file needs a unique layer name so map visibility can be controlled separately.');
      return;
    }
    setError(null);

    try {
      const extent = getImportedFeaturesExtent(parsedFeatures);
      if (!extent) throw new Error('Imported features have no valid coordinates to fit on the map.');
      startGeospatialUpload({
        projectId,
        projectName,
        currentUserEmail,
        currentUserUid,
        extent,
        features: parsedFeatures.map((item) => ({
          id: item.id,
          type: item.type,
          geometry: item.geometry,
          attributes: item.attributes,
          layerName: normalizedLayerNames[item.layerIndex]
        }))
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import features to server.');
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
              <h3 className="text-base font-bold">Import Geospatial Features</h3>
              <p className="text-xs text-sky-100">Project: {projectName} · Multi-layer GeoJSON / Shapefile ZIP</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
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
              id="geospatial-file-upload"
              accept=".geojson,.json,.zip,application/json,application/geo+json,application/zip,application/x-zip-compressed"
              multiple
              className="hidden"
              disabled={isProcessing}
              onChange={(e) => void handleFileChange(Array.from(e.target.files || []))}
            />
            <label
              htmlFor="geospatial-file-upload"
              className="cursor-pointer flex flex-col items-center gap-2 text-slate-600"
            >
              <div className="w-12 h-12 rounded-2xl bg-sky-100 text-sky-700 flex items-center justify-center">
                <FileJson size={26} />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Choose one or more GIS files'}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Each GeoJSON or Shapefile ZIP becomes its own named, toggleable map layer
                </p>
              </div>
              <span className="mt-2 text-xs font-semibold px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg shadow-sm hover:bg-slate-50">
                Browse Files
              </span>
            </label>
          </div>

          {files.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">Map layers</h4>
                <span className="text-[10px] text-slate-400">{files.length} selected</span>
              </div>
              {files.map((selectedFile, index) => (
                <label key={`${selectedFile.name}_${index}`} className="flex items-center gap-2">
                  <Layers size={14} className="shrink-0 text-sky-600" />
                  <span className="w-36 shrink-0 truncate text-[10px] text-slate-500" title={selectedFile.name}>
                    {selectedFile.name}
                  </span>
                  <input
                    type="text"
                    value={layerNames[index] || ''}
                    disabled={isProcessing}
                    onChange={(e) => setLayerNames((previous) => previous.map((name, i) => i === index ? e.target.value : name))}
                    aria-label={`Map layer name for ${selectedFile.name}`}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-sky-500"
                    placeholder="Layer name"
                  />
                </label>
              ))}
            </div>
          )}

          {/* Feature Breakdown Summary */}
          {summary && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center justify-between">
                <span>{parsedFeatures.length} features across {layerNames.length} layer{layerNames.length === 1 ? '' : 's'}</span>
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
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={parsedFeatures.length === 0 || isProcessing}
            className="px-4 py-2 text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg shadow-sm flex items-center gap-1.5 transition"
          >
            <><Check size={14} /> Start upload {parsedFeatures.length > 0 ? `${parsedFeatures.length} features` : ''}</>
          </button>
        </div>
      </div>
    </div>
  );
};

const getImportedFeaturesExtent = (features: ParsedFeatureItem[]): ImportedMapExtent | null => {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;

  const visitCoordinates = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      const [lng, lat] = value;
      south = Math.min(south, lat);
      west = Math.min(west, lng);
      north = Math.max(north, lat);
      east = Math.max(east, lng);
      return;
    }
    value.forEach(visitCoordinates);
  };

  features.forEach((feature) => visitCoordinates(feature.geometry?.coordinates));
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return { south, west, north, east };
};
