import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import {
  PlatformType,
  MarketingObjective,
  SupportedLanguage,
  HookType,
  ContentDraft,
} from '../../types';
import { PLATFORMS_CONFIG } from '../../services/constants';
import { PlatformIcon } from '../common/PlatformIcon';
import { apiService } from '../../services/api';
import { runComplianceCheck } from '../../services/compliance';
import { ScheduleModal } from '../common/ScheduleModal';
import {
  Sparkles,
  RefreshCw,
  Bookmark,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Zap,
  Info,
  Maximize2,
  SlidersHorizontal,
} from 'lucide-react';

const OBJECTIVES: MarketingObjective[] = [
  'Awareness',
  'Lead Gen',
  'Authority',
  'Sales',
  'Engagement',
];

const LANGUAGES: SupportedLanguage[] = [
  'English',
  'Roman Urdu',
  'Urdu (Script)',
  'Hindi',
  'Spanish',
  'Arabic',
];

export const ContentStudioView: React.FC = () => {
  const { activeBrand, saveDraft, setActiveSection, settings } = useApp();

  // Generator inputs
  const [topic, setTopic] = useState('');
  const [platform, setPlatform] = useState<PlatformType>('linkedin');
  const [objective, setObjective] = useState<MarketingObjective>('Authority');
  const [language, setLanguage] = useState<SupportedLanguage>(
    activeBrand?.preferredLanguage || 'English'
  );
  const [audience, setAudience] = useState(activeBrand?.targetAudience || '');
  const [customInstructions, setCustomInstructions] = useState('');

  // Generation execution state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationSource, setGenerationSource] = useState<string | null>(null);

  // Generated & Editable state
  const [projectTitle, setProjectTitle] = useState('');
  const [hooks, setHooks] = useState({
    patternInterrupt: '',
    curiosityGap: '',
    directBenefit: '',
  });
  const [selectedHookType, setSelectedHookType] = useState<HookType>('patternInterrupt');
  const [caption, setCaption] = useState('');
  const [callToAction, setCallToAction] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [hashtagInput, setHashtagInput] = useState('');
  const [visualDirection, setVisualDirection] = useState('');
  const [keyTakeaways, setKeyTakeaways] = useState<string[]>([]);

  // Feedback states
  const [savedDraft, setSavedDraft] = useState<ContentDraft | null>(null);
  const [copied, setCopied] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  const [generationNote, setGenerationNote] = useState<string | null>(null);

  // Sync brand defaults when active brand changes
  useEffect(() => {
    if (activeBrand) {
      setAudience(activeBrand.targetAudience);
      setLanguage(activeBrand.preferredLanguage);
    }
  }, [activeBrand]);

  // Real-time compliance check on current caption
  const compliance = runComplianceCheck(caption, platform);
  const currentPlatformMeta = PLATFORMS_CONFIG[platform];

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!topic.trim()) {
      setGenerationError('Please enter a topic or seed keyword.');
      return;
    }

    setIsGenerating(true);
    setGenerationError(null);
    setSavedDraft(null);

    try {
      const res = await apiService.generateContent({
        topic: topic.trim(),
        platform,
        audience,
        objective,
        language,
        brandName: activeBrand?.name || 'OmniBrand',
        brandVoice: {
          tone: activeBrand?.brandVoice.tone,
          bannedWords: activeBrand?.brandVoice.bannedWords,
          styleGuidelines: activeBrand?.brandVoice.styleGuidelines,
        },
        customInstructions,
      });

      if (res.success && res.data) {
        const genTitle = res.data.title || `${topic} - ${platform.toUpperCase()}`;
        const genHooks = {
          patternInterrupt: res.data.hooks.patternInterrupt,
          curiosityGap: res.data.hooks.curiosityGap,
          directBenefit: res.data.hooks.directBenefit,
        };
        const genCaption = res.data.primaryCaption;
        const genCta = res.data.callToAction;
        const genTags = res.data.hashtags || [];
        const genVisual = res.data.visualDirection || '';
        const genTakeaways = res.data.keyTakeaways || [];

        setProjectTitle(genTitle);
        setHooks(genHooks);
        setSelectedHookType('patternInterrupt');
        setCaption(genCaption);
        setCallToAction(genCta);
        setHashtags(genTags);
        setVisualDirection(genVisual);
        setKeyTakeaways(genTakeaways);
        setGenerationSource(res.source);
        setIsFallback(Boolean(res.isFallback));
        setGenerationNote(res.note || null);

        // Auto-save setting controls persistence: automatically save to library if enabled
        if (settings.autoSaveDrafts) {
          const autoDraft = saveDraft({
            brandId: activeBrand?.id || 'brand-01',
            title: genTitle,
            topic,
            platform,
            objective,
            language,
            audience,
            selectedHookType: 'patternInterrupt',
            hooks: genHooks,
            caption: genCaption,
            callToAction: genCta,
            hashtags: genTags,
            visualDirection: genVisual,
            keyTakeaways: genTakeaways,
            status: 'draft',
            complianceStatus: runComplianceCheck(genCaption, platform),
          });
          setSavedDraft(autoDraft);
        } else {
          setSavedDraft(null);
        }
      }
    } catch (err: any) {
      setGenerationError(err.message || 'Generation failed. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  // Swap hook variation into the caption
  const handleSelectHook = (type: HookType) => {
    setSelectedHookType(type);
    const newHook = hooks[type];
    if (!newHook) return;

    // Replace the first line/sentence of the caption with the selected hook
    const lines = caption.split('\n\n');
    if (lines.length > 1) {
      setCaption([newHook, ...lines.slice(1)].join('\n\n'));
    } else {
      setCaption(newHook);
    }
  };

  const handleAddHashtag = () => {
    if (!hashtagInput.trim()) return;
    const clean = hashtagInput.trim().replace(/^#/, '');
    if (!hashtags.includes(clean)) {
      setHashtags([...hashtags, clean]);
    }
    setHashtagInput('');
  };

  const handleRemoveHashtag = (tag: string) => {
    setHashtags(hashtags.filter(t => t !== tag));
  };

  const handleSaveToLibrary = (status: 'draft' | 'ready') => {
    if (!caption.trim()) return;

    const draft = saveDraft({
      brandId: activeBrand?.id || 'brand-01',
      title: projectTitle || `${topic} Project`,
      topic,
      platform,
      objective,
      language,
      audience,
      selectedHookType,
      hooks,
      caption,
      callToAction,
      hashtags,
      visualDirection,
      keyTakeaways,
      status,
      complianceStatus: compliance,
    });

    setSavedDraft(draft);
  };

  const handleCopyFullPost = () => {
    const formatted = `${caption}\n\n${callToAction}\n\n${hashtags.map(t => `#${t}`).join(' ')}`;
    navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Preload a seed prompt if empty
  const handleLoadSampleTopic = (sample: string) => {
    setTopic(sample);
  };

  return (
    <div className="space-y-6">
      {/* Studio Header */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Multi-Agent Content Studio</span>
          </div>
          <h2 className="text-lg font-bold text-zinc-100 mt-1">
            Generate Platform-Optimized Campaigns
          </h2>
          <p className="text-xs text-zinc-400">
            Automated compliance scanning, platform character limits, and 3 hook variations.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {generationSource && (
            <span
              className={`text-[11px] font-mono px-2.5 py-1 rounded-md border ${
                isFallback
                  ? 'bg-amber-950/40 text-amber-300 border-amber-800/80'
                  : 'bg-emerald-950/40 text-emerald-300 border-emerald-800/80'
              }`}
            >
              Engine: {isFallback ? 'Local Fallback' : generationSource}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Campaign Configuration (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <form onSubmit={handleGenerate} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center justify-between">
              <span>Campaign Parameters</span>
              <span className="text-[11px] font-normal text-zinc-500">Step 1 of 2</span>
            </h3>

            {/* Topic Input */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5 flex items-center justify-between">
                <span>Topic or Seed Keyword <span className="text-red-400">*</span></span>
                <span className="text-[11px] text-zinc-500 font-normal">Primary anchor</span>
              </label>
              <textarea
                rows={2}
                required
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder="e.g. Kubernetes memory allocation optimization or daily organic stress wellness"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 resize-none"
              />

              {/* Sample Topic Chips */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">Try:</span>
                <button
                  type="button"
                  onClick={() => handleLoadSampleTopic('Zero-downtime database schema migrations')}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800/80 transition-colors"
                >
                  DB Migrations
                </button>
                <button
                  type="button"
                  onClick={() => handleLoadSampleTopic('Herbal adaptogens for screen fatigue in Roman Urdu')}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800/80 transition-colors"
                >
                  Herbal Wellness (Urdu)
                </button>
                <button
                  type="button"
                  onClick={() => handleLoadSampleTopic('SaaS Gross Margin vs Customer Acquisition Cost')}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800/80 transition-colors"
                >
                  SaaS FinOps
                </button>
              </div>
            </div>

            {/* Platform Selection */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5 flex items-center justify-between">
                <span>Target Platform</span>
                <span className="text-[11px] text-zinc-500 font-mono">
                  Limit: {currentPlatformMeta.maxChars} chars
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {Object.values(PLATFORMS_CONFIG).map(p => {
                  const isSelected = platform === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlatform(p.id)}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium border text-left transition-colors ${
                        isSelected
                          ? 'bg-zinc-800 border-emerald-500/80 text-zinc-100 shadow-xs'
                          : 'bg-zinc-950 border-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      <PlatformIcon
                        platform={p.id}
                        className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-emerald-400' : 'text-zinc-500'}`}
                      />
                      <span className="truncate">{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Marketing Objective & Language */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Marketing Objective
                </label>
                <select
                  value={objective}
                  onChange={e => setObjective(e.target.value as MarketingObjective)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                >
                  {OBJECTIVES.map(obj => (
                    <option key={obj} value={obj}>
                      {obj}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Language Target
                </label>
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value as SupportedLanguage)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                >
                  {LANGUAGES.map(lang => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Target Audience Persona */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Target Audience Context
              </label>
              <input
                type="text"
                value={audience}
                onChange={e => setAudience(e.target.value)}
                placeholder="e.g. Platform Engineers / Urban young adults"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            {/* Custom Directives / Constraints */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">
                Custom Directives (Optional)
              </label>
              <input
                type="text"
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                placeholder="e.g. Include pricing anchor, emphasize weekend routine"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
              />
            </div>

            {generationError && (
              <div className="p-3 bg-red-950/60 border border-red-900/60 rounded-lg text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{generationError}</span>
              </div>
            )}

            {/* Generate Button */}
            <button
              type="submit"
              disabled={isGenerating}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Orchestrating Gemini 3.8 Flash...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Generate Campaign Content</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right Column: Generation Outputs & Editor (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {!caption && !isGenerating ? (
            <div className="h-full min-h-[440px] flex flex-col items-center justify-center text-center p-8 bg-zinc-900/50 border border-dashed border-zinc-800 rounded-xl space-y-3">
              <div className="p-3 bg-zinc-800 rounded-xl text-zinc-400">
                <Sparkles className="w-6 h-6 text-emerald-400" />
              </div>
              <div className="max-w-sm space-y-1">
                <h4 className="text-sm font-semibold text-zinc-200">No Content Generated Yet</h4>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Enter a topic on the left and click "Generate Campaign Content" to activate the Gemini engine.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Fallback Notice Banner */}
              {isFallback && generationNote && (
                <div className="p-3 bg-amber-950/40 border border-amber-900/60 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <span className="font-semibold text-amber-200">Local Deterministic Engine Engaged</span>
                    <p className="text-[11px] text-amber-300/90 leading-relaxed">{generationNote}</p>
                  </div>
                </div>
              )}

              {/* Hook Variations Selector (Master Spec Requirement) */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    <h4 className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                      Three Hook Variations (A/B Testing Ready)
                    </h4>
                  </div>
                  <span className="text-[11px] text-zinc-500">Click to apply to caption</span>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  {[
                    {
                      type: 'patternInterrupt' as HookType,
                      label: 'Hook A: Pattern Interrupt',
                      text: hooks.patternInterrupt,
                      badge: 'Scroll Stopper',
                    },
                    {
                      type: 'curiosityGap' as HookType,
                      label: 'Hook B: Curiosity Gap',
                      text: hooks.curiosityGap,
                      badge: 'High CTR',
                    },
                    {
                      type: 'directBenefit' as HookType,
                      label: 'Hook C: Direct Benefit',
                      text: hooks.directBenefit,
                      badge: 'Conversion',
                    },
                  ].map(h => {
                    const isSelected = selectedHookType === h.type;
                    return (
                      <button
                        key={h.type}
                        type="button"
                        onClick={() => handleSelectHook(h.type)}
                        className={`text-left p-3 rounded-lg border text-xs transition-colors ${
                          isSelected
                            ? 'bg-zinc-800/90 border-emerald-500/80 shadow-xs'
                            : 'bg-zinc-950 border-zinc-800/80 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`font-semibold ${isSelected ? 'text-emerald-400' : 'text-zinc-400'}`}>
                            {h.label}
                          </span>
                          <span className="text-[10px] text-zinc-500 font-mono">{h.badge}</span>
                        </div>
                        <p className="text-zinc-200 line-clamp-2 leading-relaxed">
                          {h.text || 'Generating variation...'}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Main Editable Editor */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                  <div className="flex-1 mr-3">
                    <input
                      type="text"
                      value={projectTitle}
                      onChange={e => setProjectTitle(e.target.value)}
                      placeholder="Campaign Title"
                      className="bg-transparent text-sm font-semibold text-zinc-100 focus:outline-hidden w-full border-b border-transparent focus:border-zinc-700"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleCopyFullPost}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors"
                      title="Copy full post"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* Primary Caption Field */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <label className="font-medium text-zinc-300">Editable Caption / Body Copy</label>
                    <span
                      className={`font-mono text-[11px] ${
                        compliance.charCount > currentPlatformMeta.maxChars
                          ? 'text-red-400 font-bold'
                          : 'text-zinc-500'
                      }`}
                    >
                      {compliance.charCount} / {currentPlatformMeta.maxChars} chars
                    </span>
                  </div>
                  <textarea
                    rows={8}
                    value={caption}
                    onChange={e => setCaption(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs sm:text-sm text-zinc-100 leading-relaxed focus:outline-hidden focus:border-emerald-500"
                  />
                </div>

                {/* Call to Action Field */}
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">
                    Call to Action (CTA)
                  </label>
                  <input
                    type="text"
                    value={callToAction}
                    onChange={e => setCallToAction(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                  />
                </div>

                {/* Hashtag Manager */}
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">
                    Platform Hashtags
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={hashtagInput}
                      onChange={e => setHashtagInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddHashtag();
                        }
                      }}
                      placeholder="Add tag and hit Enter"
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={handleAddHashtag}
                      className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700"
                    >
                      Add
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {hashtags.map(tag => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300 text-xs font-mono"
                      >
                        <span>#{tag}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveHashtag(tag)}
                          className="hover:text-red-400"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Compliance & Quality Guard Box */}
                <div className="p-3.5 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5 text-zinc-200">
                      {compliance.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                      )}
                      <span>Editorial Quality & Format Pre-Check</span>
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                        compliance.passed
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-900'
                          : 'bg-amber-950 text-amber-300 border border-amber-900'
                      }`}
                    >
                      {compliance.passed ? 'PASSED QUALITY' : 'ATTENTION REQUIRED'}
                    </span>
                  </div>

                  <p className="text-[11px] text-zinc-500">
                    Editorial tone and platform format check. Note: Does not constitute legal or regulatory compliance.
                  </p>

                  {compliance.detectedFluff.length > 0 && (
                    <div className="text-xs text-red-300 bg-red-950/40 p-2 rounded border border-red-900/50">
                      <span className="font-medium">Banned AI Fluff Detected: </span>
                      {compliance.detectedFluff.map(f => `"${f}"`).join(', ')}. Please rephrase to maintain authentic human authority.
                    </div>
                  )}

                  {currentPlatformMeta.safeZoneNote && (
                    <div className="text-[11px] text-zinc-400 flex items-start gap-1.5">
                      <Info className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
                      <span>{currentPlatformMeta.safeZoneNote}</span>
                    </div>
                  )}
                </div>

                {/* Action Bar: Save to Library & Schedule */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <div className="flex items-center gap-2">
                    {savedDraft ? (
                      <span className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                        <Check className="w-4 h-4" />
                        <span>Saved to Content Library</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-zinc-500">
                        {settings.autoSaveDrafts
                          ? 'Auto-save enabled: will save on generation'
                          : 'Auto-save disabled: manual save required'}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSaveToLibrary('draft')}
                      className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition-colors"
                    >
                      Save as Draft
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSaveToLibrary('ready')}
                      className="px-3.5 py-2 bg-teal-700 hover:bg-teal-600 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Mark Ready
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        // Ensure it's saved first
                        const draftToSchedule =
                          savedDraft ||
                          saveDraft({
                            brandId: activeBrand?.id || 'brand-01',
                            title: projectTitle || `${topic} Project`,
                            topic,
                            platform,
                            objective,
                            language,
                            audience,
                            selectedHookType,
                            hooks,
                            caption,
                            callToAction,
                            hashtags,
                            visualDirection,
                            keyTakeaways,
                            status: 'ready',
                            complianceStatus: compliance,
                          });
                        setSavedDraft(draftToSchedule);
                        setIsScheduleModalOpen(true);
                      }}
                      className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Schedule Campaign</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Schedule Modal */}
      {savedDraft && (
        <ScheduleModal
          draft={savedDraft}
          isOpen={isScheduleModalOpen}
          onClose={() => setIsScheduleModalOpen(false)}
          onScheduledSuccess={() => {
            setActiveSection('calendar');
          }}
        />
      )}
    </div>
  );
};
