/**
 * Auth screen (Phase 2 frontend cutover).
 *
 * Single-page login/signup card matching the app's existing dark zinc theme.
 * Toggles between "Sign In" and "Create Account" modes. Surfaces server error
 * messages verbatim (e.g. "Email already registered", "Password must be at
 * least 8 characters").
 *
 * On a successful signup that requires email confirmation, shows a notice and
 * switches the user back to the sign-in tab so they can complete the flow
 * after confirming.
 */

import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AuthError } from '../../services/authClient';
import { Sparkles, Loader2, AlertCircle, Mail, Lock, ArrowRight, ArrowLeft } from 'lucide-react';

type Mode = 'signin' | 'signup';

export const AuthScreen: React.FC = () => {
  const { signIn, signUp, authError, clearError } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [infoNotice, setInfoNotice] = useState<string | null>(null);

  const error = localError || authError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setInfoNotice(null);
    clearError();

    if (!email.trim() || !password) {
      setLocalError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const result = await signUp(email.trim(), password);
        if (result.requiresEmailConfirmation) {
          setInfoNotice('Account created. Please check your inbox to confirm your email, then sign in.');
          setMode('signin');
          setPassword('');
        }
      }
    } catch (err) {
      // error already surfaced via AuthContext.authError or AuthError.message
      if (!(err instanceof AuthError)) {
        setLocalError('Network error. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode(m => (m === 'signin' ? 'signup' : 'signin'));
    setLocalError(null);
    setInfoNotice(null);
    clearError();
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-8 font-sans antialiased">
      <div className="w-full max-w-md">
        {/* Brand header */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
            <Sparkles className="w-6 h-6 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">OMNI CHANNEL PLUS</h1>
          <p className="text-sm text-zinc-500 mt-1">AI-driven multi-brand marketing OS</p>
        </div>

        {/* Card */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold">
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </h2>
            <button
              type="button"
              onClick={switchMode}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1"
            >
              {mode === 'signin' ? (
                <>Sign up <ArrowRight className="w-3 h-3" /></>
              ) : (
                <><ArrowLeft className="w-3 h-3" /> Sign in</>
              )}
            </button>
          </div>

          {infoNotice && (
            <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{infoNotice}</span>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-zinc-950/60 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 disabled:opacity-50"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="auth-password"
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-zinc-950/60 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 disabled:opacity-50"
                  placeholder={mode === 'signin' ? 'Your password' : 'At least 8 characters'}
                  required
                  minLength={mode === 'signup' ? 8 : undefined}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-zinc-800">
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              {mode === 'signin' ? (
                <>Don't have an account?{' '}
                  <button type="button" onClick={switchMode} className="text-emerald-400 hover:text-emerald-300">
                    Create one
                  </button>
                </>
              ) : (
                <>Already have an account?{' '}
                  <button type="button" onClick={switchMode} className="text-emerald-400 hover:text-emerald-300">
                    Sign in
                  </button>
                </>
              )}
            </p>
          </div>
        </div>

        <p className="text-center text-[11px] text-zinc-700 mt-6">
          Your data is encrypted at rest and isolated per account.
        </p>
      </div>
    </div>
  );
};
