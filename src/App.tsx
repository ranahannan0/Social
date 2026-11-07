import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { DashboardView } from './components/dashboard/DashboardView';
import { BrandWorkspaceView } from './components/brand/BrandWorkspaceView';
import { ContentStudioView } from './components/studio/ContentStudioView';
import { ContentLibraryView } from './components/library/ContentLibraryView';
import { ContentCalendarView } from './components/calendar/ContentCalendarView';
import { SettingsView } from './components/settings/SettingsView';

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
              <span>Phase 1 Foundation Active</span>
              <span aria-hidden="true">·</span>
              <span>Gemini 3.8 Flash SDK</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
