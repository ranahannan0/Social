import React from 'react';
import { useApp } from '../../context/AppContext';
import {
  Sparkles,
  Calendar,
  Building2,
  CheckCircle2,
  ArrowRight,
  TrendingUp,
  Clock,
  ShieldCheck,
  Plus,
} from 'lucide-react';
import { PlatformIcon } from '../common/PlatformIcon';
import { PLATFORMS_CONFIG } from '../../services/constants';

export const DashboardView: React.FC = () => {
  const { setActiveSection, stats, drafts, calendarEvents, activeBrand, brands } = useApp();

  // Get 4 most recent drafts
  const recentDrafts = drafts.slice(0, 4);

  // Get upcoming 3 calendar events
  const upcomingEvents = calendarEvents.slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Top Banner / Hero */}
      <div className="relative overflow-hidden rounded-xl border border-zinc-800 bg-gradient-to-r from-zinc-900 via-zinc-900 to-zinc-950 p-6">
        <div className="max-w-2xl space-y-2">
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold tracking-wide uppercase">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Omni Channel Plus · Phase 1 Architecture</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-100">
            Welcome to the AI Growth & Social Engine
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Generate platform-native content, enforce authentic brand voice without AI fluff phrases, and manage omnichannel scheduling from a single unified hub.
          </p>
        </div>

        {/* Quick Launch Buttons */}
        <div className="mt-5 flex flex-wrap gap-2.5">
          <button
            onClick={() => setActiveSection('studio')}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Generate Content</span>
          </button>
          <button
            onClick={() => setActiveSection('brand')}
            className="flex items-center gap-2 px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700/80 transition-colors"
          >
            <Building2 className="w-3.5 h-3.5 text-zinc-400" />
            <span>Manage Brand Profiles</span>
          </button>
          <button
            onClick={() => setActiveSection('calendar')}
            className="flex items-center gap-2 px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700/80 transition-colors"
          >
            <Calendar className="w-3.5 h-3.5 text-zinc-400" />
            <span>View Calendar</span>
          </button>
        </div>
      </div>

      {/* Content Statistics Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 space-y-1">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Total Content Drafts</span>
            <TrendingUp className="w-4 h-4 text-zinc-500" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{stats.totalDrafts}</div>
          <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
            <span>{stats.readyDrafts} ready for publication</span>
          </div>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 space-y-1">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Scheduled Campaigns</span>
            <Calendar className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{stats.scheduledCount}</div>
          <div className="text-[11px] text-zinc-500">Active in calendar queue</div>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 space-y-1">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Compliance Pass Rate</span>
            <ShieldCheck className="w-4 h-4 text-teal-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{stats.compliancePassRate}%</div>
          <div className="text-[11px] text-zinc-500">Zero AI fluff phrase score</div>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 space-y-1">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Brand Workspaces</span>
            <Building2 className="w-4 h-4 text-zinc-500" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{stats.totalBrands}</div>
          <div className="text-[11px] text-zinc-500">
            Active: <span className="text-zinc-300 font-medium">{activeBrand?.name || 'Default'}</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Recent Projects + Platform Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 cols): Recent Projects */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">Recent Content Projects</h3>
              <p className="text-xs text-zinc-500">Latest generated captions and hook variations</p>
            </div>
            <button
              onClick={() => setActiveSection('library')}
              className="text-xs text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 transition-colors"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {recentDrafts.length === 0 ? (
              <div className="p-8 text-center bg-zinc-900/50 border border-zinc-800 rounded-xl text-zinc-500 text-xs">
                No content generated yet. Click "Generate Content" to start your first campaign.
              </div>
            ) : (
              recentDrafts.map(draft => {
                const brand = brands.find(b => b.id === draft.brandId);
                const platformMeta = PLATFORMS_CONFIG[draft.platform];

                return (
                  <div
                    key={draft.id}
                    className="p-4 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl transition-all space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <div className="p-2 bg-zinc-800 text-zinc-200 rounded-lg">
                          <PlatformIcon platform={draft.platform} className="w-4 h-4 text-emerald-400" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-zinc-100 leading-snug line-clamp-1">
                            {draft.title}
                          </h4>
                          <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                            <span>{platformMeta?.label || draft.platform}</span>
                            <span aria-hidden="true">·</span>
                            <span>{brand?.name || 'Omni'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{draft.language}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-medium px-2 py-0.5 rounded-md ${
                            draft.status === 'scheduled'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                              : draft.status === 'ready'
                              ? 'bg-teal-950 text-teal-400 border border-teal-800/60'
                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700/60'
                          }`}
                        >
                          {draft.status.toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/60">
                      {draft.caption}
                    </p>

                    <div className="flex items-center justify-between text-xs text-zinc-500 pt-1">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-zinc-600" />
                        <span>Created {new Date(draft.createdAt).toLocaleDateString()}</span>
                      </span>

                      <button
                        onClick={() => setActiveSection('library')}
                        className="text-xs text-zinc-400 hover:text-zinc-200 font-medium"
                      >
                        Inspect in Library →
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Platform Breakdown & Upcoming Schedule */}
        <div className="space-y-6">
          {/* Upcoming Schedule Widget */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-emerald-400" />
                <span>Upcoming Calendar</span>
              </h3>
              <button
                onClick={() => setActiveSection('calendar')}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                Calendar →
              </button>
            </div>

            <div className="space-y-2">
              {upcomingEvents.length === 0 ? (
                <p className="text-xs text-zinc-500 py-3">No upcoming events scheduled.</p>
              ) : (
                upcomingEvents.map(evt => (
                  <div
                    key={evt.id}
                    className="p-2.5 bg-zinc-950/80 rounded-lg border border-zinc-800/80 space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-200 truncate pr-2">{evt.title}</span>
                      <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                        {evt.date} · {evt.time}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                      <PlatformIcon platform={evt.platform} className="w-3 h-3 text-zinc-400" />
                      <span className="capitalize">{evt.platform.replace('_', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{evt.status}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Platform Distribution Bar */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-100">Platform Coverage</h3>
            <p className="text-xs text-zinc-500">Drafts generated across supported channels</p>

            <div className="space-y-2 pt-1">
              {[
                { key: 'linkedin', label: 'LinkedIn', color: 'bg-blue-500' },
                { key: 'instagram_reels', label: 'Instagram Reels', color: 'bg-pink-500' },
                { key: 'x', label: 'X (Twitter)', color: 'bg-zinc-300' },
                { key: 'email', label: 'Email Newsletter', color: 'bg-emerald-500' },
                { key: 'youtube', label: 'YouTube', color: 'bg-red-500' },
              ].map(p => {
                const count = stats.platformBreakdown[p.key as keyof typeof stats.platformBreakdown] || 0;
                const percent = stats.totalDrafts > 0 ? Math.round((count / stats.totalDrafts) * 100) : 0;

                return (
                  <div key={p.key} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-300">{p.label}</span>
                      <span className="text-zinc-500 font-mono">{count} ({percent}%)</span>
                    </div>
                    <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${p.color}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
