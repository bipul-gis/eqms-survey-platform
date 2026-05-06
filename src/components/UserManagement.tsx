import React, { useMemo, useState, useEffect } from 'react';
import {
  UserPlus,
  X,
  Key,
  Mail,
  User as UserIcon,
  Shield,
  Check,
  Clock,
  Ban,
  ClipboardList,
  Phone,
  Search
} from 'lucide-react';
import { fetchLandmarkGeoJson } from '../lib/landmarkGeoJson';

import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, setDoc, collection, query, where, onSnapshot, updateDoc, deleteField, deleteDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { db } from '../lib/firebase';
import { UserProfile } from '../types';

type EnumeratorEntry = {
  email: string;
  displayName: string;
  mobileNumber?: string;
  // One email can map to multiple Firebase Auth UIDs.
  uids: string[];
  /** Normalized list (legacy single ward folded in when loading). */
  assignedWardNames: string[];
};

const normalizeUserSearch = (q: string) => q.trim().toLowerCase();

const enumeratorMatchesSearch = (e: EnumeratorEntry, q: string): boolean => {
  const n = normalizeUserSearch(q);
  if (!n) return true;
  const hay = [e.displayName, e.email, e.mobileNumber ?? '', e.uids.join(' ')].join(' ').toLowerCase();
  return hay.includes(n);
};

/** Admin-only: Firebase Auth UIDs (one line each if merged by email). */
const EnumeratorUidLines: React.FC<{ uids: string[] }> = ({ uids }) => {
  const list = uids.filter(Boolean);
  if (list.length === 0) return null;
  return (
    <div className="text-[9px] text-gray-400 font-mono leading-snug space-y-0.5 mt-0.5">
      {list.map((id, i) => (
        <p key={id} className="truncate" title={id}>
          {list.length > 1 ? `UID ${i + 1}: ` : 'UID: '}
          {id}
        </p>
      ))}
    </div>
  );
};

const pendingUserMatchesSearch = (u: UserProfile, q: string): boolean => {
  const n = normalizeUserSearch(q);
  if (!n) return true;
  const hay = [u.displayName ?? '', u.email ?? '', u.mobileNumber ?? '', u.uid ?? ''].join(' ').toLowerCase();
  return hay.includes(n);
};

const normalizeWardKey = (s: string) => s.trim().toLowerCase();
const parseWardNumber = (label: string): number | null => {
  const m = String(label).trim().match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

const wardsFromUserProfile = (data: UserProfile): string[] => {
  const list = data.assignedWardNames;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  const legacy = data.assignedWardName;
  if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()];
  return [];
};

const EnumeratorWardRow: React.FC<{
  entry: EnumeratorEntry;
  wardOptions: string[];
  saving: boolean;
  onSave: (wards: string[]) => void;
  /** Normalized ward key -> holder (other enumerators only) */
  wardHeldByOther: Map<string, { displayName: string; email: string }>;
}> = ({ entry, wardOptions, onSave, saving, wardHeldByOther }) => {
  const [value, setValue] = useState<string[]>(() => [...entry.assignedWardNames]);

  useEffect(() => {
    setValue([...entry.assignedWardNames]);
  }, [entry.assignedWardNames, entry.email]);

  const toggleWard = (w: string) => {
    setValue((prev) => {
      const next = prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort((a, b) => a.localeCompare(b));
      return next;
    });
  };

  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-800 truncate">{entry.displayName}</p>
        <p className="text-[10px] text-gray-500 truncate">{entry.email}</p>
        <p className="text-[10px] text-gray-500 truncate">{entry.mobileNumber || 'No mobile number'}</p>
        <EnumeratorUidLines uids={entry.uids} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Ward_Name (multi)</label>
          <button
            type="button"
            disabled={saving || value.length === 0}
            onClick={() => setValue([])}
            className="text-[10px] font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
        <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-1.5 bg-white">
          {wardOptions.map((w) => {
            const key = normalizeWardKey(w);
            const holder = wardHeldByOther.get(key);
            const mine = value.includes(w);
            const blocked = !!holder && !mine;
            const title = blocked && holder
              ? `Assigned to ${holder.displayName} (${holder.email})`
              : undefined;

            return (
              <label
                key={w}
                title={title}
                className={`flex items-start gap-2 text-xs select-none ${
                  blocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={() => toggleWard(w)}
                  disabled={saving || blocked}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block truncate text-gray-800">{w}</span>
                  {blocked && holder && (
                    <span className="block text-[10px] text-amber-700 leading-tight">
                      Taken · {holder.displayName}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-[10px] text-gray-500">
          {value.length === 0
            ? 'No selection — enumerator sees no wards.'
            : `${value.length} ward(s) selected.`}
        </p>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(value)}
          className="w-full text-xs font-bold py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save assignment'}
        </button>
      </div>
    </div>
  );
};

export const UserManagement: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUsers, setPendingUsers] = useState<UserProfile[]>([]);
  const [activeTab, setActiveTab] = useState<'create' | 'pending' | 'tasks'>('pending');

  const [activeEnumeratorsCount, setActiveEnumeratorsCount] = useState(0);
  const [activeEnumerators, setActiveEnumerators] = useState<EnumeratorEntry[]>([]);
  const [deactivatedEnumeratorsCount, setDeactivatedEnumeratorsCount] = useState(0);
  const [deactivatedEnumerators, setDeactivatedEnumerators] = useState<EnumeratorEntry[]>([]);
  const [totalEnumeratorsCount, setTotalEnumeratorsCount] = useState(0);
  const [landmarkWardOptions, setLandmarkWardOptions] = useState<string[]>([]);

  const [enumActionLoadingEmail, setEnumActionLoadingEmail] = useState<string | null>(null);
  const [taskSavingEmail, setTaskSavingEmail] = useState<string | null>(null);
  const [clearingAllAssignments, setClearingAllAssignments] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [manageTabSearch, setManageTabSearch] = useState('');
  const [tasksTabSearch, setTasksTabSearch] = useState('');

  const wardNameOptions = useMemo(
    () =>
      [...landmarkWardOptions].sort((a, b) => {
        const an = parseWardNumber(a);
        const bn = parseWardNumber(b);
        if (an !== null && bn !== null) return an - bn;
        if (an !== null) return -1;
        if (bn !== null) return 1;
        return a.localeCompare(b);
      }),
    [landmarkWardOptions]
  );

  /** For each enumerator row: wards already assigned to someone else (normalized ward key -> holder). */
  const wardLocksByEnumeratorEmail = useMemo(() => {
    const result = new Map<string, Map<string, { displayName: string; email: string }>>();
    for (const target of activeEnumerators) {
      const myKey = target.email.trim().toLowerCase();
      const m = new Map<string, { displayName: string; email: string }>();
      for (const e of activeEnumerators) {
        if (e.email.trim().toLowerCase() === myKey) continue;
        for (const w of e.assignedWardNames) {
          m.set(normalizeWardKey(w), { displayName: e.displayName, email: e.email });
        }
      }
      result.set(target.email, m);
    }
    return result;
  }, [activeEnumerators]);

  /** Same ward given to more than one enumerator (legacy or race) — admin should fix. */
  const duplicateWardAssignments = useMemo(() => {
    const keyToOwners = new Map<string, Set<string>>();
    const keyToLabel = new Map<string, string>();
    for (const e of activeEnumerators) {
      const nameLabel = (e.displayName || '').trim() || e.email;
      for (const w of e.assignedWardNames) {
        const nk = normalizeWardKey(w);
        keyToLabel.set(nk, w);
        const set = keyToOwners.get(nk) ?? new Set<string>();
        set.add(nameLabel);
        keyToOwners.set(nk, set);
      }
    }
    const dups: { wardLabel: string; owners: string[] }[] = [];
    for (const [nk, set] of keyToOwners) {
      if (set.size > 1) {
        dups.push({ wardLabel: keyToLabel.get(nk) ?? nk, owners: [...set] });
      }
    }
    return dups;
  }, [activeEnumerators]);

  const filteredActiveForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? activeEnumerators.filter((e) => enumeratorMatchesSearch(e, manageTabSearch))
        : activeEnumerators,
    [activeEnumerators, manageTabSearch]
  );

  const filteredDeactivatedForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? deactivatedEnumerators.filter((e) => enumeratorMatchesSearch(e, manageTabSearch))
        : deactivatedEnumerators,
    [deactivatedEnumerators, manageTabSearch]
  );

  const filteredPendingForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? pendingUsers.filter((u) => pendingUserMatchesSearch(u, manageTabSearch))
        : pendingUsers,
    [pendingUsers, manageTabSearch]
  );

  const filteredEnumeratorsForTasks = useMemo(
    () =>
      tasksTabSearch.trim()
        ? activeEnumerators.filter((e) => enumeratorMatchesSearch(e, tasksTabSearch))
        : activeEnumerators,
    [activeEnumerators, tasksTabSearch]
  );

  useEffect(() => {
    const q = query(collection(db, 'users'), where('status', '==', 'pending'));

    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const users: UserProfile[] = [];
        querySnapshot.forEach((doc) => {
          users.push(doc.data() as UserProfile);
        });
        setPendingUsers(users);
        // Clear any previous "pending load" errors when we successfully load data.
        setError(null);
      },
      (error) => {
        console.error('Error fetching pending users:', error);
        setError(
          error instanceof Error
            ? `Failed to load pending approvals: ${error.message}`
            : `Failed to load pending approvals: ${String(error)}`
        );
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadWardOptionsFromLandmarks = async () => {
      try {
        const resp = await fetchLandmarkGeoJson();
        if (!resp.ok) return;
        const geo = await resp.json();
        const rows = Array.isArray(geo?.features) ? geo.features : [];
        const wards = rows
          .map((f: any) => f?.properties?.Ward_Name ?? f?.properties?.WARDNAME ?? f?.properties?.WardName)
          .map((v: unknown) => String(v ?? '').trim())
          .filter(Boolean);
        if (!mounted) return;
        setLandmarkWardOptions([...new Set(wards)]);
      } catch {
        if (!mounted) return;
        setLandmarkWardOptions([]);
      }
    };

    loadWardOptionsFromLandmarks();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'users'), where('status', '==', 'approved'));

    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const byEmail = new Map<string, EnumeratorEntry>();
        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data() as UserProfile;
          if (data.role !== 'enumerator') return;
          const emailKey = (data.email || '').trim().toLowerCase();
          if (!emailKey) return;

          const uid = data.uid || docSnap.id;
          const existing = byEmail.get(emailKey);

          const wn = wardsFromUserProfile(data);

          if (!existing) {
            byEmail.set(emailKey, {
              email: data.email,
              displayName: data.displayName,
              mobileNumber: data.mobileNumber,
              uids: [uid],
              assignedWardNames: wn
            });
          } else {
            if (uid && !existing.uids.includes(uid)) {
              existing.uids.push(uid);
            }
            if (!existing.mobileNumber && data.mobileNumber) {
              existing.mobileNumber = data.mobileNumber;
            }
            if (existing.assignedWardNames.length === 0 && wn.length > 0) {
              existing.assignedWardNames = wn;
            }
          }
        });

        const entries = Array.from(byEmail.values()).sort((a, b) =>
          (a.displayName || '').localeCompare(b.displayName || '')
        );
        setActiveEnumerators(entries);
        setActiveEnumeratorsCount(entries.length);
      },
      (err) => console.error('Error fetching active enumerators:', err)
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'users'), where('status', '==', 'rejected'));

    const unsubscribe = onSnapshot(
      q,
      (querySnapshot) => {
        const byEmail = new Map<string, EnumeratorEntry>();
        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data() as UserProfile;
          if (data.role !== 'enumerator') return;
          const emailKey = (data.email || '').trim().toLowerCase();
          if (!emailKey) return;

          const uid = data.uid || docSnap.id;
          const existing = byEmail.get(emailKey);

          if (!existing) {
            byEmail.set(emailKey, {
              email: data.email,
              displayName: data.displayName,
              mobileNumber: data.mobileNumber,
              uids: [uid]
            });
          } else if (uid && !existing.uids.includes(uid)) {
            existing.uids.push(uid);
            if (!existing.mobileNumber && data.mobileNumber) {
              existing.mobileNumber = data.mobileNumber;
            }
          }
        });

        const entries = Array.from(byEmail.values()).sort((a, b) =>
          (a.displayName || '').localeCompare(b.displayName || '')
        );
        setDeactivatedEnumerators(entries);
        setDeactivatedEnumeratorsCount(entries.length);
      },
      (err) => console.error('Error fetching deactivated enumerators:', err)
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setTotalEnumeratorsCount(pendingUsers.length + activeEnumeratorsCount + deactivatedEnumeratorsCount);
  }, [pendingUsers.length, activeEnumeratorsCount, deactivatedEnumeratorsCount]);

  const handleApproveUser = async (userId: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), {
        status: 'approved'
      });
    } catch (error) {
      console.error('Error approving user:', error);
      setError('Failed to approve user');
    }
  };

  const handleRejectUser = async (userId: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), {
        status: 'rejected'
      });
    } catch (error) {
      console.error('Error rejecting user:', error);
      setError('Failed to reject user');
    }
  };

  const setEnumeratorStatusByEntry = async (entry: EnumeratorEntry, status: 'approved' | 'rejected') => {
    try {
      setEnumActionLoadingEmail(entry.email);
      setError(null);

      await Promise.all(
        entry.uids.map((uid) => updateDoc(doc(db, 'users', uid), { status }))
      );
    } catch (e) {
      console.error('Error updating enumerator status:', e);
      setError(`Failed to update enumerator (${status})`);
    } finally {
      setEnumActionLoadingEmail(null);
    }
  };

  const permanentlyDeleteEnumerator = async (entry: EnumeratorEntry) => {
    try {
      setEnumActionLoadingEmail(entry.email);
      setError(null);
      setDeleteNotice(null);

      const emailKey = encodeURIComponent(entry.email.trim().toLowerCase());

      await Promise.all([
        ...entry.uids.map((uid) =>
          setDoc(
            doc(db, 'deleted_users', uid),
            {
              uid,
              email: entry.email,
              displayName: entry.displayName,
              deletedAt: new Date().toISOString()
            },
            { merge: true }
          )
        ),
        setDoc(
          doc(db, 'deleted_user_emails', emailKey),
          {
            email: entry.email,
            displayName: entry.displayName,
            deletedAt: new Date().toISOString()
          },
          { merge: true }
        ),
        ...entry.uids.map((uid) => deleteDoc(doc(db, 'users', uid)))
      ]);

      setDeleteNotice(
        `Deleted ${entry.displayName}. This account is now blocked from auto re-registration requests. ` +
          `To remove Firebase Authentication login entirely, use Firebase Console or Admin SDK Cloud Function.`
      );
    } catch (e) {
      console.error('Error permanently deleting enumerator:', e);
      setError('Failed to permanently delete enumerator from Firestore');
    } finally {
      setEnumActionLoadingEmail(null);
    }
  };

  const saveEnumeratorWardAssignment = async (entry: EnumeratorEntry, wards: string[]) => {
    try {
      setTaskSavingEmail(entry.email);
      setError(null);
      const normalized = [...new Set(wards.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      );

      const myKey = entry.email.trim().toLowerCase();
      for (const w of normalized) {
        const wk = normalizeWardKey(w);
        const conflict = activeEnumerators.find(
          (e) =>
            e.email.trim().toLowerCase() !== myKey &&
            e.assignedWardNames.some((x) => normalizeWardKey(x) === wk)
        );
        if (conflict) {
          setError(
            `Cannot save: "${w}" is already assigned to ${conflict.displayName}. Remove it from that enumerator first.`
          );
          setTaskSavingEmail(null);
          return;
        }
      }

      await Promise.all(
        entry.uids.map((uid) =>
          updateDoc(doc(db, 'users', uid), {
            ...(normalized.length
              ? { assignedWardNames: normalized }
              : { assignedWardNames: deleteField() }),
            assignedWardName: deleteField()
          })
        )
      );
    } catch (e) {
      console.error('Error saving ward assignment:', e);
      setError('Failed to save ward assignment');
    } finally {
      setTaskSavingEmail(null);
    }
  };

  const clearAllEnumeratorWardAssignments = async () => {
    if (activeEnumerators.length === 0) return;

    try {
      setClearingAllAssignments(true);
      setError(null);

      const allUids = [...new Set(activeEnumerators.flatMap((entry) => entry.uids).filter(Boolean))];
      await Promise.all(
        allUids.map((uid) =>
          updateDoc(doc(db, 'users', uid), {
            assignedWardNames: deleteField(),
            assignedWardName: deleteField()
          })
        )
      );
    } catch (e) {
      console.error('Error clearing all ward assignments:', e);
      setError('Failed to clear all ward assignments');
    } finally {
      setClearingAllAssignments(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    // Workaround: Use a secondary app instance to create accounts without logging out admin
    const secondaryApp = initializeApp(firebaseConfig, 'Secondary');
    const secondaryAuth = getAuth(secondaryApp);

    try {
      const res = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      
      // Save profile to main DB
      await setDoc(doc(db, 'users', res.user.uid), {
        uid: res.user.uid,
        email,
        displayName: name,
        mobileNumber,
        role: 'enumerator',
        status: 'approved' // Admin-created accounts are automatically approved
      });

      // Sign out the new user from the secondary instance
      await signOut(secondaryAuth);
      
      setSuccess(true);
      setEmail('');
      setPassword('');
      setName('');
      setMobileNumber('');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to create user');
    } finally {
      setLoading(false);
      // Clean up secondary app
      // await deleteApp(secondaryApp); 
    }
  };

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <UserPlus size={20} className="text-blue-600" />
          User Management
        </h2>
        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
          <X size={20} className="text-gray-500" />
        </button>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-3 border-b border-gray-100">
        <button
          type="button"
          onClick={() => setActiveTab('pending')}
          className={`py-2.5 px-2 text-[11px] sm:text-xs font-medium transition-colors ${
            activeTab === 'pending' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Manage
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tasks')}
          className={`py-2.5 px-2 text-[11px] sm:text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
            activeTab === 'tasks' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <ClipboardList size={14} className="shrink-0 hidden sm:block" />
          Tasks
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`py-2.5 px-2 text-[11px] sm:text-xs font-medium transition-colors ${
            activeTab === 'create' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Create
        </button>
      </div>

      <div className="p-6 space-y-6 flex-1 overflow-y-auto">
        {activeTab !== 'create' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500 font-medium">Total Enumerators</span>
            <span className="text-blue-700 font-bold">{totalEnumeratorsCount}</span>
          </div>
          <div className="text-[11px] text-gray-500">
            Active: {activeEnumeratorsCount} • Deactivated: {deactivatedEnumeratorsCount}
          </div>
        </div>
        )}

        {activeTab === 'pending' && (
          <>
        {deleteNotice && (
          <div className="bg-amber-50 text-amber-800 p-3 rounded-xl text-xs border border-amber-100">
            {deleteNotice}
          </div>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={manageTabSearch}
            onChange={(e) => setManageTabSearch(e.target.value)}
            placeholder="Search users (name, email, mobile, UID)…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            aria-label="Search enumerators"
          />
        </div>
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-3">
            Active Enumerators ({filteredActiveForManage.length}
            {manageTabSearch.trim() ? ` / ${activeEnumeratorsCount}` : ''})
          </h3>

          {activeEnumerators.length === 0 ? (
            <p className="text-[11px] text-gray-400">No approved enumerators yet.</p>
          ) : filteredActiveForManage.length === 0 ? (
            <p className="text-[11px] text-gray-500">No users match your search.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto overscroll-contain space-y-2 pr-1">
              {filteredActiveForManage.map((u) => (
                <div key={u.email} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-gray-700 truncate">
                      {u.displayName}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">{u.email}</p>
                    <p className="text-[10px] text-gray-500 truncate">{u.mobileNumber || 'No mobile number'}</p>
                    <EnumeratorUidLines uids={u.uids} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        const ok = confirm(`Deactivate "${u.displayName}"?`);
                        if (!ok) return;
                        void setEnumeratorStatusByEntry(u, 'rejected');
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition-colors border border-red-100 disabled:opacity-50"
                      title="Deactivate enumerator"
                    >
                      Deactivate
                    </button>
                    <button
                      onClick={() => {
                        const ok = confirm(
                          `Permanently delete "${u.displayName}"?\n\nThis removes Firestore user record(s).`
                        );
                        if (!ok) return;
                        void permanentlyDeleteEnumerator(u);
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-100 text-red-800 hover:bg-red-200 transition-colors border border-red-200 disabled:opacity-50"
                      title="Delete enumerator record permanently"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-3">
            Deactivated Enumerators ({filteredDeactivatedForManage.length}
            {manageTabSearch.trim() ? ` / ${deactivatedEnumeratorsCount}` : ''})
          </h3>

          {deactivatedEnumerators.length === 0 ? (
            <p className="text-[11px] text-gray-400">No deactivated enumerators yet.</p>
          ) : filteredDeactivatedForManage.length === 0 ? (
            <p className="text-[11px] text-gray-500">No users match your search.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto overscroll-contain space-y-2 pr-1">
              {filteredDeactivatedForManage.map((u) => (
                <div key={u.email} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-gray-700 truncate">
                      {u.displayName}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">{u.email}</p>
                    <p className="text-[10px] text-gray-500 truncate">{u.mobileNumber || 'No mobile number'}</p>
                    <EnumeratorUidLines uids={u.uids} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        const ok = confirm(`Activate "${u.displayName}"?`);
                        if (!ok) return;
                        void setEnumeratorStatusByEntry(u, 'approved');
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors border border-green-100 disabled:opacity-50"
                      title="Activate enumerator"
                    >
                      Activate
                    </button>
                    <button
                      onClick={() => {
                        const ok = confirm(
                          `Permanently delete "${u.displayName}"?\n\nThis removes Firestore user record(s).`
                        );
                        if (!ok) return;
                        void permanentlyDeleteEnumerator(u);
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-100 text-red-800 hover:bg-red-200 transition-colors border border-red-200 disabled:opacity-50"
                      title="Delete enumerator record permanently"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        )}

        {activeTab === 'tasks' && (
          <div className="space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs border border-red-100">{error}</div>
            )}
            <div>
              <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                <ClipboardList size={18} className="text-blue-600" />
                Task distribution
              </h3>
              <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                Each ward can only be assigned to one enumerator. Select one or more wards per person; they only see
                features whose <span className="font-semibold text-gray-600">Ward_Name</span> matches a ward they hold.
                Wards taken by others are greyed out (release a ward by clearing it on the holder first). Clear all to
                give full access.
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  disabled={clearingAllAssignments || activeEnumerators.length === 0}
                  onClick={() => {
                    const ok = confirm(
                      'Clear ward assignments for all active enumerators?\n\nThis removes all task ward restrictions until you assign wards again.'
                    );
                    if (!ok) return;
                    void clearAllEnumeratorWardAssignments();
                  }}
                  className="text-xs font-bold px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                  title="Clear ward assignments for all enumerators"
                >
                  {clearingAllAssignments ? 'Clearing all wards…' : 'Clear all wards (all enumerators)'}
                </button>
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={tasksTabSearch}
                onChange={(e) => setTasksTabSearch(e.target.value)}
                placeholder="Search users (name, email, mobile, UID)…"
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                aria-label="Search enumerators for tasks"
              />
            </div>
            {duplicateWardAssignments.length > 0 && (
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg p-3 space-y-1">
                <p className="font-semibold">Overlapping assignments detected</p>
                <p className="text-amber-900">
                  The same ward is assigned to more than one enumerator. Adjust assignments so each ward has a single
                  holder:
                </p>
                <ul className="list-disc list-inside text-amber-900">
                  {duplicateWardAssignments.map((d) => (
                    <li key={d.wardLabel}>
                      <span className="font-medium">{d.wardLabel}</span>: {d.owners.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {wardNameOptions.length === 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                Could not read ward names from landmark reference data.
              </p>
            )}
            {activeEnumerators.length === 0 ? (
              <p className="text-sm text-gray-500">No approved enumerators to assign.</p>
            ) : filteredEnumeratorsForTasks.length === 0 ? (
              <p className="text-sm text-gray-500">No users match your search.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-[11px] text-gray-500">
                  Showing {filteredEnumeratorsForTasks.length}
                  {tasksTabSearch.trim() ? ` of ${activeEnumerators.length}` : ''} enumerator(s)
                </p>
                {filteredEnumeratorsForTasks.map((entry) => (
                  <EnumeratorWardRow
                    key={entry.email}
                    entry={entry}
                    wardOptions={wardNameOptions}
                    wardHeldByOther={wardLocksByEnumeratorEmail.get(entry.email) ?? new Map()}
                    saving={taskSavingEmail === entry.email || clearingAllAssignments}
                    onSave={(wards) => void saveEnumeratorWardAssignment(entry, wards)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'pending' && (
          <div>
            <h3 className="text-sm font-bold text-gray-700 mb-4">
              Pending Enumerator Sign-ups ({filteredPendingForManage.length}
              {manageTabSearch.trim() && pendingUsers.length > 0 ? ` / ${pendingUsers.length}` : ''})
            </h3>
            {pendingUsers.length === 0 ? (
              <p className="text-gray-500 text-sm">{error ? error : 'No pending approvals'}</p>
            ) : filteredPendingForManage.length === 0 ? (
              <p className="text-gray-500 text-sm">No users match your search.</p>
            ) : (
              <div className="space-y-3">
                {filteredPendingForManage.map(user => (
                  <div key={user.uid} className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="font-semibold text-gray-800">{user.displayName}</p>
                        <p className="text-xs text-gray-500">{user.email}</p>
                        <p className="text-xs text-gray-500">{user.mobileNumber || 'No mobile number'}</p>
                        <EnumeratorUidLines uids={user.uid ? [user.uid] : []} />
                      </div>
                      <div className="flex items-center gap-1 text-amber-600">
                        <Clock size={14} />
                        <span className="text-xs font-medium">Pending</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApproveUser(user.uid)}
                        className="flex-1 bg-green-600 text-white text-xs font-bold py-2 rounded-lg hover:bg-green-700 transition-colors flex items-center justify-center gap-1"
                      >
                        <Check size={14} /> Approve
                      </button>
                      <button
                        onClick={() => handleRejectUser(user.uid)}
                        className="flex-1 bg-red-600 text-white text-xs font-bold py-2 rounded-lg hover:bg-red-700 transition-colors flex items-center justify-center gap-1"
                      >
                        <Ban size={14} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'create' && (
          <>
            <div>
              <h3 className="text-sm font-bold text-gray-700 mb-2">Create Enumerator Account</h3>
              <p className="text-xs text-gray-500 mb-6">
                Create an account directly for a new enumerator. They will be approved automatically.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Full Name</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="text" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Email / Username</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="enumerator@ccc.gov.bd"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Mobile Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input
                    type="tel"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    placeholder="01XXXXXXXXX"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Initial Password</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="password" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs border border-red-100">
                  {error}
                </div>
              )}

              {success && (
                <div className="bg-green-50 text-green-600 p-3 rounded-xl text-xs border border-green-100 flex items-center gap-2">
                  <Check size={16} /> Account created successfully!
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition-all shadow-lg active:scale-95 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Account'}
              </button>
            </form>
          </>
        )}

        {activeTab === 'create' && (
          <div className="pt-6 border-t border-gray-100">
            <div className="bg-amber-50 p-4 rounded-2xl flex gap-3">
              <Shield className="text-amber-600 shrink-0" size={20} />
              <div>
                <p className="text-xs font-bold text-amber-800 mb-1">Important Note</p>
                <p className="text-[10px] text-amber-700 leading-relaxed">
                  Creating an account will temporarily sign you out in order to register the new user on this device. 
                  You will need to sign back in as Admin afterwards. 
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
