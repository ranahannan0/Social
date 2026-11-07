import React from 'react';
import { useApp } from '../../context/AppContext';
import { Sparkles, Layers, ChevronDown, Menu } from 'lucide-react';

interface HeaderProps {
  onToggleMobileMenu: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onToggleMobileMenu }) => {
  const {
    activeSection,
    setActiveSection,
    brands,
    activeBrandId,
    setActiveBrandId,
    activeBrand,
  } = useApp();

  const getSectionTitle = () => {
    switch (activeSection) {
      case 'dashboard':
        return 'Overview & Activity';
      case 'brand':
        return 'Brand Workspace';
      case 'studio':
        return 'AI Content Studio';
      case 'library':
        return 'Content Library';
      case 'calendar':
        return 'Content Calendar';
      case 'settings':
        return 'Settings & AI Engine';
      default:
        return 'Dashboard';
    }
  };

  return (
    <header className="h-16 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleMobileMenu}
          className="lg:hidden p-2 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-zinc-900 transition-colors"
          aria-label="Toggle navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div>
          <h1 className="text-sm sm:text-base font-semibold text-zinc-100 flex items-center gap-2">
            <span>{getSectionTitle()}</span>
          </h1>
          <div className="flex items-center gap-2 text-xs text-zinc-500 hidden sm:flex">
            <span>Active Brand: {activeBrand?.name || 'Default'}</span>
            <span aria-hidden="true">·</span>
            <span>{activeBrand?.preferredLanguage || 'English'}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Brand Switcher Selector */}
        <div className="relative">
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg px-2.5 py-1.5 transition-colors">
            <Layers className="w-3.5 h-3.5 text-zinc-400" />
            <select
              value={activeBrandId}
              onChange={e => setActiveBrandId(e.target.value)}
              className="bg-transparent text-xs font-medium text-zinc-200 focus:outline-hidden cursor-pointer pr-4 appearance-none"
              aria-label="Select active brand workspace"
            >
              {brands.map(b => (
                <option key={b.id} value={b.id} className="bg-zinc-900 text-zinc-200">
                  {b.name}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-zinc-500 pointer-events-none absolute right-2.5" />
          </div>
        </div>

        {/* Phase 1 indicator */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-400 border border-zinc-800/80 rounded-md bg-zinc-900/40">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>Phase 1 Core</span>
        </div>

        {/* Quick studio action */}
        {activeSection !== 'studio' && (
          <button
            onClick={() => setActiveSection('studio')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 font-medium text-xs rounded-lg shadow-xs transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New Content</span>
          </button>
        )}
      </div>
    </header>
  );
};
