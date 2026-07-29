import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
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
    setUserProfile(profile);
  }, []);

  const refreshProfile = useCallback(async () => {
    const token = getStoredSessionToken();
    if (!token) {
      setUser(null);
      setUserProfile(null);
      return;
    }
    try {
      const session = await geosurveyApi.session();
      if (!session?.profile?.uid || !session.sessionToken) return;
      applySession(session.profile, session.sessionToken);
    } catch (error) {
      // Keep the last good session through offline gaps and server hiccups.
      if (!isAuthRejection(error)) return;
      clearCachedAuthProfile();
      setStoredSessionToken(null);
      setUser(null);
      setUserProfile(null);
      throw error;
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
          const cached = getCachedAuthProfile();
          if (cached && cached.token === token) {
            applySession(cached.profile as unknown as UserProfile, cached.token);
          }
          return;
        }

        setStoredSessionToken(null);
        clearCachedAuthProfile();
        setUser(null);
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
    const interval = window.setInterval(() => {
      void refreshProfile().catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [userProfile?.uid, refreshProfile]);

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
