import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import {
  geosurveyApi,
  setStoredSessionToken,
  getStoredSessionToken,
  ApiError
} from '../lib/geosurveyApi';
import { UserProfile } from '../types';
import { normalizedFullName } from '../lib/userDisplayName';
import {
  cacheAuthProfile,
  clearCachedAuthProfile,
  getCachedAuthProfile
} from '../lib/offlineResponses';

export interface AuthUser {
  uid: string;
  email: string;
  displayName?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  userProfile: UserProfile | null;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Only the server explicitly rejecting the token means the session is really
 * gone. Everything else (API restart 5xx, gateway 502, offline) is transient,
 * and discarding the token for those would sign out a still-valid session.
 */
function isAuthRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

const SESSION_RETRY_DELAYS_MS = [1_500, 4_000];

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const profileRefreshInFlight = useRef(false);
  const currentProfile = useRef<UserProfile | null>(null);

  const applySession = useCallback((profile: UserProfile, token: string) => {
    if (!profile?.uid) {
      throw new Error('Login succeeded but user profile was incomplete. Please try again.');
    }
    setStoredSessionToken(token);
    cacheAuthProfile(profile, token);
    setUser({
      uid: profile.uid,
      email: profile.email,
      displayName: profile.displayName,
    });
    currentProfile.current = profile;
    setUserProfile(profile);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (profileRefreshInFlight.current) return;
    profileRefreshInFlight.current = true;
    try {
      const token = getStoredSessionToken();
      if (!token) {
        setUser(null);
        currentProfile.current = null;
        setUserProfile(null);
        return;
      }
      const session = await geosurveyApi.session();
      if (!session?.profile?.uid || !session.sessionToken) return;
      if (JSON.stringify(session.profile) !== JSON.stringify(currentProfile.current)) {
        applySession(session.profile, session.sessionToken);
      }
    } catch (error) {
      // Keep the last good session through offline gaps and server hiccups.
      if (!isAuthRejection(error)) return;
      clearCachedAuthProfile();
      setStoredSessionToken(null);
      setUser(null);
      currentProfile.current = null;
      setUserProfile(null);
      throw error;
    } finally {
      profileRefreshInFlight.current = false;
    }
  }, [applySession]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = getStoredSessionToken();
        if (!token) {
          if (!cancelled) setLoading(false);
          return;
        }
        // Restore the last verified workspace immediately. Session validation
        // still runs below, but a slow server wake-up or field connection no
        // longer holds the entire app behind the startup screen.
        const cached = getCachedAuthProfile();
        if (cached && cached.token === token) {
          if (!cancelled) {
            applySession(cached.profile as unknown as UserProfile, cached.token);
            setLoading(false);
          }
        }
        // Retry transient failures so an API restart mid-launch does not look
        // like a dead session.
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= SESSION_RETRY_DELAYS_MS.length; attempt += 1) {
          if (cancelled) return;
          try {
            const session = await geosurveyApi.session();
            if (!cancelled) applySession(session.profile, session.sessionToken);
            return;
          } catch (error) {
            lastError = error;
            if (isAuthRejection(error)) break;
            if (attempt < SESSION_RETRY_DELAYS_MS.length) {
              await delay(SESSION_RETRY_DELAYS_MS[attempt]);
            }
          }
        }
        if (cancelled) return;

        if (!isAuthRejection(lastError)) {
          // Server unreachable: fall back to the cached profile and keep the
          // token so the session resumes once the API is back.
          if (cached && cached.token === token) {
            if (!cancelled) applySession(cached.profile as unknown as UserProfile, cached.token);
          }
          return;
        }

        setStoredSessionToken(null);
        clearCachedAuthProfile();
        setUser(null);
        currentProfile.current = null;
        setUserProfile(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  useEffect(() => {
    if (!userProfile?.uid) return;
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') {
        void refreshProfile().catch(() => undefined);
      }
    };
    // Pending enumerators are waiting for an admin action. Check frequently
    // while the screen is open, then use a lighter cadence after approval.
    const pollMs = userProfile.status === 'pending' ? 5_000 : 30_000;
    const interval = window.setInterval(() => {
      refreshWhenActive();
    }, pollMs);
    window.addEventListener('focus', refreshWhenActive);
    window.addEventListener('pageshow', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    refreshWhenActive();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenActive);
      window.removeEventListener('pageshow', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [userProfile?.uid, userProfile?.status, refreshProfile]);

  const login = async (email: string, pass: string) => {
    const session = await geosurveyApi.login(email, pass);
    if (!session?.profile?.uid || !session.sessionToken) {
      throw new Error('Login failed: incomplete server response. Check your connection and try again.');
    }
    applySession(session.profile, session.sessionToken);
  };

  const logout = async () => {
    try {
      await geosurveyApi.logout();
    } catch {
      // ignore
    }
    setStoredSessionToken(null);
    clearCachedAuthProfile();
    setUser(null);
    currentProfile.current = null;
    setUserProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
