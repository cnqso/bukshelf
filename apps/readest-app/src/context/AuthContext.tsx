'use client';

import {
  createContext,
  useState,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
} from 'react';
import type { AuthUser } from '@/types/auth';
import posthog from 'posthog-js';
import { logoutOfBukshelf, restoreBukshelfSession } from '@/services/bukshelfAuthClient';
import { getBukshelfApiBaseUrl } from '@/services/runtimeConfig';

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  });
  const [user, setUser] = useState<AuthUser | null>(() => {
    if (typeof window !== 'undefined') {
      const userJson = localStorage.getItem('user');
      return userJson ? JSON.parse(userJson) : null;
    }
    return null;
  });

  const syncSession = useCallback((session: { accessToken: string; user: AuthUser } | null) => {
    if (session) {
      localStorage.setItem('token', session.accessToken);
      localStorage.setItem('user', JSON.stringify(session.user));
      posthog.identify(session.user.id);
      setToken(session.accessToken);
      setUser(session.user);
    } else {
      localStorage.removeItem('token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      setToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    if (!getBukshelfApiBaseUrl()) {
      syncSession(null);
      return;
    }
    void restoreBukshelfSession(localStorage.getItem('token'))
      .then(({ accessToken, user }) => syncSession({ accessToken, user }))
      .catch(() => syncSession(null));
  }, [syncSession]);

  // Keep the context actions stable so consumers do not rerender merely because
  // the provider rendered. Session-bearing actions intentionally update when
  // the current token changes.
  const login = useCallback(
    (newToken: string, newUser: AuthUser) => {
      syncSession({ accessToken: newToken, user: newUser });
    },
    [syncSession],
  );

  const logout = useCallback(async () => {
    try {
      await logoutOfBukshelf(token);
    } finally {
      syncSession(null);
    }
  }, [syncSession, token]);

  const refresh = useCallback(async () => {
    try {
      const session = await restoreBukshelfSession(token);
      syncSession({ accessToken: session.accessToken, user: session.user });
    } catch {
      syncSession(null);
    }
  }, [syncSession, token]);

  const value = useMemo(
    () => ({ token, user, login, logout, refresh }),
    [token, user, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
