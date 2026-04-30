import React, { useState } from 'react';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { GeoLocationProvider, useGeoLocation } from './components/GeoLocationProvider';
import { MapComponent } from './components/MapComponent';
import { FeatureEditor } from './components/FeatureEditor';
import { LoginScreen } from './components/LoginScreen';
import { UserManagement } from './components/UserManagement';
import { QuestionnaireManager } from './components/QuestionnaireManager';
import { QuestionnaireForm } from './components/QuestionnaireForm';
import { useFirestoreCollection } from './hooks/useFirestoreCollection';
import { GeoFeature, WardBoundary, Questionnaire } from './types';
import { MapPin, Plus, List, LogOut, Shield, Compass, Activity, CheckCircle2, UserPlus, FileText, Database, Clock, AlertCircle } from 'lucide-react';
import { collection, addDoc, setDoc, serverTimestamp, writeBatch, doc, query, where, getDocs, limit, startAfter, orderBy, documentId } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './lib/firebase';
import wardsData from './data/ccc_wards.json';
import landmarkGeoJsonUrl from './data/CCC_all_Landmark.geojson?url';
import shpwrite from '@mapbox/shp-write';

const AppContent: React.FC = () => {
  const { user, userProfile, loading: authLoading, logout } = useAuth();
  const { location, error: gpsError, requestLocation } = useGeoLocation();
  const { data: features, loading: featuresLoading } = useFirestoreCollection<GeoFeature>('features');
  
  const [selectedFeature, setSelectedFeature] = useState<GeoFeature | null>(null);
  const [isAddingFeature, setIsAddingFeature] = useState<'point' | 'line' | 'polygon' | null>(null);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showQuestionnaireManager, setShowQuestionnaireManager] = useState(false);
  const [selectedQuestionnaire, setSelectedQuestionnaire] = useState<Questionnaire | null>(null);
  const [questionnaireLocation, setQuestionnaireLocation] = useState<{ lat: number; lng: number; ward?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'list'>('map');
  const [isImportingLandmarks, setIsImportingLandmarks] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    total: number;
    processed: number;
    written: number;
    previousRemoved: number;
  } | null>(null);
  const [importNotice, setImportNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const isAdmin = userProfile?.role === 'admin' && userProfile?.status === 'approved';
  const visibleFeatures = features;

  const isImportedLandmarkPoint = (f: GeoFeature) => {
    if (f.type !== 'point') return false;
    const src = String(f.attributes?.__source || '');
    return src === 'ccc_landmark' || src === 'ccc_landmark_geojson' || src === 'ccc_landmark_import';
  };

  const importedLandmarkFeatures = visibleFeatures.filter(isImportedLandmarkPoint);
  const otherFeaturesCount = Math.max(0, visibleFeatures.length - importedLandmarkFeatures.length);

  const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371000; // earth radius meters
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

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

  const importLandmarkGeoJson = async () => {
    if (!isAdmin || isImportingLandmarks) return;
    setIsImportingLandmarks(true);
    setImportNotice(null);
    try {
      // Use Vite asset URL so this works in production (e.g., Vercel) and local dev.
      const resp = await fetch(landmarkGeoJsonUrl);
      if (!resp.ok) {
        throw new Error(`GeoJSON fetch failed (${resp.status})`);
      }
      const geo = await resp.json();
      const points = Array.isArray(geo?.features)
        ? geo.features.filter((f: any) => f?.geometry?.type === 'Point')
        : [];

      if (points.length === 0) {
        setImportNotice({ type: 'error', message: 'No Point features found in CCC_all_Landmark.geojson.' });
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const confirmed = window.confirm(
        'This will REPLACE all previously imported landmark data from Firestore with the GeoJSON file.\n\n' +
          'Any edits, verification status, rejection remarks, or other changes to those landmark records will be lost.\n\n' +
          'Continue?'
      );
      if (!confirmed) {
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const pointRecords = points.map((f: any, idx: number) => {
        const fid = normalizeLandmarkFid(f?.properties?.FID ?? f?.id ?? idx);
        const id = `landmark_${fid !== undefined ? fid : idx}`;
        return { id, fid, feature: f };
      });

      let writtenCount = 0;
      let removedCount = 0;
      const totalSteps = pointRecords.length;
      let processedCount = 0;
      setImportProgress({ total: totalSteps, processed: 0, written: 0, previousRemoved: 0 });

      const MAX_OPS = 450;

      // 1) Remove all previously imported CCC landmark documents (batched deletes; no per-FID queries).
      const landmarkSources = ['ccc_landmark', 'ccc_landmark_geojson', 'ccc_landmark_import', 'landmark_manual'];
      const pageSize = 450;

      let batch = writeBatch(db);
      let ops = 0;
      const commitIfNeeded = async (nextCost: number) => {
        if (ops + nextCost > MAX_OPS) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };

      for (const src of landmarkSources) {
        let cursor: any = null;
        while (true) {
          const base = query(
            collection(db, 'features'),
            where('attributes.__source', '==', src),
            orderBy(documentId()),
            limit(pageSize)
          );
          const q = cursor ? query(base, startAfter(cursor)) : base;
          const snap = await getDocs(q);
          if (snap.empty) break;

          for (const d of snap.docs) {
            await commitIfNeeded(1);
            batch.delete(doc(db, 'features', d.id));
            ops += 1;
            removedCount += 1;
          }

          cursor = snap.docs[snap.docs.length - 1];
          if (snap.docs.length < pageSize) break;
        }
      }

      if (ops > 0) {
        await batch.commit();
        batch = writeBatch(db);
        ops = 0;
      }
      // 2) Write fresh canonical landmark docs in large batches.
      const commitBatch = async () => {
        if (ops > 0) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };

      let writeChunk = 0;
      for (const rec of pointRecords) {
        const ref = doc(db, 'features', rec.id);
        const coords = rec.feature?.geometry?.coordinates || [0, 0];
        const attrs = rec.feature?.properties || {};
        const normalizedAttrs =
          rec.fid !== undefined ? { ...attrs, FID: rec.fid } : { ...attrs };

        await commitIfNeeded(1);
        batch.set(ref, {
          type: 'point',
          geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
          attributes: {
            ...normalizedAttrs,
            __source: 'ccc_landmark'
          },
          status: 'pending',
          createdBy: 'ccc_landmark_import',
          updatedBy: user?.email || 'ccc_landmark_import',
          updatedByUid: user?.uid || null,
          updatedAt: serverTimestamp()
        });
        ops += 1;
        writtenCount += 1;
        writeChunk += 1;

        if (ops >= MAX_OPS) {
          await commitBatch();
        }
        // Avoid updating React state on every row for large imports.
        processedCount = writtenCount;
        if (writeChunk >= 100 || writtenCount === pointRecords.length) {
          setImportProgress({
            total: totalSteps,
            processed: processedCount,
            written: writtenCount,
            previousRemoved: removedCount
          });
          writeChunk = 0;
        }
      }
      await commitBatch();

      setImportProgress({
        total: totalSteps,
        processed: totalSteps,
        written: writtenCount,
        previousRemoved: removedCount
      });
      setImportNotice({
        type: 'success',
        message: `Import complete. Previous data removed: ${removedCount}. Landmarks written: ${writtenCount}.`
      });
    } catch (e) {
      console.error(e);
      setImportNotice({ type: 'error', message: 'Landmark GeoJSON import failed: ' + e });
    } finally {
      setIsImportingLandmarks(false);
    }
  };

  const downloadChangedLandmarkShp = async () => {
    if (!isAdmin) return;
    setImportNotice(null);

    const valuesEqual = (a: unknown, b: unknown) => {
      if (a === b) return true;
      if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) {
        return true;
      }
      const an = Number(a);
      const bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
        return an === bn;
      }
      return String(a ?? '') === String(b ?? '');
    };
    const isPointGeometrySame = (a: any, b: any) => {
      const ac = Array.isArray(a?.coordinates) ? a.coordinates : [];
      const bc = Array.isArray(b?.coordinates) ? b.coordinates : [];
      if (ac.length < 2 || bc.length < 2) return false;
      const ax = Number(ac[0]);
      const ay = Number(ac[1]);
      const bx = Number(bc[0]);
      const by = Number(bc[1]);
      if (![ax, ay, bx, by].every(Number.isFinite)) return false;
      const eps = 1e-9;
      return Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps;
    };

    let baselineByFid = new Map<string, { geometry: any; properties: Record<string, any> }>();
    try {
      const baselineResp = await fetch(landmarkGeoJsonUrl);
      if (!baselineResp.ok) {
        throw new Error(`Failed to load baseline GeoJSON (${baselineResp.status})`);
      }
      const baseline = await baselineResp.json();
      const baselinePoints = Array.isArray(baseline?.features)
        ? baseline.features.filter((f: any) => f?.geometry?.type === 'Point')
        : [];
      baselineByFid = new Map(
        baselinePoints.map((f: any) => [
          String(f?.properties?.FID ?? ''),
          { geometry: f?.geometry, properties: f?.properties || {} }
        ])
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Failed to load baseline landmark data: ${message}` });
      return;
    }

    const changedFeatures = visibleFeatures.filter((feature) => {
      if (feature.geometry?.type !== 'Point') return false;
      const source = String(feature.attributes?.__source || '');
      const isLandmarkRelated = source.includes('landmark');
      if (!isLandmarkRelated) return false;

      // Newly added landmark points should always be exported as changed.
      if (source.includes('landmark_manual')) return true;

      const fid = feature.attributes?.FID;
      const baselineEntry = baselineByFid.get(String(fid ?? ''));
      if (!baselineEntry) return true;

      // Rejected/verified/remarks imply change.
      if (feature.status !== 'pending' || Boolean(feature.remarks)) return true;

      if (!isPointGeometrySame(feature.geometry, baselineEntry.geometry)) return true;

      const currentProps = Object.fromEntries(
        Object.entries(feature.attributes || {}).filter(([k]) => !k.startsWith('__'))
      );
      const baselineProps = baselineEntry.properties || {};
      const keys = new Set([...Object.keys(currentProps), ...Object.keys(baselineProps)]);
      for (const key of keys) {
        if (!valuesEqual(currentProps[key], baselineProps[key])) return true;
      }
      return false;
    });
    if (changedFeatures.length === 0) {
      setImportNotice({ type: 'error', message: 'No changed landmark point features available for SHP download.' });
      return;
    }

    const toNumber = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toPrimitive = (v: unknown): string | number | boolean => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      if (v === null || v === undefined) return '';
      return JSON.stringify(v);
    };

    const exportPayload = {
      type: 'FeatureCollection',
      name: 'changed_landmarks',
      features: changedFeatures
        .map((feature) => {
          const coords = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
          const lng = toNumber(coords[0]);
          const lat = toNumber(coords[1]);
          if (lng === null || lat === null) return null;

          const sanitizedAttributes = Object.fromEntries(
            Object.entries(feature.attributes || {}).map(([k, v]) => [k, toPrimitive(v)])
          );

          return {
            type: 'Feature',
            id: feature.attributes?.FID ?? feature.id,
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: {
              ...sanitizedAttributes,
              ChangeStatus: feature.status,
              ChangeRemarks: feature.remarks ?? '',
              ChangeBy: feature.updatedBy ?? '',
              ChangeAt: feature.updatedAt ?? '',
              GPS_Lat: feature.collectorLocation?.lat ?? '',
              GPS_Lng: feature.collectorLocation?.lng ?? '',
              GPS_Acc: feature.collectorLocation?.accuracy ?? ''
            }
          };
        })
        .filter(Boolean)
    };
    // EPSG:4326 WGS84 projection for shapefile .prj
    const wgs84Prj =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
      'SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

    try {
      const zipResult = await shpwrite.zip(exportPayload as any, {
        folder: 'changed_landmarks',
        types: { point: 'changed_landmarks' },
        prj: wgs84Prj,
        outputType: 'blob',
        compression: 'STORE'
      });

      const blob = zipResult instanceof Blob
        ? zipResult
        : new Blob([zipResult as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `changed_landmarks_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setImportNotice({
        type: 'success',
        message: `SHP download ready. Exported ${(exportPayload.features as any[]).length} changed point feature(s) as ZIP.`
      });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Failed to generate SHP ZIP download: ${message}` });
    }
  };

  const handleMapClick = async (lat: number, lng: number) => {
    if (!isAddingFeature || !user) return;

    try {
      let geometry: any;
      if (isAddingFeature === 'point') {
        // Enumerator can add landmark points only when standing within 10m of clicked point.
        if (!isAdmin) {
          if (!location) {
            requestLocation();
            alert('GPS location is required. Please allow location access in browser and wait for GPS lock.');
            return;
          }
          const d = distanceMeters(location.lat, location.lng, lat, lng);
          if (d > 10) {
            alert(`You are ${d.toFixed(1)}m away from the selected point. Move within 10m to add a landmark point.`);
            return;
          }
        }
        geometry = { type: 'Point', coordinates: [lng, lat] };

        // New point creation now happens via attribute editor + save.
        setSelectedFeature({
          id: `draft_${Date.now()}`,
          type: 'point',
          geometry,
          attributes: {
            name: '',
            Category: 'Landmark',
            Type: 'Point',
            Ownership: '',
            Ward_Name: '',
            Zone: '',
            __source: 'landmark_manual'
          },
          status: 'pending',
          createdBy: user.email || 'user',
          updatedBy: user.email || 'user',
          updatedAt: new Date().toISOString(),
          ...(location && {
            collectorLocation: {
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy
            }
          })
        } as GeoFeature);
        setIsAddingFeature(null);
        return;
      } else if (isAddingFeature === 'line') {
        // Simple point-to-line for now or multi-click logic
        geometry = { type: 'LineString', coordinates: [[lng, lat], [lng + 0.001, lat + 0.001]] };
      } else {
        geometry = { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]] };
      }

      await addDoc(collection(db, 'features'), {
        type: isAddingFeature,
        geometry,
        attributes: {
          name: isAddingFeature === 'point' ? 'New Landmark Point' : 'New ' + isAddingFeature,
          Category: isAddingFeature === 'point' ? 'Landmark' : '',
          Type: isAddingFeature === 'point' ? 'Point' : '',
          created_at: new Date().toISOString(),
          __source: isAddingFeature === 'point' ? 'landmark_manual' : 'manual'
        },
        status: 'pending',
        createdBy: user.email,
        createdByUid: user.uid,
        updatedBy: user.email,
        updatedAt: serverTimestamp(),
        ...(location && {
          collectorLocation: {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy
          }
        })
      });

      setIsAddingFeature(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'features');
    }
  };

  const handleCreateFeatureFromEditor = async (payload: { attributes: Record<string, any>; status: 'pending' | 'verified' | 'rejected' }) => {
    if (!user || !selectedFeature) return;
    await addDoc(collection(db, 'features'), {
      type: selectedFeature.type,
      geometry: selectedFeature.geometry,
      attributes: payload.attributes,
      status: payload.status,
      createdBy: user.email,
      createdByUid: user.uid,
      updatedBy: user.email,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
      ...(location && {
        collectorLocation: {
          lat: location.lat,
          lng: location.lng,
          accuracy: location.accuracy
        }
      })
    });
  };

  const handleLandmarkPointSelect = async (point: { lat: number; lng: number; properties: Record<string, any> }) => {
    if (!user) return;

    const fid = normalizeLandmarkFid(point.properties?.FID);
    const attributes = {
      ...point.properties,
      ...(fid !== undefined ? { FID: fid } : {}),
      __source: 'ccc_landmark_geojson'
    };

    const existing = features.find((f) => {
      if (f.type !== 'point') return false;
      if (fid !== undefined) {
        return fidsEqual(f.attributes?.FID, fid);
      }
      if (!Array.isArray(f.geometry?.coordinates)) return false;
      return (
        Math.abs((f.geometry.coordinates[1] ?? 0) - point.lat) < 0.0000001 &&
        Math.abs((f.geometry.coordinates[0] ?? 0) - point.lng) < 0.0000001
      );
    });

    if (existing) {
      setSelectedFeature(existing);
      return;
    }

    try {
      // If landmark does not exist in Firestore yet, create it so it can be edited.
      // No GPS-distance restriction here: user requested 10m rule only for
      // explicit "add feature" mode (map click), not edit/delete/attribute edit flow.

      const featureId = fid !== undefined ? `landmark_${fid}` : null;
      if (featureId) {
        const ref = doc(db, 'features', featureId);
        await setDoc(
          ref,
          {
            type: 'point',
            geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
            attributes,
            status: 'pending',
            createdBy: user.email,
            createdByUid: user.uid,
            updatedBy: user.email,
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
            ...(location && {
              collectorLocation: {
                lat: location.lat,
                lng: location.lng,
                accuracy: location.accuracy
              }
            })
          },
          { merge: true }
        );

        setSelectedFeature({
          id: featureId,
          type: 'point',
          geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
          attributes,
          status: 'pending',
          createdBy: user.email || 'user',
          updatedBy: user.email || 'user',
          updatedAt: new Date().toISOString()
        } as GeoFeature);
        return;
      }

      const docRef = await addDoc(collection(db, 'features'), {
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes,
        status: 'pending',
        createdBy: user.email,
        createdByUid: user.uid,
        updatedBy: user.email,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
        ...(location && {
          collectorLocation: {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy
          }
        })
      });

      setSelectedFeature({
        id: docRef.id,
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes,
        status: 'pending',
        createdBy: user.email || 'user',
        updatedBy: user.email || 'user',
        updatedAt: new Date().toISOString()
      } as GeoFeature);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'features');
    }
  };

  if (authLoading) return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <div className="animate-bounce flex space-x-2">
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
      </div>
    </div>
  );

  if (!user) return <LoginScreen />;

  // If auth succeeded but profile is still loading, don't bounce back to login.
  if (!userProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100 text-center">
          <div className="mx-auto w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 mb-4">
            <Shield size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Checking your access</h1>
          <p className="text-slate-500 text-sm mt-2">Please wait...</p>
        </div>
      </div>
    );
  }

  if (userProfile.status === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-200 mb-4">
              <Clock size={28} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Approval Pending</h1>
            <p className="text-slate-500 text-sm mt-2">
              Your account is waiting for admin approval. You can sign in, but you will be able to access the portal once approved.
            </p>
            <p className="text-[10px] text-slate-400 mt-3">
              {userProfile.email}
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => void logout()}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-2xl transition-all shadow-lg active:scale-[0.98]"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (userProfile.status === 'rejected') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 bg-red-500 rounded-2xl flex items-center justify-center shadow-lg shadow-red-200 mb-4">
              <AlertCircle size={28} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Access Rejected</h1>
            <p className="text-slate-500 text-sm mt-2">
              Your account was rejected by the administrator. Please contact support if you believe this is a mistake.
            </p>
            <p className="text-[10px] text-slate-400 mt-3">
              {userProfile.email}
            </p>
          </div>

          <button
            onClick={() => void logout()}
            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-2xl transition-all shadow-lg active:scale-[0.98]"
          >
            Log out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col font-sans text-slate-800 bg-slate-50">
      {/* Header */}
      <header className="h-16 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-sm z-[1001]">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-xl text-white">
            <Compass size={24} />
          </div>
          <div>
            <h1 className="font-bold text-slate-900 leading-tight">EQMS Geosurvey</h1>
            <p className="text-[10px] text-slate-400 font-medium tracking-wide">Collect and validate geospatial data from ground level</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-full border border-slate-100">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-xs font-medium text-slate-600">Live Sync Active</span>
          </div>
          
          <div className="flex items-center gap-3 border-l border-slate-200 pl-4 ml-4">
            {isAdmin && (
              <>
                <button 
                  onClick={() => setShowUserManagement(true)}
                  className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  title="Manage Users"
                >
                  <UserPlus size={20} />
                </button>
              </>
            )}
            <div className="text-right hidden sm:block">
              <p className="text-xs font-bold text-slate-900">{userProfile?.displayName || user.email}</p>
              <p className="text-[10px] text-blue-600 font-bold uppercase">{isAdmin ? 'ADMIN' : 'ENUMERATOR'}</p>
            </div>
            <button 
              onClick={logout}
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
              title="Logout"
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 flex flex-col">
          {activeTab === 'map' ? (
            <MapComponent 
              features={visibleFeatures}
              wards={wardsData}
              onFeatureSelect={setSelectedFeature}
              onLandmarkPointSelect={handleLandmarkPointSelect}
              selectedFeatureId={selectedFeature?.id}
              onMapClick={handleMapClick}
              addFeatureType={isAddingFeature}
              showPointAddBuffer={!isAdmin && isAddingFeature === 'point'}
            />
          ) : (
            <div className="p-6 overflow-y-auto w-full">
              <div className="max-w-4xl mx-auto space-y-4">
                <h2 className="text-xl font-bold flex items-center gap-2 mb-6">
                  <List size={24} className="text-blue-600" />
                  Attribute Data Table
                </h2>
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-100">
                      <tr>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Type</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Name/Attributes</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleFeatures.map(f => (
                        <tr key={f.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-4 capitalize font-medium text-slate-600 text-sm">{f.type}</td>
                          <td className="px-4 py-4">
                            <span className="text-sm font-semibold">{f.attributes.name || 'Unnamed Feature'}</span>
                            <div className="flex gap-1 mt-1">
                              {Object.entries(f.attributes).slice(0, 2).map(([k, v]) => (
                                <span key={k} className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase">{k}: {v}</span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                              f.status === 'verified' ? 'bg-green-100 text-green-700' :
                              f.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                            }`}>
                              {f.status}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <button 
                              onClick={() => { setSelectedFeature(f); setActiveTab('map'); }}
                              className="text-blue-600 text-xs font-bold hover:underline"
                            >
                              Edit on Map
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* User Management Overlay */}
        {showUserManagement && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <UserManagement onClose={() => setShowUserManagement(false)} />
          </div>
        )}

        {/* Questionnaire Manager Overlay */}
        {showQuestionnaireManager && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <QuestionnaireManager
              onClose={() => setShowQuestionnaireManager(false)}
              onSelectQuestionnaire={(questionnaire) => {
                setSelectedQuestionnaire(questionnaire);
                setShowQuestionnaireManager(false);
              }}
            />
          </div>
        )}

        {/* Questionnaire Form Overlay */}
        {selectedQuestionnaire && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <QuestionnaireForm
              questionnaire={selectedQuestionnaire}
              onClose={() => setSelectedQuestionnaire(null)}
              initialLocation={questionnaireLocation || undefined}
            />
          </div>
        )}

        {/* Feature Editor Overlay */}
        {selectedFeature && (
          <div className="absolute top-0 right-0 h-full z-[1002] flex animate-in slide-in-from-right duration-300">
            <FeatureEditor 
              feature={selectedFeature} 
              onClose={() => setSelectedFeature(null)} 
              isAdmin={isAdmin}
              isNewFeature={selectedFeature.id.startsWith('draft_')}
              onCreateFeature={handleCreateFeatureFromEditor}
            />
          </div>
        )}

        {/* Toolbar Floating */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[1001] flex items-center bg-white/80 backdrop-blur-md rounded-2xl shadow-2xl border border-white/50 p-1.5 ring-1 ring-slate-200">
          <button 
            onClick={() => setActiveTab('map')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'map' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <MapPin size={18} /> Map View
          </button>
          <button 
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'list' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <List size={18} /> Table List
          </button>
          {!isAdmin && (
            <>
              <div className="w-px h-6 bg-slate-200 mx-2" />
              <div className="flex gap-1">
                {(['point', 'line', 'polygon'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => {
                      const next = isAddingFeature === type ? null : type;
                      setIsAddingFeature(next);
                      if (type === 'point' && next === 'point') {
                        requestLocation();
                        if (gpsError) {
                          alert(`Location access issue: ${gpsError}. Please allow location permission in your browser.`);
                        }
                      }
                    }}
                    className={`p-2.5 rounded-xl transition-all ${isAddingFeature === type ? 'bg-blue-100 text-blue-600 ring-2 ring-blue-500 ring-inset' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
                    title={`Add ${type}`}
                  >
                    {type === 'point' ? <MapPin size={20} /> : <Plus size={20} />}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="w-px h-6 bg-slate-200 mx-2" />
        </div>

        {/* Quick Stats Floating (Admin) */}
        {isAdmin && activeTab === 'map' && (
          <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-2">
            <div className="bg-white/90 backdrop-blur-md p-3 rounded-2xl shadow-lg border border-white/50 w-48">
              <div className="flex items-center gap-2 mb-3">
                <Shield size={16} className="text-blue-600" />
                <span className="text-xs font-bold uppercase tracking-wider">Quality Control</span>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Verified</span>
                  <span className="font-bold text-green-600">{importedLandmarkFeatures.filter(f => f.status === 'verified').length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Pending</span>
                  <span className="font-bold text-amber-600">{importedLandmarkFeatures.filter(f => f.status === 'pending').length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Rejected</span>
                  <span className="font-bold text-red-600">{importedLandmarkFeatures.filter(f => f.status === 'rejected').length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Landmarks (imported)</span>
                  <span className="font-bold">{importedLandmarkFeatures.length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Other features</span>
                  <span className="font-bold text-slate-700">{otherFeaturesCount}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Total (all)</span>
                  <span className="font-bold">{visibleFeatures.length}</span>
                </div>
                <button 
                  onClick={importLandmarkGeoJson}
                  disabled={isImportingLandmarks}
                  className="w-full mt-1 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isImportingLandmarks ? 'Importing Landmarks...' : 'Import Landmark GeoJSON'}
                </button>
                {importProgress && (
                  <div className="space-y-1">
                    <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-all duration-200"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((importProgress.processed / Math.max(1, importProgress.total)) * 100)
                          )}%`
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-slate-600">
                      {importProgress.processed}/{importProgress.total} processed | Written: {importProgress.written} | Previous data removed: {importProgress.previousRemoved}
                    </p>
                  </div>
                )}
                <button
                  onClick={downloadChangedLandmarkShp}
                  disabled={isImportingLandmarks}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Download Changed SHP
                </button>
                {importNotice && (
                  <div
                    className={`text-[10px] font-semibold rounded-lg px-2 py-1 ${
                      importNotice.type === 'success'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {importNotice.message}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add Hint Bar */}
      {isAddingFeature && (
        <div className="bg-blue-600 text-white text-center py-1 text-xs font-bold animate-pulse">
          MODE: CLICK ON MAP TO ADD {isAddingFeature.toUpperCase()}
        </div>
      )}
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <GeoLocationProvider>
        <AppContent />
      </GeoLocationProvider>
    </AuthProvider>
  );
}
