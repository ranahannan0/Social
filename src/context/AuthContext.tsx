/**
 * Auth context (Phase 2 frontend cutover — design doc §9).
 *
 * Holds the current user (or null), the auth-loading flag, and a signOut
 * action. On mount it probes /api/auth/me to restore a session from
 * sessionStorage; if the token is missing or expired, the user is null and
 * the AuthScreen is shown.
 *
 * Mutation actions (signIn / signUp) are exposed for the AuthScreen. They
 * throw AuthError on failure so the screen can surface the server's error
 * message verbatim.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  AuthUser,
  AuthError,
  signIn as clientSignIn,
  signUp as clientSignUp,
  signOut as clientSignOut,
  fetchMe,
  hasValidSession,
} from '../services/authClient';
import { resetSyncQueue } from '../services/cloudSync';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;       // boot-time probe in progress
  authError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ requiresEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Boot probe: if a session exists in sessionStorage, verify it with the
  // server. If valid, hydrate the user. If not, drop the stale token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!hasValidSession()) {
        setLoading(false);
        return;
      }
      try {
        const me = await fetchMe();
        if (!cancelled) setUser(me);
      } catch {
        // Network errors during boot are non-fatal — the user can retry.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    try {
      const result = await clientSignIn(email, password);
      setUser(result.user);
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : 'Login failed. Please try again.';
      setAuthError(msg);
      throw err;
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    try {
      const result = await clientSignUp(email, password);
      if (result.requiresEmailConfirmation) {
        // Don't set user — they need to confirm email first.
        return { requiresEmailConfirmation: true };
      }
      setUser(result.user);
      return { requiresEmailConfirmation: false };
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : 'Signup failed. Please try again.';
      setAuthError(msg);
      throw err;
    }
  }, []);

  const signOut = useCallback(async () => {
    await clientSignOut();
    // Pending Stage-B sync tasks belong to the outgoing session — replaying
    // them under a different account would cross workspaces.
    resetSyncQueue();
    setUser(null);
    setAuthError(null);
  }, []);

  const clearError = useCallback(() => setAuthError(null), []);

  return (
    <AuthContext.Provider
      value={{ user, loading, authError, signIn, signUp, signOut, clearError }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
