import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { BrandProfile, SupportedLanguage, ProductOrService } from '../../types';
import {
  Building2,
  Plus,
  Trash2,
  Save,
  Globe,
  MessageSquare,
  Package,
  Check,
  AlertCircle,
  Sparkles,
} from 'lucide-react';

const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'English',
  'Roman Urdu',
  'Urdu (Script)',
  'Hindi',
  'Spanish',
  'Arabic',
];

export const BrandWorkspaceView: React.FC = () => {
  const {
    brands,
    activeBrandId,
    setActiveBrandId,
    addBrand,
    updateBrand,
    deleteBrand,
    setActiveSection,
    drafts,
    calendarEvents,
    canWrite,
  } = useApp();

  const activeBrand = brands.find(b => b.id === activeBrandId) || brands[0];

  // Local form state synced with activeBrand
  const [formData, setFormData] = useState<BrandProfile>(activeBrand);
  const [newBannedWord, setNewBannedWord] = useState('');
  const [newProduct, setNewProduct] = useState<ProductOrService>({
    id: '',
    name: '',
    description: '',
    tierOrPrice: '',
  });
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);

  // Associated records for current brand to prevent orphaned data
  const associatedDraftsCount = drafts.filter(d => d.brandId === formData.id).length;
  const associatedEventsCount = calendarEvents.filter(e => e.brandId === formData.id).length;

  // When activeBrandId changes, sync formData
  React.useEffect(() => {
    if (activeBrand) {
      setFormData(activeBrand);
      setIsCreatingNew(false);
      setIsConfirmingDelete(false);
      setDeleteWarning(null);
    }
  }, [activeBrandId, activeBrand]);

  const handleStartCreateNew = () => {
    if (!canWrite) return; // P3.3: viewer role — RLS would reject the POST anyway
    const blankBrand: BrandProfile = {
      id: `temp-${Date.now()}`,
      name: 'New Brand Space',
      tagline: 'Brand positioning tagline',
      industry: 'Technology / Consumer',
      website: 'https://',
      targetAudience: 'Target customer personas, demographics, and purchasing motives.',
      brandVoice: {
        tone: 'Professional, direct, clear, authoritative',
        bannedWords: ['synergy', 'game-changing', 'disruptive'],
        styleGuidelines: 'State value propositions first without flowery introductions.',
        sampleCopy: 'Write sample approved copy that models your ideal tone.',
      },
      preferredLanguage: 'English',
      productsAndServices: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setFormData(blankBrand);
    setIsCreatingNew(true);
    setIsConfirmingDelete(false);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    if (isCreatingNew) {
      const created = addBrand({
        name: formData.name,
        tagline: formData.tagline,
        industry: formData.industry,
        website: formData.website,
        targetAudience: formData.targetAudience,
        brandVoice: formData.brandVoice,
        preferredLanguage: formData.preferredLanguage,
        productsAndServices: formData.productsAndServices,
      });
      setIsCreatingNew(false);
      setActiveBrandId(created.id);
    } else {
      updateBrand(formData);
    }

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  const initiateDelete = () => {
    if (brands.length <= 1) {
      setDeleteWarning('You must maintain at least one brand workspace profile in the system.');
      setTimeout(() => setDeleteWarning(null), 3000);
      return;
    }
    setIsConfirmingDelete(true);
  };

  const confirmDelete = () => {
    deleteBrand(formData.id);
    setIsConfirmingDelete(false);
  };

  const handleAddBannedWord = () => {
    if (!newBannedWord.trim()) return;
    const word = newBannedWord.trim().toLowerCase();
    if (!formData.brandVoice.bannedWords.includes(word)) {
      setFormData(prev => ({
        ...prev,
        brandVoice: {
          ...prev.brandVoice,
          bannedWords: [...prev.brandVoice.bannedWords, word],
        },
      }));
    }
    setNewBannedWord('');
  };

  const handleRemoveBannedWord = (wordToRemove: string) => {
    setFormData(prev => ({
      ...prev,
      brandVoice: {
        ...prev.brandVoice,
        bannedWords: prev.brandVoice.bannedWords.filter(w => w !== wordToRemove),
      },
    }));
  };

  const handleAddProduct = () => {
    if (!newProduct.name.trim()) return;
    const prod: ProductOrService = {
      id: `prod-${Date.now()}`,
      name: newProduct.name.trim(),
      description: newProduct.description.trim(),
      tierOrPrice: newProduct.tierOrPrice?.trim() || undefined,
    };
    setFormData(prev => ({
      ...prev,
      productsAndServices: [...prev.productsAndServices, prod],
    }));
    setNewProduct({ id: '', name: '', description: '', tierOrPrice: '' });
  };

  const handleRemoveProduct = (prodId: string) => {
    setFormData(prev => ({
      ...prev,
      productsAndServices: prev.productsAndServices.filter(p => p.id !== prodId),
    }));
  };

  return (
    <div className="space-y-6">
      {/* Brand Profile Selector Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-900 border border-zinc-800 rounded-xl p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-emerald-400" />
            <span>Brand Memory & Positioning Architecture</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            The Content Studio and AI agents inject these parameters into every generation step.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Brand pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-md">
            {brands.map(b => (
              <button
                key={b.id}
                onClick={() => {
                  setActiveBrandId(b.id);
                  setIsCreatingNew(false);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  b.id === activeBrandId && !isCreatingNew
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>

          <button
            onClick={handleStartCreateNew}
            disabled={!canWrite}
            title={canWrite ? undefined : 'Viewer role — this workspace is read-only'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
              isCreatingNew
                ? 'bg-emerald-600 text-white'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Brand</span>
          </button>
        </div>
      </div>

      {/* Main Brand Form */}
      <form onSubmit={handleSave} className="space-y-6">
        {/* Section 1: Business Information */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">1. Business Information</h3>
              <p className="text-xs text-zinc-500">Core company profile and market identity</p>
            </div>
            {isCreatingNew && (
              <span className="text-[11px] font-medium text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded-md border border-emerald-800/80">
                Drafting New Brand Profile
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Brand Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Apex Cloud Systems"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Industry Vertical</label>
              <input
                type="text"
                value={formData.industry}
                onChange={e => setFormData({ ...formData, industry: e.target.value })}
                placeholder="e.g. B2B Enterprise SaaS / Fintech"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Tagline or Positioning</label>
              <input
                type="text"
                value={formData.tagline}
                onChange={e => setFormData({ ...formData, tagline: e.target.value })}
                placeholder="e.g. Autonomous cloud infrastructure without DevOps sprawl"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Website URL</label>
              <input
                type="url"
                value={formData.website || ''}
                onChange={e => setFormData({ ...formData, website: e.target.value })}
                placeholder="https://company.com"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Target Audience & Preferred Language */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3">
            <h3 className="text-sm font-semibold text-zinc-100">2. Target Audience & Regional Localization</h3>
            <p className="text-xs text-zinc-500">Audience persona and primary language targeting</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Target Audience Persona & Pain Points
              </label>
              <textarea
                rows={3}
                value={formData.targetAudience}
                onChange={e => setFormData({ ...formData, targetAudience: e.target.value })}
                placeholder="Describe key titles, demographics, frustrations, and buying catalysts..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-zinc-400" />
                <span>Preferred Language</span>
              </label>
              <select
                value={formData.preferredLanguage}
                onChange={e =>
                  setFormData({ ...formData, preferredLanguage: e.target.value as SupportedLanguage })
                }
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 cursor-pointer"
              >
                {SUPPORTED_LANGUAGES.map(lang => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
                Notice: Roman Urdu and Urdu script are treated as first-class primary languages per Omni Channel Plus spec.
              </p>
            </div>
          </div>
        </div>

        {/* Section 3: Brand Voice Architecture */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3">
            <h3 className="text-sm font-semibold text-zinc-100">3. Brand Voice Architecture</h3>
            <p className="text-xs text-zinc-500">Tone rules, banned words, and few-shot memory copy</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Tone Descriptors & Attitude
              </label>
              <input
                type="text"
                value={formData.brandVoice.tone}
                onChange={e =>
                  setFormData({
                    ...formData,
                    brandVoice: { ...formData.brandVoice, tone: e.target.value },
                  })
                }
                placeholder="e.g. Direct, authoritative, analytical, conversational, empathetic"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            {/* Banned Words Manager */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Brand-Specific Banned Words & Clichés
              </label>
              <p className="text-[11px] text-zinc-500 mb-2">
                Words your brand never uses (in addition to global AI fluff rules like "delve into" or "tapestry").
              </p>

              <div className="flex gap-2 mb-2.5">
                <input
                  type="text"
                  value={newBannedWord}
                  onChange={e => setNewBannedWord(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddBannedWord();
                    }
                  }}
                  placeholder="Type word to ban and hit Enter (e.g. synergy, cheap)"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={handleAddBannedWord}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700"
                >
                  Add Word
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {formData.brandVoice.bannedWords.map(word => (
                  <span
                    key={word}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-300 text-xs font-mono"
                  >
                    <span>{word}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveBannedWord(word)}
                      className="hover:text-red-100"
                      aria-label={`Remove banned word ${word}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Style Guidelines
                </label>
                <textarea
                  rows={3}
                  value={formData.brandVoice.styleGuidelines}
                  onChange={e =>
                    setFormData({
                      ...formData,
                      brandVoice: { ...formData.brandVoice, styleGuidelines: e.target.value },
                    })
                  }
                  placeholder="e.g. Use short sentences. Avoid bullet lists exceeding 4 items. Lead with data."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Approved Sample Copy (RAG Voice Anchor)
                </label>
                <textarea
                  rows={3}
                  value={formData.brandVoice.sampleCopy}
                  onChange={e =>
                    setFormData({
                      ...formData,
                      brandVoice: { ...formData.brandVoice, sampleCopy: e.target.value },
                    })
                  }
                  placeholder="Paste a previously approved post or excerpt that captures the exact brand voice."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 resize-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Section 4: Products & Services */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">4. Products & Services Catalog</h3>
              <p className="text-xs text-zinc-500">Offerings that the studio can reference in CTAs and campaign copies</p>
            </div>
            <span className="text-xs text-zinc-400">
              {formData.productsAndServices.length} items
            </span>
          </div>

          {/* Add product mini-form */}
          <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
            <div className="sm:col-span-4">
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">Product / Offering Name</label>
              <input
                type="text"
                value={newProduct.name}
                onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
                placeholder="e.g. Cloud Sentinel"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>
            <div className="sm:col-span-5">
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">Description / Core Benefit</label>
              <input
                type="text"
                value={newProduct.description}
                onChange={e => setNewProduct({ ...newProduct, description: e.target.value })}
                placeholder="e.g. Real-time multi-cloud billing detector"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">Pricing / Tier</label>
              <input
                type="text"
                value={newProduct.tierOrPrice || ''}
                onChange={e => setNewProduct({ ...newProduct, tierOrPrice: e.target.value })}
                placeholder="$499/mo"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>
            <div className="sm:col-span-1">
              <button
                type="button"
                onClick={handleAddProduct}
                className="w-full h-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md text-xs font-medium border border-zinc-700"
                title="Add product"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Product list */}
          <div className="space-y-2">
            {formData.productsAndServices.length === 0 ? (
              <p className="text-xs text-zinc-500 py-2">No products added yet.</p>
            ) : (
              formData.productsAndServices.map(p => (
                <div
                  key={p.id}
                  className="flex items-center justify-between p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-lg text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-200">{p.name}</span>
                      {p.tierOrPrice && (
                        <span className="text-[11px] text-emerald-400 font-mono">
                          {p.tierOrPrice}
                        </span>
                      )}
                    </div>
                    <p className="text-zinc-400">{p.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveProduct(p.id)}
                    className="p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-colors"
                    title="Delete product"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Action Bar */}
        <div className="flex items-center justify-between p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
          <div className="flex items-center gap-3">
            {!isCreatingNew && brands.length > 1 && (
              <button
                type="button"
                onClick={initiateDelete}
                className="flex items-center gap-1.5 px-3 py-2 text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded-lg text-xs font-medium transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Brand Profile</span>
              </button>
            )}
            {deleteWarning && (
              <span className="text-xs text-amber-400 flex items-center gap-1.5 animate-in fade-in">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{deleteWarning}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {saveSuccess && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 animate-in fade-in">
                <Check className="w-4 h-4" />
                <span>Profile Saved</span>
              </span>
            )}

            <button
              type="button"
              onClick={() => setActiveSection('studio')}
              className="px-3.5 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
            >
              Go to Studio →
            </button>

            <button
              type="submit"
              className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isCreatingNew ? 'Create Brand Profile' : 'Save Brand Profile'}</span>
            </button>
          </div>
        </div>
      </form>

      {/* Confirmation Modal for Brand Deletion */}
      {isConfirmingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 text-red-400 border-b border-zinc-800 pb-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Confirm Brand Deletion
              </h3>
            </div>

            <div className="space-y-3 text-xs text-zinc-300">
              <p>
                Are you sure you want to delete <span className="font-semibold text-zinc-100">"{formData.name}"</span>?
              </p>
              <div className="p-3 bg-red-950/30 border border-red-900/50 rounded-lg space-y-1.5 text-zinc-400">
                <span className="font-semibold text-red-300 block">
                  Cascading Cleanup & Data Integrity Notice:
                </span>
                <p>
                  To prevent orphaned records, this deletion will permanently purge:
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-zinc-300 pl-1">
                  <li>
                    <span className="font-semibold text-zinc-100">{associatedDraftsCount}</span> associated content draft(s)
                  </li>
                  <li>
                    <span className="font-semibold text-zinc-100">{associatedEventsCount}</span> scheduled calendar campaign(s)
                  </li>
                </ul>
                <p className="text-[11px] text-zinc-500 pt-1">
                  The active brand will automatically be reassigned to your remaining workspace profile.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setIsConfirmingDelete(false)}
                className="px-3.5 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold shadow-xs"
              >
                Delete Brand & Associated Records
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
