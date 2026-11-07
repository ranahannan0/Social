import React from 'react';
import { useApp } from '../../context/AppContext';
import {
  LayoutDashboard,
  Building2,
  Sparkles,
  Library,
  CalendarDays,
  Settings,
  X,
  Radio,
  Compass,
} from 'lucide-react';

interface SidebarProps {
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isMobileOpen, onCloseMobile }) => {
  const { activeSection, setActiveSection, stats } = useApp();

  const navItems = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: LayoutDashboard,
      badge: null,
    },
    {
      id: 'brand',
      label: 'Brand Workspace',
      icon: Building2,
      badge: stats.totalBrands > 0 ? `${stats.totalBrands}` : null,
    },
    {
      id: 'studio',
      label: 'Content Studio',
      icon: Sparkles,
      badge: null,
    },
    {
      id: 'library',
      label: 'Content Library',
      icon: Library,
      badge: stats.totalDrafts > 0 ? `${stats.totalDrafts}` : null,
    },
    {
      id: 'calendar',
      label: 'Content Calendar',
      icon: CalendarDays,
      badge: stats.scheduledCount > 0 ? `${stats.scheduledCount}` : null,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      badge: null,
    },
  ];

  const handleNavClick = (id: string) => {
    setActiveSection(id);
    onCloseMobile();
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isMobileOpen && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 bg-black/70 backdrop-blur-xs z-40 lg:hidden"
        />
      )}

      {/* Main Sidebar */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-64 bg-zinc-950 border-r border-zinc-800 flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Logo Header */}
        <div className="h-16 px-5 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center text-white shadow-xs">
              <Compass className="w-4 h-4" />
            </div>
            <div>
              <span className="text-sm font-bold tracking-tight text-zinc-100 flex items-center gap-1">
                OMNI CHANNEL <span className="text-emerald-400 font-extrabold">+</span>
              </span>
              <p className="text-[10px] text-zinc-500 font-medium tracking-wide">
                GROWTH ENGINE v2.0
              </p>
            </div>
          </div>

          <button
            onClick={onCloseMobile}
            className="lg:hidden p-1.5 text-zinc-400 hover:text-zinc-200 rounded-md"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation list */}
        <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <div className="px-3 pb-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
            Core Modules
          </div>

          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-zinc-800/90 text-zinc-100 shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 transition-colors ${
                      isActive ? 'text-emerald-400' : 'text-zinc-500'
                    }`}
                  />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                      isActive
                        ? 'bg-zinc-700 text-zinc-200'
                        : 'bg-zinc-900 text-zinc-500 border border-zinc-800/80'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Phase Roadmap Footer */}
        <div className="p-4 border-t border-zinc-800/80 bg-zinc-950/60">
          <div className="p-3 rounded-lg bg-zinc-900/70 border border-zinc-800 text-xs">
            <div className="flex items-center justify-between text-zinc-300 font-medium mb-1">
              <span className="flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                <span>Phase 1 Scope</span>
              </span>
              <span className="text-[10px] text-zinc-500 font-mono">MVP</span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-snug">
              Foundation, Brand Profiles, Studio & Calendar. Social publishing active in Phase 2.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
};
