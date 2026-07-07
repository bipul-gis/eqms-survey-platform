import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { geosurveyApi, setStoredSessionToken, getStoredSessionToken } from '../lib/geosurveyApi';
import { UserProfile } from '../types';
import { normalizedFullName } from '../lib/userDisplayName';

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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((profile: UserProfile, token: string) => {
    setStoredSessionToken(token);
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
    const session = await geosurveyApi.session();
    applySession(session.profile, session.sessionToken);
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
        const session = await geosurveyApi.session();
        if (!cancelled) {
          applySession(session.profile, session.sessionToken);
        }
      } catch {
        setStoredSessionToken(null);
        if (!cancelled) {
          setUser(null);
          setUserProfile(null);
        }
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
    applySession(session.profile, session.sessionToken);
  };

  const logout = async () => {
    try {
      await geosurveyApi.logout();
    } catch {
      // ignore
    }
    setStoredSessionToken(null);
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
