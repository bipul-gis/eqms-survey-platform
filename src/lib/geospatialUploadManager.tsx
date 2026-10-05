import React, { useSyncExternalStore } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { geosurveyApi } from './geosurveyApi';

export interface GeospatialUploadFeature {
  id: string;
  type: string;
  geometry: unknown;
  attributes: Record<string, unknown>;
  layerName: string;
}

export interface ImportedMapExtent {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeospatialUploadSnapshot {
  id: number;
  projectId: string;
  projectName: string;
  status: 'uploading' | 'success' | 'error';
  total: number;
  uploaded: number;
  extent: ImportedMapExtent;
  error?: string;
  taskLabel?: string;
  currentBatch?: number;
  totalBatches?: number;
}

let snapshot: GeospatialUploadSnapshot | null = null;
let nextUploadId = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export const subscribeGeospatialUpload = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getGeospatialUploadSnapshot = () => snapshot;

export const startGeospatialUpload = (input: {
  projectId: string;
  projectName: string;
  currentUserEmail?: string;
  currentUserUid?: string;
  features: GeospatialUploadFeature[];
  extent: ImportedMapExtent;
}): number => {
  const id = ++nextUploadId;
  snapshot = {
    id,
    projectId: input.projectId,
    projectName: input.projectName,
    status: 'uploading',
    total: input.features.length,
    uploaded: 0,
    extent: input.extent
  };
  emit();

  void (async () => {
    try {
      const now = new Date().toISOString();
      const payload = input.features.map((feature) => ({
        id: feature.id,
        type: feature.type,
        geometry: feature.geometry,
        attributes: {
          ...feature.attributes,
          __layerName: feature.layerName,
          layerName: feature.layerName
        },
        status: 'pending',
        projectId: input.projectId,
        createdBy: input.currentUserEmail || 'admin',
        createdByUid: input.currentUserUid || null,
        updatedBy: input.currentUserEmail || 'admin',
        updatedAt: now
      }));
      const chunkSize = 500;
      const totalBatches = Math.ceil(payload.length / chunkSize);
      let uploaded = 0;
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        const chunk = payload.slice(offset, offset + chunkSize);
        if (snapshot?.id === id) {
          snapshot = { ...snapshot, currentBatch: Math.floor(offset / chunkSize) + 1, totalBatches };
          emit();
        }
        const result = await geosurveyApi.bulkSaveFeatures(chunk);
        uploaded += result.count || chunk.length;
        if (snapshot?.id === id) {
          snapshot = { ...snapshot, uploaded: Math.min(uploaded, payload.length) };
          emit();
        }
      }
      if (snapshot?.id === id) {
        snapshot = { ...snapshot, status: 'success', uploaded: payload.length };
        emit();
      }
    } catch (error) {
      if (snapshot?.id === id) {
        snapshot = {
          ...snapshot,
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed.'
        };
        emit();
      }
    }
  })();
  return id;
};

/** Track server imports that are committed by one request (such as an SHP layer). */
export const startGeospatialServerTask = (input: {
  projectId: string;
  projectName: string;
  label: string;
  total: number;
  run: () => Promise<unknown>;
}): number => {
  const id = ++nextUploadId;
  snapshot = {
    id,
    projectId: input.projectId,
    projectName: input.projectName,
    status: 'uploading',
    total: input.total,
    uploaded: 0,
    extent: { south: 0, west: 0, north: 0, east: 0 },
    taskLabel: input.label,
  };
  emit();
  void input.run().then(() => {
    if (snapshot?.id !== id) return;
    snapshot = { ...snapshot, status: 'success', uploaded: input.total };
    emit();
  }).catch((error) => {
    if (snapshot?.id !== id) return;
    snapshot = { ...snapshot, status: 'error', error: error instanceof Error ? error.message : 'Upload failed.' };
    emit();
  });
  return id;
};

export const dismissGeospatialUpload = (id: number) => {
  if (snapshot?.id !== id || snapshot.status === 'uploading') return;
  snapshot = null;
  emit();
};

export const useGeospatialUpload = () =>
  useSyncExternalStore(subscribeGeospatialUpload, getGeospatialUploadSnapshot, getGeospatialUploadSnapshot);

export const GeospatialUploadStatus: React.FC = () => {
  const upload = useGeospatialUpload();
  if (!upload) return null;
  const percent = upload.total > 0 ? Math.round((upload.uploaded / upload.total) * 100) : 0;
  return (
    <div className="fixed bottom-4 right-4 z-[3000] w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-start gap-2.5 p-3.5">
        {upload.status === 'uploading' ? (
          <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-sky-600" />
        ) : upload.status === 'success' ? (
          <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
        ) : (
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-red-600" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-slate-800">
            {upload.status === 'uploading'
            ? `Uploading ${upload.taskLabel || `${upload.projectName} layers`}`
              : upload.status === 'success'
                ? 'Layer upload complete'
                : 'Layer upload failed'}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {upload.status === 'uploading'
            ? upload.taskLabel
              ? `Sending ${upload.total.toLocaleString()} polygons to the server`
              : `Saving batch ${upload.currentBatch || 1} of ${upload.totalBatches || 1} · ${upload.uploaded.toLocaleString()} of ${upload.total.toLocaleString()} features saved`
              : upload.status === 'success'
                ? `${upload.total.toLocaleString()} features uploaded`
                : upload.error}
          </p>
          {upload.status === 'uploading' && (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-label="Geospatial upload progress"
              aria-valuemin={0}
              aria-valuemax={upload.total}
              aria-valuenow={upload.uploaded}
            >
              <div className={`h-full rounded-full bg-sky-600 transition-[width] ${upload.status === 'uploading' ? 'w-1/3 animate-pulse' : ''}`} style={upload.status === 'uploading' ? undefined : { width: `${percent}%` }} />
            </div>
          )}
        </div>
        {upload.status !== 'uploading' && (
          <button
            type="button"
            onClick={() => dismissGeospatialUpload(upload.id)}
            className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Dismiss upload status"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  );
};
