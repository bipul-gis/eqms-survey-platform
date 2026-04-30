import React, { useState, useEffect, useMemo } from 'react';
import { GeoFeature, FeatureStatus } from '../types';
import { X, Save, MapPin, User, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { doc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { useAuth } from './AuthProvider';
import { useGeoLocation } from './GeoLocationProvider';

// Match the attribute order in MapComponent popup
const LANDMARK_ATTRIBUTE_ORDER = ['FID', 'name', 'Category', 'Type', 'Ownership', 'Ward_Name', 'Zone'] as const;
const READ_ONLY_ATTRIBUTES = new Set(['FID', '_source']); // Fields that cannot be edited

const CATEGORY_OPTIONS = [
  'Commercial',
  'Cultural Site',
  'Educational',
  'Health Facilities',
  'Public Institutional Building',
  'Recreational Area',
  'Religious Place',
  'Transport'
] as const;

const CATEGORY_TYPE_OPTIONS: Record<string, string[]> = {
  Commercial: ['Shopping Mall', 'Supermarket', 'Market'],
  'Cultural Site': ['Museum', 'Monument'],
  Educational: ['School', 'College', 'University'],
  'Health Facilities': ['Dentist', 'Hospital', 'Clinic', 'Pharmacy'],
  'Public Institutional Building': ['Communications Tower', 'Courthouse', 'Ward Councilor Office', 'Military Training Academy'],
  'Recreational Area': ['Park', 'Stadium'],
  'Religious Place': ['Buddhist Temple', 'Church', 'Mosque', 'Madrasa', 'Temple'],
  Transport: ['Air Port', 'Rail station']
};

const OWNERSHIP_OPTIONS = ['CCC', 'Government', 'Informal', 'NGO/Institutional', 'Private'] as const;

const getOrderedAttributes = (attrs: Record<string, any>): Array<[string, any]> => {
  const normalized: Record<string, any> = {
    FID: attrs?.FID ?? '',
    name: attrs?.name ?? attrs?.Name ?? '',
    Category: attrs?.Category ?? '',
    Type: attrs?.Type ?? '',
    Ownership: attrs?.Ownership ?? '',
    Ward_Name: attrs?.Ward_Name ?? attrs?.WARDNAME ?? attrs?.WardName ?? '',
    Zone: attrs?.Zone ?? ''
  };

  const seen = new Set<string>(Object.keys(normalized));
  const extra = Object.entries(attrs || {})
    .filter(([k]) => !seen.has(k) && !k.startsWith('__') && !k.startsWith('_'))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const ordered = LANDMARK_ATTRIBUTE_ORDER.map((k) => [k, normalized[k]]);
  return [...ordered, ...extra] as Array<[string, any]>;
};

interface FeatureEditorProps {
  feature: GeoFeature;
  allFeatures?: GeoFeature[];
  wardOptions?: string[];
  zoneOptions?: string[];
  onClose: () => void;
  isAdmin: boolean;
  isNewFeature?: boolean;
  onCreateFeature?: (payload: { attributes: Record<string, any>; status: FeatureStatus }) => Promise<void>;
}

export const FeatureEditor: React.FC<FeatureEditorProps> = ({
  feature,
  allFeatures = [],
  wardOptions = [],
  zoneOptions = [],
  onClose,
  isAdmin,
  isNewFeature = false,
  onCreateFeature
}) => {
  const { user } = useAuth();
  const { location } = useGeoLocation();
  const [attributes, setAttributes] = useState<Record<string, any>>(feature.attributes);
  const [status, setStatus] = useState<FeatureStatus>(feature.status);
  const [isSaving, setIsSaving] = useState(false);
  const [rejectionRemarks, setRejectionRemarks] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [customType, setCustomType] = useState('');
  const [customOwnership, setCustomOwnership] = useState('');
  const [typeOtherMode, setTypeOtherMode] = useState(false);
  const [ownershipOtherMode, setOwnershipOtherMode] = useState(false);

  const dynamicTypeOptionsByCategory = useMemo(() => {
    const byCategory: Record<string, Set<string>> = {};
    for (const category of CATEGORY_OPTIONS) {
      byCategory[category] = new Set(CATEGORY_TYPE_OPTIONS[category] || []);
    }
    for (const f of allFeatures) {
      const c = String(f.attributes?.Category ?? '').trim();
      const t = String(f.attributes?.Type ?? '').trim();
      if (!c || !t) continue;
      if (!byCategory[c]) byCategory[c] = new Set<string>();
      byCategory[c].add(t);
    }
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(byCategory)) out[k] = Array.from(v);
    return out;
  }, [allFeatures]);

  const dynamicOwnershipOptions = useMemo(() => {
    const extra = allFeatures
      .filter((f) => String(f.attributes?.Category ?? '').trim() === 'Health Facilities')
      .map((f) => String(f.attributes?.Ownership ?? '').trim())
      .filter(Boolean);
    return [...new Set([...OWNERSHIP_OPTIONS, ...extra])];
  }, [allFeatures]);

  const mergedWardOptions = useMemo(
    () => [...new Set(wardOptions.map((w) => String(w ?? '').trim()).filter(Boolean))],
    [wardOptions]
  );

  const mergedZoneOptions = useMemo(
    () => [...new Set(zoneOptions.map((z) => String(z ?? '').trim()).filter(Boolean))],
    [zoneOptions]
  );

  useEffect(() => {
    setAttributes(feature.attributes);
    setStatus(feature.status);
    setIsDirty(false);
    setRejectionRemarks((feature as any).remarks || '');

    const category = String(feature.attributes?.Category ?? '').trim();
    const type = String(feature.attributes?.Type ?? '').trim();
    const ownership = String(feature.attributes?.Ownership ?? '').trim();
    const knownTypes = dynamicTypeOptionsByCategory[category] || [];

    const isKnownCategory = CATEGORY_OPTIONS.includes(category as any);
    if (category && !isKnownCategory) {
      setAttributeValue('Category', '');
    }
    setTypeOtherMode(Boolean(type) && !knownTypes.includes(type));
    setOwnershipOtherMode(Boolean(ownership) && !dynamicOwnershipOptions.includes(ownership));
    setCustomType(type && !knownTypes.includes(type) ? type : '');
    setCustomOwnership(ownership && !dynamicOwnershipOptions.includes(ownership) ? ownership : '');
  }, [feature, dynamicOwnershipOptions, dynamicTypeOptionsByCategory]);

  const setAttributeValue = (key: string, value: string) => {
    setAttributes((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const selectedCategory = String(attributes?.Category ?? '').trim();
  const typeOptions = dynamicTypeOptionsByCategory[selectedCategory] || [];

  const validateOtherInputs = () => {
    if (typeOtherMode && !String(attributes?.Type ?? '').trim()) {
      alert('Please write a custom Type value for "Other".');
      return false;
    }
    if (selectedCategory === 'Health Facilities' && ownershipOtherMode && !String(attributes?.Ownership ?? '').trim()) {
      alert('Please write a custom Ownership value for "Other".');
      return false;
    }
    return true;
  };

  const validateRequiredAttributes = () => {
    const ordered = getOrderedAttributes(attributes);
    const missing: string[] = [];

    for (const [key, value] of ordered) {
      if (READ_ONLY_ATTRIBUTES.has(key)) continue;
      if (key.startsWith('__') || key.startsWith('_')) continue;
      if (key === 'Ownership' && selectedCategory !== 'Health Facilities') continue;
      if (!String(value ?? '').trim()) missing.push(key);
    }

    if (missing.length > 0) {
      alert(`Please fill all required attribute fields: ${missing.join(', ')}`);
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!user) return;
    if (!validateOtherInputs()) return;
    if (!validateRequiredAttributes()) return;
    setIsSaving(true);
    try {
      const attributesToSave =
        isDirty && !isNewFeature
          ? {
              ...attributes,
              ChangeBy: user.email || '',
              ChangeAt: new Date().toISOString()
            }
          : attributes;
      const nextStatus: FeatureStatus = isNewFeature
        ? 'pending'
        : (isDirty ? 'verified' : status);
      if (isNewFeature) {
        if (!onCreateFeature) {
          throw new Error('Create feature handler is missing.');
        }
        await onCreateFeature({ attributes: attributesToSave, status: nextStatus });
      } else {
        const featureRef = doc(db, 'features', feature.id);
        await updateDoc(featureRef, {
          attributes: attributesToSave,
          status: nextStatus,
          updatedBy: user.email,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
          // Store current location for verification
          ...(location && {
            collectorLocation: {
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy
            }
          })
        });
      }
      setIsSaving(false);
      onClose();
    } catch (error) {
      try {
        handleFirestoreError(error, OperationType.UPDATE, `features/${feature.id}`);
      } catch (e: any) {
        console.error('Save feature failed:', e);
        alert(e?.message || 'Failed to save feature changes');
      }
      setIsSaving(false);
    }
  };

  const handleReject = async () => {
    if (!window.confirm('Are you sure you want to reject this feature?')) return;
    try {
      if (!user) return;
      const remarks = rejectionRemarks.trim();
      if (!remarks) {
        alert('Rejection remarks are required.');
        return;
      }

      // Admin and enumerator both reject with mandatory remarks.
      await updateDoc(doc(db, 'features', feature.id), {
        remarks,
        status: 'rejected',
        updatedBy: user.email,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp()
      });
      onClose();
    } catch (error) {
      try {
        handleFirestoreError(error, OperationType.DELETE, `features/${feature.id}`);
      } catch (e: any) {
        console.error('Reject feature failed:', e);
        alert(e?.message || 'Failed to reject feature');
      }
    }
  };

  const canDeleteFeature = isAdmin || feature.type === 'point';

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          {feature.type === 'point' ? 'Landmark' : feature.type === 'line' ? 'Road' : 'Slum Boundary'}
          <span className="text-xs font-normal text-gray-400">#{feature.id.slice(0, 8)}</span>
        </h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
          <X size={20} className="text-gray-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Verification Alert */}
        {isAdmin && feature.collectorLocation && (
          <div className="bg-blue-50 border border-blue-100 p-3 rounded-lg flex items-start gap-2 mb-4">
            <MapPin size={18} className="text-blue-500 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-800">Verification Info</p>
              <p className="text-xs text-blue-600">
                Collector was at ({feature.collectorLocation.lat.toFixed(4)}, {feature.collectorLocation.lng.toFixed(4)}) 
                when this feature was last updated.
              </p>
            </div>
          </div>
        )}

        {/* Status Section */}
        <section>
          <label className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 block">Status</label>
          <div className="grid grid-cols-3 gap-2">
            {(['pending', 'verified', 'rejected'] as FeatureStatus[]).map((s) => (
              <button
                key={s}
                disabled={!isAdmin}
                onClick={() => setStatus(s)}
                className={`text-xs py-2 px-1 rounded-md border capitalize transition-all flex flex-col items-center gap-1 ${
                  status === s 
                    ? s === 'verified' ? 'bg-green-100 border-green-500 text-green-700' :
                      s === 'rejected' ? 'bg-red-100 border-red-500 text-red-700' :
                      'bg-amber-100 border-amber-500 text-amber-700'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                }`}
              >
                {s === 'verified' ? <CheckCircle size={14} /> : s === 'rejected' ? <AlertCircle size={14} /> : <Clock size={14} />}
                {s}
              </button>
            ))}
          </div>
        </section>

        {/* Attributes Section */}
        <section>
          <label className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 block">Attributes</label>
          <div className="space-y-3">
            {getOrderedAttributes(attributes).map(([key, value]) => {
              const isReadOnly = READ_ONLY_ATTRIBUTES.has(key);
              const stringValue = String(value ?? '');

              if (key === 'Category') {
                return (
                  <div key={key} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5">
                        {key} <span className="text-red-500">*</span>
                      </p>
                      <select
                        value={stringValue}
                        onChange={(e) => {
                          const next = e.target.value;
                          setTypeOtherMode(false);
                          setOwnershipOtherMode(false);
                          setCustomType('');
                          setCustomOwnership('');
                          setAttributeValue('Category', next);
                          setAttributeValue('Type', '');
                          setAttributeValue('Ownership', '');
                        }}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      >
                        <option value="">Select Category</option>
                        {CATEGORY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              }

              if (key === 'Type') {
                const isOther = stringValue && !typeOptions.includes(stringValue);
                return (
                  <div key={key} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5">
                        {key} <span className="text-red-500">*</span>
                      </p>
                      <select
                        value={typeOtherMode || isOther ? 'Other' : stringValue}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next === 'Other') {
                            setTypeOtherMode(true);
                            const nextCustom = stringValue && !typeOptions.includes(stringValue) ? stringValue : '';
                            setCustomType(nextCustom);
                            setAttributeValue('Type', nextCustom);
                            return;
                          }
                          setTypeOtherMode(false);
                          setCustomType('');
                          setAttributeValue('Type', next);
                        }}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      >
                        <option value="">{typeOptions.length > 0 ? 'Select Type' : 'Select Category first'}</option>
                        {typeOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                        <option value="Other">Other</option>
                      </select>
                      {(typeOtherMode || isOther || customType) && (
                        <input
                          type="text"
                          value={stringValue}
                          onChange={(e) => {
                            setCustomType(e.target.value);
                            setAttributeValue('Type', e.target.value);
                          }}
                          placeholder="Write custom type"
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                      )}
                    </div>
                  </div>
                );
              }

              if (key === 'Ownership') {
                if (selectedCategory !== 'Health Facilities') return null;
                const isOther = stringValue && !dynamicOwnershipOptions.includes(stringValue);
                return (
                  <div key={key} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5">
                        {key} <span className="text-red-500">*</span>
                      </p>
                      <select
                        value={ownershipOtherMode || isOther ? 'Other' : stringValue}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next === 'Other') {
                            setOwnershipOtherMode(true);
                            const nextCustom = stringValue && !dynamicOwnershipOptions.includes(stringValue) ? stringValue : '';
                            setCustomOwnership(nextCustom);
                            setAttributeValue('Ownership', nextCustom);
                            return;
                          }
                          setOwnershipOtherMode(false);
                          setCustomOwnership('');
                          setAttributeValue('Ownership', next);
                        }}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      >
                        <option value="">Select Ownership</option>
                        {dynamicOwnershipOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                        <option value="Other">Other</option>
                      </select>
                      {(ownershipOtherMode || isOther || customOwnership) && (
                        <input
                          type="text"
                          value={stringValue}
                          onChange={(e) => {
                            setCustomOwnership(e.target.value);
                            setAttributeValue('Ownership', e.target.value);
                          }}
                          placeholder="Write custom ownership"
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                      )}
                    </div>
                  </div>
                );
              }

              if (key === 'Ward_Name') {
                return (
                  <div key={key} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5">
                        {key} <span className="text-red-500">*</span>
                      </p>
                      <select
                        value={stringValue}
                        onChange={(e) => setAttributeValue('Ward_Name', e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      >
                        <option value="">Select Ward</option>
                        {mergedWardOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              }

              if (key === 'Zone') {
                return (
                  <div key={key} className="flex gap-2 items-start">
                    <div className="flex-1 space-y-2">
                      <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5">
                        {key} <span className="text-red-500">*</span>
                      </p>
                      <select
                        value={stringValue}
                        onChange={(e) => setAttributeValue('Zone', e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      >
                        <option value="">Select Zone</option>
                        {mergedZoneOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              }

              return (
                <div key={key} className="flex gap-2 items-center">
                  <div className="flex-1">
                    <p className="text-[10px] text-gray-400 font-medium ml-1 mb-0.5 flex items-center gap-1">
                      {key}
                      {!isReadOnly && !(key === 'Ownership' && selectedCategory !== 'Health Facilities') && (
                        <span className="text-red-500">*</span>
                      )}
                      {isReadOnly && <span className="text-gray-300 text-[8px]">🔒</span>}
                    </p>
                    <input
                      type="text"
                      value={stringValue}
                      onChange={(e) => {
                        setAttributeValue(key, e.target.value);
                      }}
                      disabled={isReadOnly}
                      className={`w-full px-3 py-2 text-sm border rounded-lg outline-none transition-all ${
                        isReadOnly
                          ? 'bg-gray-100 border-gray-200 text-gray-500 cursor-not-allowed'
                          : 'border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-amber-600 mt-2">
            🔒 = Read-only field. You can edit other values only.
          </p>
        </section>

        <section className="pt-4 text-[10px] text-gray-400 space-y-1">
          <div className="flex items-center gap-1">
            <User size={10} /> 
            <span>Last updated by: {feature.updatedBy || 'System'}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock size={10} />
            <span>Updated at: {feature.updatedAt ? new Date(feature.updatedAt).toLocaleString() : 'N/A'}</span>
          </div>
        </section>
      </div>

      <div className="p-4 border-t border-gray-100 bg-gray-50 flex gap-2">
        {!isAdmin && canDeleteFeature && (
          <div className="flex-1">
            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 block">
              Rejection Remarks (Required)
            </label>
            <input
              type="text"
              value={rejectionRemarks}
              onChange={(e) => setRejectionRemarks(e.target.value)}
              placeholder="Reason for rejecting this feature"
              className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
            />
          </div>
        )}
        {isAdmin && canDeleteFeature && (
          <div className="flex-1">
            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 block">
              Rejection Remarks (Required)
            </label>
            <input
              type="text"
              value={rejectionRemarks}
              onChange={(e) => setRejectionRemarks(e.target.value)}
              placeholder="Reason for rejecting this feature"
              className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
            />
          </div>
        )}
        <button
          onClick={handleReject}
          disabled={!canDeleteFeature || !rejectionRemarks.trim()}
          className="px-3 py-2.5 text-red-600 font-medium hover:bg-red-50 rounded-xl transition-colors border border-red-100 disabled:opacity-30 disabled:hover:bg-transparent"
          title={canDeleteFeature ? "Reject Feature" : "Only admins can reject non-point features"}
        >
          Reject
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex-1 bg-blue-600 text-white font-medium py-2.5 rounded-xl flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-50 transition-all shadow-lg shadow-blue-200"
        >
          {isSaving ? (isNewFeature ? 'Saving...' : 'Updating...') : <><Save size={20} /> {isNewFeature ? 'Save' : 'Update'}</>}
        </button>
      </div>
    </div>
  );
};
