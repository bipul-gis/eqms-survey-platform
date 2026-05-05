import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { UserProfile } from '../types';

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let userProfileUnsubscribe: (() => void) | null = null;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);

      if (!user) {
        if (userProfileUnsubscribe) userProfileUnsubscribe();
        userProfileUnsubscribe = null;
        setUserProfile(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      const isWhitelistedAdmin =
        user.email === 'bipul.paul@eqmscl.com' ||
        user.email === 'admin@ccc.gov.bd';

      // Stop any previous listener (if the auth state changes).
      if (userProfileUnsubscribe) userProfileUnsubscribe();

      const userDocRef = doc(db, 'users', user.uid);

      // Optimistic profile so UI doesn't "Checking your access" for a long time.
      const optimisticProfile: UserProfile = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || user.email?.split('@')[0] || 'User',
        role: isWhitelistedAdmin ? 'admin' : 'enumerator',
        status: isWhitelistedAdmin ? 'approved' : 'pending'
      };
      // Keep loading until first user-profile snapshot arrives to avoid
      // "pending" flicker for already-approved enumerators on login.
      setUserProfile(null);

      // Listen for admin approvals / status changes in real-time.
      let initializedDoc = false;
      userProfileUnsubscribe = onSnapshot(
        userDocRef,
        (snap) => {
          if (!snap.exists()) {
            // Create the doc once if missing (e.g. first login).
            if (initializedDoc) return;
            initializedDoc = true;

            void (async () => {
              try {
                const deletedByUidSnap = await getDoc(doc(db, 'deleted_users', user.uid));
                const emailKey = user.email ? encodeURIComponent(user.email.trim().toLowerCase()) : null;
                const deletedByEmailSnap = emailKey
                  ? await getDoc(doc(db, 'deleted_user_emails', emailKey))
                  : null;

                if (deletedByUidSnap.exists() || deletedByEmailSnap?.exists()) {
                  const blockedProfile: UserProfile = {
                    ...optimisticProfile,
                    role: 'enumerator',
                    status: 'rejected'
                  };
                  setUserProfile(blockedProfile);
                  setLoading(false);
                  await signOut(auth);
                  return;
                }

                await setDoc(userDocRef, optimisticProfile);
                setUserProfile(optimisticProfile);
                setLoading(false);
              } catch (e) {
                console.error('AuthProvider: failed creating user doc', e);
                setUserProfile(optimisticProfile);
                setLoading(false);
              }
            })();
            return;
          }

          const profile = snap.data() as UserProfile;

          if (isWhitelistedAdmin) {
            const updatedProfile: UserProfile = { ...profile, role: 'admin', status: 'approved' };
            if (profile.role !== 'admin' || profile.status !== 'approved') {
              void setDoc(userDocRef, updatedProfile);
            }
            setUserProfile(updatedProfile);
            setLoading(false);
          } else {
            setUserProfile(profile);
            setLoading(false);
          }
        },
        (err) => {
          console.error('AuthProvider: onSnapshot user doc failed', err);
          // Keep the optimistic profile so user sees correct gating (pending/approved).
          setUserProfile(optimisticProfile);
          setLoading(false);
        }
      );
    });

    return () => {
      if (userProfileUnsubscribe) userProfileUnsubscribe();
      unsubscribe();
    };
  }, []);

  const login = async (email: string, pass: string) => {
    await signInWithEmailAndPassword(auth, email, pass);
  };

  const logout = async () => {
    await signOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
