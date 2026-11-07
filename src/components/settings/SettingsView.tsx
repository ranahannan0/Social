import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { apiService, AiStatusResponse } from '../../services/api';
import {
  Settings,
  Cpu,
  Database,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  ShieldAlert,
  Server,
  Zap,
  Check,
  FileCode,
} from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { settings, updateSettings, brands, resetToDemoData } = useApp();

  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [isCheckingAi, setIsCheckingAi] = useState(false);
  const [aiCheckError, setAiCheckError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Active subtab: 'app' | 'ai' | 'supabase'
  const [activeTab, setActiveTab] = useState<'app' | 'ai' | 'supabase'>('app');

  const checkAiHealth = async () => {
    setIsCheckingAi(true);
    setAiCheckError(null);
    try {
      const res = await apiService.getAiStatus();
      setAiStatus(res);
    } catch (err: any) {
      setAiCheckError(err.message || 'Failed to ping AI status endpoint');
    } finally {
      setIsCheckingAi(false);
    }
  };

  useEffect(() => {
    checkAiHealth();
  }, []);

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
  };

  const handleResetDemo = () => {
    if (confirm('Reset all brand profiles, drafts, and calendar events to default Phase 1 demo data?')) {
      resetToDemoData();
      setResetSuccess(true);
      setTimeout(() => setResetSuccess(false), 2500);
    }
  };

  return (
    <div className="space-y-6">
      {/* Settings Navigation Tabs */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 p-1 bg-zinc-950 rounded-lg border border-zinc-800/80">
          <button
            onClick={() => setActiveTab('app')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'app'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Workspace & Defaults</span>
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'ai'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Gemini AI Engine</span>
          </button>
          <button
            onClick={() => setActiveTab('supabase')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'supabase'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>Supabase Architecture</span>
          </button>
        </div>

        <button
          onClick={handleResetDemo}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-950 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg text-xs font-medium transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset Demo Data</span>
        </button>
      </div>

      {resetSuccess && (
        <div className="p-3 bg-emerald-950/60 border border-emerald-900/60 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-in fade-in">
          <Check className="w-4 h-4 text-emerald-400" />
          <span>Workspace reset to original demo seed datasets.</span>
        </div>
      )}

      {/* Tab 1: App Settings */}
      {activeTab === 'app' && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100">Workspace Configuration</h3>
              <p className="text-xs text-zinc-500">General preferences, default brands, and scheduling timezones</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Workspace Name
                </label>
                <input
                  type="text"
                  value={settings.workspaceName}
                  onChange={e => updateSettings({ workspaceName: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Default Brand Space
                </label>
                <select
                  value={settings.defaultBrandId}
                  onChange={e => updateSettings({ defaultBrandId: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                >
                  {brands.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Default Timezone
                </label>
                <select
                  value={settings.timezone}
                  onChange={e => updateSettings({ timezone: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                >
                  <option value="Asia/Karachi (PKT, UTC+5)">Asia/Karachi (PKT, UTC+5)</option>
                  <option value="Asia/Dubai (GST, UTC+4)">Asia/Dubai (GST, UTC+4)</option>
                  <option value="Asia/Kolkata (IST, UTC+5:30)">Asia/Kolkata (IST, UTC+5:30)</option>
                  <option value="Europe/London (GMT/BST)">Europe/London (GMT/BST)</option>
                  <option value="America/New_York (EST/EDT)">America/New_York (EST/EDT)</option>
                  <option value="America/Los_Angeles (PST/PDT)">America/Los_Angeles (PST/PDT)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Default Primary Language
                </label>
                <select
                  value={settings.defaultLanguage}
                  onChange={e => updateSettings({ defaultLanguage: e.target.value as any })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                >
                  <option value="English">English</option>
                  <option value="Roman Urdu">Roman Urdu</option>
                  <option value="Urdu (Script)">Urdu (Script)</option>
                  <option value="Hindi">Hindi</option>
                  <option value="Spanish">Spanish</option>
                  <option value="Arabic">Arabic</option>
                </select>
              </div>
            </div>

            {/* Toggle options */}
            <div className="pt-3 border-t border-zinc-800 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enableFluffHighlighting}
                  onChange={e => updateSettings({ enableFluffHighlighting: e.target.checked })}
                  className="w-4 h-4 rounded border-zinc-700 bg-zinc-950 text-emerald-600 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="text-xs font-medium text-zinc-200 block">
                    Real-time AI Fluff Phrase Highlighting
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    Automatically scans and flags prohibited clichés ("In today's fast-paced world", "delve into") during caption editing.
                  </span>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoSaveDrafts}
                  onChange={e => updateSettings({ autoSaveDrafts: e.target.checked })}
                  className="w-4 h-4 rounded border-zinc-700 bg-zinc-950 text-emerald-600 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="text-xs font-medium text-zinc-200 block">
                    Auto-persist Drafts to Local Storage
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    Keep drafts synchronized between sessions until cloud database integration is active.
                  </span>
                </div>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            {saveSuccess && (
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1.5 animate-in fade-in">
                <Check className="w-4 h-4" />
                <span>Preferences saved</span>
              </span>
            )}
            <button
              type="submit"
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-xs"
            >
              Save Preferences
            </button>
          </div>
        </form>
      )}

      {/* Tab 2: AI Engine Status */}
      {activeTab === 'ai' && (
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400" />
                  <span>Gemini 3.8 Flash AI Engine Telemetry</span>
                </h3>
                <p className="text-xs text-zinc-500">
                  Direct server-side integration via @google/genai TypeScript SDK
                </p>
              </div>

              <button
                onClick={checkAiHealth}
                disabled={isCheckingAi}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingAi ? 'animate-spin' : ''}`} />
                <span>Ping Engine</span>
              </button>
            </div>

            {/* Health Card */}
            <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      aiStatus?.connected ? 'bg-emerald-400 shadow-xs shadow-emerald-500/50' : 'bg-amber-400'
                    }`}
                  />
                  <span className="text-xs font-semibold text-zinc-200">
                    {aiStatus?.connected ? 'Gemini 3.8 Flash Online' : 'Local Deterministic Fallback Active'}
                  </span>
                </div>
                {aiStatus?.latencyMs !== null && aiStatus?.latencyMs !== undefined && (
                  <span className="text-[11px] font-mono text-zinc-400">
                    Latency: {aiStatus.latencyMs}ms
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-400 leading-relaxed">
                {aiStatus?.message || 'Inspecting server API gateway...'}
              </p>

              {aiStatus?.responseSample && (
                <div className="p-2.5 bg-zinc-900 rounded border border-zinc-800 font-mono text-[11px] text-emerald-300">
                  Engine Probe Echo: {aiStatus.responseSample}
                </div>
              )}
            </div>

            {/* Technical Configuration Specs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Active AI Model</span>
                <span className="font-mono text-zinc-200 font-semibold">gemini-3.8-flash</span>
              </div>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Security Architecture</span>
                <span className="font-mono text-emerald-400 font-semibold">Server-Side Proxy Only</span>
              </div>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Client Exposure</span>
                <span className="font-mono text-zinc-300 font-semibold">Zero Browser API Keys</span>
              </div>
            </div>

            <div className="p-3 bg-zinc-950/60 rounded-lg border border-zinc-800/80 text-xs text-zinc-400 space-y-1.5 leading-relaxed">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-emerald-400" />
                <span>API Key Management</span>
              </span>
              <p>
                As required by AI Studio security rules, the Gemini API key is managed securely in the environment and accessed exclusively on the server (`server.ts`). It is never exposed in client bundles or browser state.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Supabase Architecture Readiness */}
      {activeTab === 'supabase' && (
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-400" />
                <span>Future Supabase Integration Readiness (Phase 2+)</span>
              </h3>
              <p className="text-xs text-zinc-500">
                Phase 1 uses local state persistence, structured identically to the master PostgreSQL schema for seamless Phase 2 migration.
              </p>
            </div>

            {/* Readiness Checklist */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                Migration Readiness Checklist
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-zinc-800/80 text-zinc-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>TypeScript interfaces align with Postgres tables</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-zinc-800/80 text-zinc-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>UUID id conventions preserved throughout drafts</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-zinc-800/80 text-zinc-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>JSONB payload compatibility for hook variations</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-zinc-800/80 text-zinc-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Compliance audit log columns modeled</span>
                </div>
              </div>
            </div>

            {/* SQL Schema Preview from Appendix */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Target PostgreSQL Schema (from Omni Channel Plus Appendix)</span>
                </span>
                <span className="text-[10px] font-mono text-zinc-500">pgvector ready</span>
              </div>

              <pre className="p-3.5 bg-zinc-950 rounded-lg border border-zinc-800 font-mono text-[11px] text-zinc-300 overflow-x-auto leading-relaxed">
{`-- Brand Voice Memory Schema (Supabase)
CREATE TABLE brand_voice_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  platform TEXT,
  approved_at TIMESTAMPTZ,
  embedding VECTOR(1537)
);

CREATE TABLE content_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT, -- article | reel | post | thread | email
  platform TEXT,
  status TEXT, -- draft | scheduled | published | archived
  utm_campaign TEXT,
  compliance_check_id UUID,
  published_at TIMESTAMPTZ,
  score_30d TEXT, -- A | B | C
  payload JSONB
);

CREATE TABLE crm_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_handle TEXT,
  platform TEXT,
  category TEXT, -- INQUIRY | ORDER | COMPLAINT | UGC | SPAM
  sentiment TEXT,
  urgency INT,
  auto_reply TEXT,
  escalated BOOLEAN,
  opt_in BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE compliance_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID,
  layer TEXT,
  status TEXT,
  evidence TEXT,
  checked_at TIMESTAMPTZ DEFAULT now()
);`}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
