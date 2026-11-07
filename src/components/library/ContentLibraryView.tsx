import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ContentDraft, PlatformType, ContentStatus } from '../../types';
import { PLATFORMS_CONFIG } from '../../services/constants';
import { PlatformIcon } from '../common/PlatformIcon';
import { ScheduleModal } from '../common/ScheduleModal';
import {
  Library,
  Search,
  Filter,
  Calendar,
  Edit3,
  Trash2,
  Copy,
  Download,
  Check,
  X,
  FileCode,
  FileText,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';

export const ContentLibraryView: React.FC = () => {
  const {
    drafts,
    updateDraft,
    deleteDraft,
    brands,
    activeBrandId,
    setActiveSection,
  } = useApp();

  // Filters
  const [selectedBrandFilter, setSelectedBrandFilter] = useState<string>('all');
  const [selectedPlatformFilter, setSelectedPlatformFilter] = useState<string>('all');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Editing state
  const [editingDraft, setEditingDraft] = useState<ContentDraft | null>(null);
  const [schedulingDraft, setSchedulingDraft] = useState<ContentDraft | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Filter application
  const filteredDrafts = drafts.filter(draft => {
    if (selectedBrandFilter !== 'all' && draft.brandId !== selectedBrandFilter) {
      return false;
    }
    if (selectedPlatformFilter !== 'all' && draft.platform !== selectedPlatformFilter) {
      return false;
    }
    if (selectedStatusFilter !== 'all' && draft.status !== selectedStatusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = draft.title.toLowerCase().includes(q);
      const matchTopic = draft.topic.toLowerCase().includes(q);
      const matchCaption = draft.caption.toLowerCase().includes(q);
      if (!matchTitle && !matchTopic && !matchCaption) return false;
    }
    return true;
  });

  const handleCopy = (draft: ContentDraft) => {
    const text = `${draft.caption}\n\n${draft.callToAction}\n\n${draft.hashtags.map(t => `#${t}`).join(' ')}`;
    navigator.clipboard.writeText(text);
    setCopyFeedback(draft.id);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const handleExportJSON = (draft: ContentDraft) => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(draft, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `${draft.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleExportMarkdown = (draft: ContentDraft) => {
    const md = `# ${draft.title}
**Platform:** ${PLATFORMS_CONFIG[draft.platform]?.label || draft.platform}
**Objective:** ${draft.objective}
**Status:** ${draft.status}

## Caption
${draft.caption}

## CTA
${draft.callToAction}

## Hashtags
${draft.hashtags.map(t => `#${t}`).join(' ')}

## Hook Variations
- **Pattern Interrupt:** ${draft.hooks.patternInterrupt}
- **Curiosity Gap:** ${draft.hooks.curiosityGap}
- **Direct Benefit:** ${draft.hooks.directBenefit}
`;
    const dataStr = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `${draft.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}.md`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDraft) return;
    updateDraft(editingDraft);
    setEditingDraft(null);
  };

  return (
    <div className="space-y-6">
      {/* Header and Filter Bar */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <Library className="w-4 h-4 text-emerald-400" />
              <span>Omni-Channel Content Library</span>
            </h2>
            <p className="text-xs text-zinc-400">
              Manage saved drafts, edit captions, and schedule cross-platform campaigns.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveSection('studio')}
              className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
            >
              + Create New Content
            </button>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-zinc-800">
          {/* Search bar */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-3 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search topic or copy..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
            />
          </div>

          {/* Brand Filter */}
          <div>
            <select
              value={selectedBrandFilter}
              onChange={e => setSelectedBrandFilter(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-hidden focus:border-emerald-500"
            >
              <option value="all">All Brand Spaces</option>
              {brands.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {/* Platform Filter */}
          <div>
            <select
              value={selectedPlatformFilter}
              onChange={e => setSelectedPlatformFilter(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-hidden focus:border-emerald-500"
            >
              <option value="all">All Platforms</option>
              {Object.values(PLATFORMS_CONFIG).map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={selectedStatusFilter}
              onChange={e => setSelectedStatusFilter(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-hidden focus:border-emerald-500"
            >
              <option value="all">All Statuses</option>
              <option value="draft">Drafts Only</option>
              <option value="ready">Ready for Publishing</option>
              <option value="scheduled">Scheduled in Calendar</option>
            </select>
          </div>
        </div>
      </div>

      {/* Drafts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredDrafts.length === 0 ? (
          <div className="md:col-span-2 p-12 text-center bg-zinc-900/40 border border-zinc-800 rounded-xl space-y-2">
            <Library className="w-8 h-8 text-zinc-600 mx-auto" />
            <p className="text-sm font-medium text-zinc-300">No content matches your filters</p>
            <p className="text-xs text-zinc-500">
              Clear filters or generate new content from the Studio.
            </p>
          </div>
        ) : (
          filteredDrafts.map(draft => {
            const brand = brands.find(b => b.id === draft.brandId);
            const platformMeta = PLATFORMS_CONFIG[draft.platform];

            return (
              <div
                key={draft.id}
                className="bg-zinc-900 border border-zinc-800 hover:border-zinc-700/80 rounded-xl p-5 flex flex-col justify-between transition-colors space-y-4"
              >
                {/* Header line */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="p-2 bg-zinc-800 rounded-lg text-emerald-400">
                        <PlatformIcon platform={draft.platform} className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-100 line-clamp-1">
                          {draft.title}
                        </h3>
                        <div className="flex items-center gap-2 text-xs text-zinc-500">
                          <span>{platformMeta?.label || draft.platform}</span>
                          <span aria-hidden="true">·</span>
                          <span>{brand?.name || 'Omni'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{draft.language}</span>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                        draft.status === 'scheduled'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/80'
                          : draft.status === 'ready'
                          ? 'bg-teal-950 text-teal-400 border border-teal-800/80'
                          : 'bg-zinc-800 text-zinc-400 border border-zinc-700/80'
                      }`}
                    >
                      {draft.status.toUpperCase()}
                    </span>
                  </div>

                  {/* Body Preview */}
                  <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800/80 space-y-2 text-xs">
                    <p className="text-zinc-300 line-clamp-3 leading-relaxed">
                      {draft.caption}
                    </p>

                    {draft.callToAction && (
                      <p className="text-emerald-400/90 font-medium truncate">
                        CTA: {draft.callToAction}
                      </p>
                    )}

                    {draft.hashtags.length > 0 && (
                      <div className="flex flex-wrap gap-1 text-[11px] text-zinc-500 font-mono">
                        {draft.hashtags.slice(0, 4).map(t => (
                          <span key={t}>#{t}</span>
                        ))}
                        {draft.hashtags.length > 4 && <span>+{draft.hashtags.length - 4}</span>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer Controls */}
                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleCopy(draft)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded-md hover:bg-zinc-800 transition-colors"
                      title="Copy full post"
                    >
                      {copyFeedback === draft.id ? (
                        <Check className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => handleExportMarkdown(draft)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded-md hover:bg-zinc-800 transition-colors"
                      title="Export Markdown"
                    >
                      <FileText className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleExportJSON(draft)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded-md hover:bg-zinc-800 transition-colors"
                      title="Export JSON"
                    >
                      <FileCode className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete draft "${draft.title}"?`)) {
                          deleteDraft(draft.id);
                        }
                      }}
                      className="p-1.5 text-zinc-500 hover:text-red-400 rounded-md hover:bg-zinc-800 transition-colors"
                      title="Delete draft"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditingDraft(draft)}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition-colors"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      onClick={() => setSchedulingDraft(draft)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Schedule</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Edit Draft Modal */}
      {editingDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2 text-zinc-100 font-semibold text-sm">
                <Edit3 className="w-4 h-4 text-emerald-400" />
                <span>Edit Content Project</span>
              </div>
              <button
                onClick={() => setEditingDraft(null)}
                className="text-zinc-400 hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="p-5 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={editingDraft.title}
                  onChange={e => setEditingDraft({ ...editingDraft, title: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Body Caption</label>
                <textarea
                  rows={6}
                  required
                  value={editingDraft.caption}
                  onChange={e => setEditingDraft({ ...editingDraft, caption: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs sm:text-sm text-zinc-100 leading-relaxed focus:outline-hidden focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Call to Action (CTA)</label>
                <input
                  type="text"
                  value={editingDraft.callToAction}
                  onChange={e => setEditingDraft({ ...editingDraft, callToAction: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Status</label>
                  <select
                    value={editingDraft.status}
                    onChange={e =>
                      setEditingDraft({ ...editingDraft, status: e.target.value as ContentStatus })
                    }
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  >
                    <option value="draft">Draft</option>
                    <option value="ready">Ready</option>
                    <option value="scheduled">Scheduled</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Platform</label>
                  <select
                    value={editingDraft.platform}
                    onChange={e =>
                      setEditingDraft({ ...editingDraft, platform: e.target.value as PlatformType })
                    }
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  >
                    {Object.values(PLATFORMS_CONFIG).map(p => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setEditingDraft(null)}
                  className="px-3.5 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {schedulingDraft && (
        <ScheduleModal
          draft={schedulingDraft}
          isOpen={Boolean(schedulingDraft)}
          onClose={() => setSchedulingDraft(null)}
          onScheduledSuccess={() => {
            setSchedulingDraft(null);
            setActiveSection('calendar');
          }}
        />
      )}
    </div>
  );
};
