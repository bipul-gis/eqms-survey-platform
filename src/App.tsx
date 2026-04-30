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
import { collection, addDoc, serverTimestamp, writeBatch, doc, query, where, getDocs, documentId } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './lib/firebase';
import wardsData from './data/ccc_wards.json';
import landmarkGeoJsonUrl from './data/CCC_all_Landmark.geojson?url';

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

  const isAdmin = userProfile?.role === 'admin' && userProfile?.status === 'approved';
  const visibleFeatures = features;

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

  const importLandmarkGeoJson = async () => {
    if (!isAdmin) return;
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
        alert('No Point features found in CCC_all_Landmark.geojson');
        return;
      }

      const pointRecords = points.map((f: any, idx: number) => ({
        id: `landmark_${f?.properties?.FID ?? f?.id ?? `${idx}`}`,
        feature: f
      }));

      // Keep original imported data intact: never overwrite existing landmark docs on re-import.
      let importedCount = 0;
      let skippedCount = 0;
      const readChunkSize = 30; // Firestore "in" query limit
      const writeChunkSize = 400;

      for (let i = 0; i < pointRecords.length; i += readChunkSize) {
        const readChunk = pointRecords.slice(i, i + readChunkSize);
        const ids = readChunk.map((r) => r.id);
        const existingSnap = await getDocs(
          query(collection(db, 'features'), where(documentId(), 'in', ids))
        );
        const existingIds = new Set(existingSnap.docs.map((d) => d.id));
        const newRecords = readChunk.filter((r) => !existingIds.has(r.id));
        skippedCount += readChunk.length - newRecords.length;

        for (let j = 0; j < newRecords.length; j += writeChunkSize) {
          const writeChunk = newRecords.slice(j, j + writeChunkSize);
          if (writeChunk.length === 0) continue;
          const batch = writeBatch(db);
          writeChunk.forEach(({ id, feature }) => {
            const ref = doc(db, 'features', id);
            const coords = feature?.geometry?.coordinates || [0, 0];
            const attrs = feature?.properties || {};
            batch.set(ref, {
              type: 'point',
              geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
              attributes: {
                ...attrs,
                __source: 'ccc_landmark'
              },
              status: 'pending',
              createdBy: 'ccc_landmark_import',
              updatedBy: 'ccc_landmark_import',
              updatedAt: serverTimestamp()
            });
          });
          await batch.commit();
          importedCount += writeChunk.length;
        }
      }

      alert(`Import complete. New: ${importedCount}, skipped existing: ${skippedCount}.`);
    } catch (e) {
      console.error(e);
      alert('Landmark GeoJSON import failed: ' + e);
    }
  };

  const downloadChangedLandmarkJson = () => {
    if (!isAdmin) return;

    const changedFeatures = visibleFeatures.filter((feature) => {
      const source = String(feature.attributes?.__source || '');
      const isLandmarkSource = source.includes('ccc_landmark');
      if (!isLandmarkSource) return false;

      // "Changed/updated" means it is no longer pristine imported state.
      return (
        feature.updatedBy !== 'ccc_landmark_import' ||
        feature.status !== 'pending' ||
        Boolean(feature.remarks)
      );
    });

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      totalChanged: changedFeatures.length,
      features: changedFeatures.map((feature) => ({
        id: feature.id,
        type: feature.type,
        geometry: feature.geometry,
        status: feature.status,
        remarks: feature.remarks ?? null,
        createdBy: feature.createdBy,
        updatedBy: feature.updatedBy,
        updatedAt: feature.updatedAt,
        collectorLocation: feature.collectorLocation ?? null,
        attributes: feature.attributes
      }))
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `changed_landmarks_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
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

    const fid = point.properties?.FID;
    const existing = features.find((f) =>
      f.type === 'point' &&
      (
        (fid !== undefined && f.attributes?.FID === fid) ||
        (
          Array.isArray(f.geometry?.coordinates) &&
          Math.abs((f.geometry.coordinates[1] ?? 0) - point.lat) < 0.0000001 &&
          Math.abs((f.geometry.coordinates[0] ?? 0) - point.lng) < 0.0000001
        )
      )
    );

    if (existing) {
      setSelectedFeature(existing);
      return;
    }

    try {
      // If landmark does not exist in Firestore yet, create it so it can be edited.
      // No GPS-distance restriction here: user requested 10m rule only for
      // explicit "add feature" mode (map click), not edit/delete/attribute edit flow.

      const docRef = await addDoc(collection(db, 'features'), {
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes: {
          ...point.properties,
          __source: 'ccc_landmark_geojson'
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

      setSelectedFeature({
        id: docRef.id,
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes: {
          ...point.properties,
          __source: 'ccc_landmark_geojson'
        },
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
            <h1 className="font-bold text-slate-900 leading-tight">Spatial Enumerator</h1>
            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">Dhaka City Corp</p>
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
                  onClick={() => setShowQuestionnaireManager(true)}
                  className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-all"
                  title="Manage Questionnaires"
                >
                  <FileText size={20} />
                </button>
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
          <button
            onClick={() => setShowQuestionnaireManager(true)}
            className="p-2.5 rounded-xl text-green-600 hover:bg-green-50 hover:text-green-700 transition-all"
            title="Launch Questionnaire"
          >
            <FileText size={20} />
          </button>
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
                  <span className="font-bold text-green-600">{visibleFeatures.filter(f => f.status === 'verified').length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Pending</span>
                  <span className="font-bold text-amber-600">{visibleFeatures.filter(f => f.status === 'pending').length}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Total</span>
                  <span className="font-bold">{visibleFeatures.length}</span>
                </div>
                <button 
                  onClick={importLandmarkGeoJson}
                  className="w-full mt-1 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg text-[10px] font-bold uppercase transition-colors"
                >
                  Import Landmark GeoJSON
                </button>
                <button
                  onClick={downloadChangedLandmarkJson}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold uppercase transition-colors"
                >
                  Download Changed JSON
                </button>
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
