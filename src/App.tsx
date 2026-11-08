import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { DashboardView } from './components/dashboard/DashboardView';
import { BrandWorkspaceView } from './components/brand/BrandWorkspaceView';
import { ContentStudioView } from './components/studio/ContentStudioView';
import { ContentLibraryView } from './components/library/ContentLibraryView';
import { ContentCalendarView } from './components/calendar/ContentCalendarView';
import { SettingsView } from './components/settings/SettingsView';
import { AuthScreen } from './components/auth/AuthScreen';
import { Loader2, Sparkles } from 'lucide-react';

const AppContent: React.FC = () => {
  const { activeSection } = useApp();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex font-sans antialiased selection:bg-emerald-500 selection:text-zinc-950">
      {/* Sidebar navigation */}
      <Sidebar
        isMobileOpen={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        {/* Top Header */}
        <Header onToggleMobileMenu={() => setIsMobileMenuOpen(prev => !prev)} />

        {/* Dynamic section viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeSection === 'dashboard' && <DashboardView />}
          {activeSection === 'brand' && <BrandWorkspaceView />}
          {activeSection === 'studio' && <ContentStudioView />}
          {activeSection === 'library' && <ContentLibraryView />}
          {activeSection === 'calendar' && <ContentCalendarView />}
          {activeSection === 'settings' && <SettingsView />}
        </main>

        {/* Quiet footer */}
        <footer className="border-t border-zinc-900 py-4 px-6 text-center text-xs text-zinc-400">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 max-w-7xl mx-auto">
            <span>OMNI CHANNEL PLUS v2.0 · Central AI Growth & Social Engine Core</span>
            <div className="flex items-center gap-3">
              <span>Phase 2 Cloud-Active</span>
              <span aria-hidden="true">·</span>
              {/* Model-agnostic label: the active Gemini model is env-configured
                  (GEMINI_MODEL) and must not be hardcoded in UI copy. */}
              <span>Server-side Gemini SDK</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

/**
 * Session gate: while the AuthProvider is booting (probing /api/auth/me), show
 * a branded splash. If there is no user, show the AuthScreen. Only when a user
 * is resolved do we mount AppProvider + AppContent — this guarantees
 * AppContext's hydration effect runs once with a known authed state.
 */
const SessionGate: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Loading workspace…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <SessionGate />
    </AuthProvider>
  );
}
