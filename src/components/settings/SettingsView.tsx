import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import {
  ASSIGNABLE_MEMBER_ROLES,
  canManageMembers,
  roleBadgeLabel,
  type OrgMember,
} from '../../utils/orgRoles';
import { useAuth } from '../../context/AuthContext';
import { apiService, AiStatusResponse } from '../../services/api';
import {
  Settings,
  Cpu,
  Database,
  RefreshCw,
  RotateCcw,
  Server,
  Check,
  FileCode,
  Clock,
  AlertCircle,
  Share2,
  Radio,
  ExternalLink,
  Download,
  UploadCloud,
  LogOut,
  Loader2,
  User,
  Users,
  Plus,
  Pencil,
  Trash2,
  Crown,
  X,
  Cloud,
  CloudOff,
  CloudCog,
} from 'lucide-react';
import { downloadWorkspaceExport } from '../../utils/workspaceExport';
import { authedFetch } from '../../services/authClient';

export const SettingsView: React.FC = () => {
  const {
    settings,
    updateSettings,
    brands,
    resetToDemoData,
    syncToCloud,
    syncing,
    lastSyncAt,
    lastSyncSummary,
    hydrationStatus,
    hydrationError,
    syncState,
    retryPendingSync,
    orgs,
    activeOrgId,
    activeRole,
    switchOrg,
    forgetOrg,
    refreshOrgMeta,
  } = useApp();
  const { user, signOut } = useAuth();

  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [isCheckingAi, setIsCheckingAi] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Phase 3 multi-org: workspace switcher state (in-flight id + last error).
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);
  const [switchOrgError, setSwitchOrgError] = useState<string | null>(null);

  const handleSwitchOrg = (orgId: string) => {
    if (orgId === activeOrgId || switchingOrgId) return;
    setSwitchingOrgId(orgId);
    setSwitchOrgError(null);
    switchOrg(orgId)
      .catch((e: Error) => setSwitchOrgError(e.message || 'Workspace switch failed.'))
      .finally(() => setSwitchingOrgId(null));
  };

  // ── P3.5/P3.6: workspace lifecycle (owner powers) ──────────────────────
  const [renamingOrgId, setRenamingOrgId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteOrgId, setConfirmDeleteOrgId] = useState<string | null>(null);
  const [orgBusyId, setOrgBusyId] = useState<string | null>(null);
  const [orgActionMsg, setOrgActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Owner powers are per-row (a row shows them only when THAT org's role is
  // owner); this just decides whether the explanatory hint renders at all.
  const isOwnerSomewhere = orgs.some(o => o.role === 'owner');

  const startRenameOrg = (orgId: string, currentName: string) => {
    setConfirmDeleteOrgId(null);
    setOrgActionMsg(null);
    setRenamingOrgId(orgId);
    setRenameValue(currentName);
  };

  const handleRenameOrg = async (orgId: string) => {
    if (orgBusyId) return;
    const name = renameValue.trim();
    if (name.length < 1 || name.length > 120) {
      setOrgActionMsg({ ok: false, text: 'Workspace name must be 1-120 characters.' });
      return;
    }
    setOrgBusyId(orgId);
    setOrgActionMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${orgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOrgActionMsg({ ok: false, text: body?.message || `Rename failed (status ${res.status}).` });
        return;
      }
      setOrgActionMsg({ ok: true, text: 'Workspace renamed.' });
      setRenamingOrgId(null);
      void refreshOrgMeta(); // P3.6: pull the new name into the switcher
    } catch {
      setOrgActionMsg({ ok: false, text: 'Network error while renaming the workspace.' });
    } finally {
      setOrgBusyId(null);
    }
  };

  const handleDeleteOrg = async (orgId: string) => {
    if (orgBusyId) return;
    setOrgBusyId(orgId);
    setOrgActionMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${orgId}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOrgActionMsg({ ok: false, text: body?.message || `Delete failed (status ${res.status}).` });
        setConfirmDeleteOrgId(null);
        return;
      }
      const wasActive = orgId === activeOrgId;
      const remaining = orgs.filter(o => o.id !== orgId);
      setConfirmDeleteOrgId(null);
      setOrgActionMsg({ ok: true, text: 'Workspace deleted.' });
      forgetOrg(orgId); // switcher stops listing it immediately
      if (wasActive && remaining.length > 0) {
        // The active workspace is gone — move to the first remaining one.
        // switchOrg re-hydrates everything from the server.
        try {
          await switchOrg(remaining[0].id);
        } catch (e: unknown) {
          setOrgActionMsg({ ok: false, text: (e as Error)?.message || 'Workspace deleted, but switching to the next workspace failed — reload the page.' });
        }
      }
    } catch {
      setOrgActionMsg({ ok: false, text: 'Network error while deleting the workspace.' });
    } finally {
      setOrgBusyId(null);
    }
  };

  const handleTransferOwnership = async (m: OrgMember) => {
    if (!activeOrgId || memberBusyId || orgBusyId) return;
    setMemberBusyId(m.userId);
    setMembersMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/ownership-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: m.userId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersMsg({ ok: false, text: body?.message || `Ownership transfer failed (status ${res.status}).` });
        return;
      }
      setMembersMsg({
        ok: true,
        text: typeof body?.warning === 'string'
          ? body.warning
          : `${m.email ?? 'That member'} now owns this workspace — you are an admin.`,
      });
      await loadMembers(); // snap the roster to the server truth
      void refreshOrgMeta(); // role badges: caller OWNER→ADMIN, target ADMIN→OWNER
    } catch {
      setMembersMsg({ ok: false, text: 'Network error while transferring ownership.' });
    } finally {
      setMemberBusyId(null);
    }
  };

  // ── P3.4: member management (admins/owners only) ──────────────────────
  const [membersList, setMembersList] = useState<OrgMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const [inviting, setInviting] = useState(false);
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [membersMsg, setMembersMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadMembers = useCallback(async () => {
    if (!activeOrgId) return;
    setMembersLoading(true);
    setMembersError(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/members`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersList([]);
        setMembersError(body?.message || `Failed to load members (status ${res.status}).`);
        return;
      }
      setMembersList(Array.isArray(body.members) ? body.members : []);
    } catch {
      setMembersError('Network error while loading members.');
    } finally {
      setMembersLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (activeOrgId && activeRole && canManageMembers(activeRole)) {
      void loadMembers();
    }
  }, [activeOrgId, activeRole, loadMembers]);

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId || inviting) return;
    setInviting(true);
    setMembersMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersMsg({ ok: false, text: body?.message || `Could not add the member (status ${res.status}).` });
        return;
      }
      setMembersMsg({ ok: true, text: `${inviteEmail.trim()} added as ${inviteRole}.` });
      setInviteEmail('');
      await loadMembers();
    } catch {
      setMembersMsg({ ok: false, text: 'Network error while adding the member.' });
    } finally {
      setInviting(false);
    }
  };

  const handleMemberRoleChange = async (m: OrgMember, nextRole: string) => {
    if (!activeOrgId || memberBusyId) return;
    setMemberBusyId(m.userId);
    setMembersMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/members/${m.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersMsg({ ok: false, text: body?.message || `Role change failed (status ${res.status}).` });
        await loadMembers(); // snap the select back to the server truth
        return;
      }
      setMembersMsg({ ok: true, text: 'Role updated.' });
      await loadMembers();
    } catch {
      setMembersMsg({ ok: false, text: 'Network error while changing the role.' });
    } finally {
      setMemberBusyId(null);
    }
  };

  const handleRemoveMember = async (m: OrgMember) => {
    if (!activeOrgId || memberBusyId) return;
    setMemberBusyId(m.userId);
    setMembersMsg(null);
    try {
      const res = await authedFetch(`/api/orgs/${activeOrgId}/members/${m.userId}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMembersMsg({ ok: false, text: body?.message || `Removal failed (status ${res.status}).` });
        return;
      }
      setMembersMsg({ ok: true, text: 'Member removed.' });
      await loadMembers();
    } catch {
      setMembersMsg({ ok: false, text: 'Network error while removing the member.' });
    } finally {
      setMemberBusyId(null);
    }
  };

  const handleExportBackup = () => {
    try {
      const { fileName, counts } = downloadWorkspaceExport();
      setExportMsg({
        ok: true,
        text: `Backup downloaded: ${fileName} (${counts.brands} brands, ${counts.drafts} drafts, ${counts.events} events).`,
      });
    } catch (err: any) {
      setExportMsg({ ok: false, text: err?.message || 'Export failed.' });
    }
    setTimeout(() => setExportMsg(null), 6000);
  };

  // Active subtab: 'app' | 'ai' | 'supabase' | 'integrations'
  const [activeTab, setActiveTab] = useState<'app' | 'ai' | 'supabase' | 'integrations'>('app');

  const checkAiHealth = async () => {
    setIsCheckingAi(true);
    try {
      const res = await apiService.getAiStatus();
      setAiStatus(res);
    } catch (err: any) {
      setAiStatus({
        connected: false,
        message: err.message || 'Failed to ping AI status endpoint',
        model: 'gemini-3.8-flash',
        testedAt: new Date().toISOString(),
        latencyMs: null,
      });
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

  const confirmReset = () => {
    resetToDemoData();
    setIsConfirmingReset(false);
    setResetSuccess(true);
    setTimeout(() => setResetSuccess(false), 2500);
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
          <button
            onClick={() => setActiveTab('integrations')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === 'integrations'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>External Integrations</span>
          </button>
        </div>

        <button
          onClick={() => setIsConfirmingReset(true)}
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
          {/* Auto-sync (Stage B) — moved here in P3.3 so sync status is visible
              on the DEFAULT tab instead of hiding behind the Supabase tab */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <CloudCog className="w-4 h-4 text-zinc-400" />
                  <span>Auto-sync</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">STAGE B · LIVE</span>
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Every create, edit and delete saves to the cloud automatically — no button needed.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {syncState.pending > 0 ? (
                  <span className="text-xs px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 font-medium flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {syncState.pending} pending
                  </span>
                ) : (
                  <span className="text-xs px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-medium flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" />
                    All saved
                  </span>
                )}
                {syncState.pending > 0 && (
                  <button
                    type="button"
                    onClick={retryPendingSync}
                    className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>

            {syncState.lastError && (
              <div className="text-xs flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-medium">A change could not be saved to the cloud</div>
                  <div className="mt-0.5 text-red-400/90">{syncState.lastError}</div>
                  <div className="mt-1 text-zinc-400">
                    Pending changes retry automatically. “Full sync” below can also repair everything.
                  </div>
                </div>
              </div>
            )}
          </div>
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
                    Auto-save Generated Drafts to Content Library
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    When enabled, campaigns generated in the Content Studio are automatically saved to your Content Library. When disabled, drafts remain in preview until you click Save.
                  </span>
                </div>
              </label>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Download className="w-4 h-4 text-emerald-400" />
                Data &amp; Backup
              </h3>
              <p className="text-xs text-zinc-500">
                Download a full backup of your workspace (brands, drafts, calendar events,
                settings). Import into the Phase 2 database is available once the workspace is
                connected to Supabase — this export is the migration file.
              </p>
            </div>
            {exportMsg && (
              <div
                className={`p-3 rounded-xl text-xs flex items-center gap-2 animate-in fade-in ${
                  exportMsg.ok
                    ? 'bg-emerald-950/60 border border-emerald-900/60 text-emerald-300'
                    : 'bg-red-950/60 border border-red-900/60 text-red-300'
                }`}
              >
                {exportMsg.ok ? <Check className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
                <span>{exportMsg.text}</span>
              </div>
            )}
            <button
              type="button"
              onClick={handleExportBackup}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-xs font-medium text-zinc-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export Backup (JSON)
            </button>
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
                  <span>AI Engine Telemetry & Configuration</span>
                </h3>
                <p className="text-xs text-zinc-500">
                  Server-side Gemini SDK integration with rate limiting and secure proxy routing
                </p>
              </div>

              <button
                onClick={checkAiHealth}
                disabled={isCheckingAi}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingAi ? 'animate-spin' : ''}`} />
                <span>Probe API Connection</span>
              </button>
            </div>

            {/* Live Connection Card */}
            <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      aiStatus?.connected
                        ? 'bg-emerald-400 shadow-xs shadow-emerald-500/50'
                        : 'bg-amber-400'
                    }`}
                  />
                  <span className="text-xs font-semibold text-zinc-200">
                    {aiStatus?.connected
                      ? `${aiStatus.model || 'Gemini'} Connected & Operational`
                      : 'Local Deterministic Fallback Active'}
                  </span>
                </div>
                {aiStatus?.connected && aiStatus?.latencyMs !== null && aiStatus?.latencyMs !== undefined && (
                  <span className="text-[11px] font-mono text-zinc-400">
                    Probe Latency: {aiStatus.latencyMs}ms
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-400 leading-relaxed">
                {aiStatus?.message || 'Inspecting server API gateway...'}
              </p>

              {aiStatus?.connected && aiStatus?.responseSample && (
                <div className="p-2.5 bg-zinc-900 rounded border border-zinc-800 font-mono text-[11px] text-emerald-300">
                  Engine Probe Echo: {aiStatus.responseSample}
                </div>
              )}
            </div>

            {/* Technical Configuration Specs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Configured AI Model</span>
                <span className="font-mono text-zinc-200 font-semibold">
                  {aiStatus?.model || 'gemini-3.8-flash'}
                </span>
              </div>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Rate Limiting</span>
                <span className="font-mono text-emerald-400 font-semibold">10 req / min per IP</span>
              </div>
              <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block">Client Exposure</span>
                <span className="font-mono text-zinc-300 font-semibold">Zero Browser API Keys</span>
              </div>
            </div>

            <div className="p-3 bg-zinc-950/60 rounded-lg border border-zinc-800/80 text-xs text-zinc-400 space-y-1.5 leading-relaxed">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-emerald-400" />
                <span>Security & API Key Management</span>
              </span>
              <p>
                The Gemini API key is isolated strictly to the Node.js backend. It is never logged, never returned in API payloads, and never bundled into frontend assets. If the key is not present or upstream service is temporarily unreachable, the Studio automatically utilizes a deterministic template engine.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Cloud Storage (Phase 2 — live) */}
      {activeTab === 'supabase' && (
        <div className="space-y-6">
          {/* Account / auth status */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-emerald-400" />
                  <span>Cloud Storage (Phase 2 — Live)</span>
                </h3>
                <p className="text-xs text-zinc-500">
                  Your workspace is backed by a hosted Postgres database with per-account row-level security.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 text-[11px] font-semibold font-mono rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                  STATUS: CONNECTED
                </span>
              </div>
            </div>

            {/* Account block */}
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800/80">
                <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                  <User className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-500">Signed in as</div>
                  <div className="text-sm text-zinc-100 font-medium truncate">
                    {user?.email ?? 'Unknown account'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="text-xs px-3 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </div>

              {/* Hydration status */}
              <div className="text-xs flex items-start gap-2 p-3 bg-zinc-950 rounded-lg border border-zinc-800/80">
                {hydrationStatus === 'loading' && <Loader2 className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5 animate-spin" />}
                {hydrationStatus === 'ready' && <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />}
                {hydrationStatus === 'error' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
                {hydrationStatus === 'idle' && <Clock className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />}
                <div className="flex-1">
                  <div className="text-zinc-300 font-medium">
                    {hydrationStatus === 'loading' && 'Loading workspace from cloud…'}
                    {hydrationStatus === 'ready' && 'Workspace loaded from cloud.'}
                    {hydrationStatus === 'error' && 'Cloud sync failed — showing local data.'}
                    {hydrationStatus === 'idle' && 'Cloud sync idle.'}
                  </div>
                  {hydrationError && (
                    <div className="text-red-400 mt-0.5">{hydrationError}</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Workspaces (Phase 3 multi-org) */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Share2 className="w-4 h-4 text-zinc-400" />
                  <span>Workspaces</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">PHASE 3 · LIVE</span>
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  {orgs.length > 1
                    ? 'You belong to several workspaces. Switching reloads that workspace — nothing is copied or merged.'
                    : 'Your account has one workspace. Invite-based multi-member workspaces land later.'}
                </p>
              </div>
              <span className="text-xs px-3 py-1.5 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 font-medium shrink-0">
                {orgs.length} {orgs.length === 1 ? 'workspace' : 'workspaces'}
              </span>
            </div>

            <div className="space-y-2">
              {orgs.map(o => {
                const isActive = o.id === activeOrgId;
                const isBusy = switchingOrgId === o.id;
                const lifecycleBusy = orgBusyId === o.id || !!orgBusyId;
                const isOwner = o.role === 'owner';
                return (
                  <div
                    key={o.id}
                    className={`w-full flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                      isActive
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-zinc-950 border-zinc-800/80'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={isActive || !!switchingOrgId || lifecycleBusy}
                      onClick={() => handleSwitchOrg(o.id)}
                      title={isActive ? undefined : `Switch to ${o.name}`}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left transition-colors disabled:cursor-default"
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isActive ? 'bg-emerald-500/15 border border-emerald-500/30' : 'bg-zinc-900 border border-zinc-800'
                      }`}>
                        {isBusy ? (
                          <Loader2 className="w-4 h-4 text-zinc-300 animate-spin" />
                        ) : isActive ? (
                          <Check className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Share2 className="w-4 h-4 text-zinc-500" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {renamingOrgId === o.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') void handleRenameOrg(o.id);
                              if (e.key === 'Escape') setRenamingOrgId(null);
                            }}
                            maxLength={120}
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                          />
                        ) : (
                          <div className="text-sm text-zinc-100 font-medium truncate">{o.name}</div>
                        )}
                        <div className="text-xs text-zinc-500 truncate">{o.defaultTimezone ?? 'UTC'}</div>
                      </div>
                      {o.role && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                          o.role === 'viewer'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-zinc-800/90 text-zinc-300'
                        }`}>
                          {roleBadgeLabel(o.role)}
                        </span>
                      )}
                      {isActive && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold shrink-0">
                          ACTIVE
                        </span>
                      )}
                    </button>
                    {isOwner && renamingOrgId !== o.id && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={lifecycleBusy || !!switchingOrgId}
                          onClick={() => startRenameOrg(o.id, o.name)}
                          title="Rename workspace"
                          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {confirmDeleteOrgId === o.id ? (
                          <span className="flex items-center gap-1">
                            <span className="text-[10px] text-red-300 font-medium hidden sm:inline">Delete forever?</span>
                            <button
                              type="button"
                              disabled={lifecycleBusy}
                              onClick={() => void handleDeleteOrg(o.id)}
                              title="Confirm delete — removes all brands, drafts and events"
                              className="text-[10px] px-2 py-1 rounded-md bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-50"
                            >
                              {orgBusyId === o.id ? '…' : 'Yes'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteOrgId(null)}
                              title="Cancel"
                              className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={lifecycleBusy || !!switchingOrgId || orgs.length <= 1}
                            onClick={() => { setOrgActionMsg(null); setConfirmDeleteOrgId(o.id); }}
                            title={orgs.length <= 1 ? 'Your only workspace cannot be deleted' : 'Delete workspace'}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    {isOwner && renamingOrgId === o.id && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={lifecycleBusy || renameValue.trim().length < 1}
                          onClick={() => void handleRenameOrg(o.id)}
                          title="Save name"
                          className="p-1.5 rounded-md text-emerald-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {orgBusyId === o.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          disabled={lifecycleBusy}
                          onClick={() => setRenamingOrgId(null)}
                          title="Cancel"
                          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {orgs.length === 0 && hydrationStatus === 'loading' && (
                <div className="text-xs text-zinc-500 flex items-center gap-2 p-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading workspaces…
                </div>
              )}
            </div>

            {activeRole === 'viewer' && (
              <div className="text-xs flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-medium">Read-only workspace</div>
                  <div className="mt-0.5 text-amber-400/90">
                    Your role here is viewer — creating and editing is disabled. Switch to a
                    workspace where you have editor access, or ask an admin to upgrade you.
                  </div>
                </div>
              </div>
            )}

            {switchOrgError && (
              <div className="text-xs flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1">{switchOrgError}</div>
              </div>
            )}

            {orgActionMsg && (
              <div className={`text-xs flex items-start gap-2 p-3 rounded-lg border ${
                orgActionMsg.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/30 text-red-300'
              }`}>
                {orgActionMsg.ok ? <Check className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                <div className="flex-1">{orgActionMsg.text}</div>
              </div>
            )}

            {isOwnerSomewhere && (
              <p className="text-[11px] text-zinc-600">
                Pencil renames a workspace you own; the trash icon deletes it (all brands, drafts and events
                go with it — the server refuses while other members remain).
              </p>
            )}
          </div>

          {/* Team members (Phase 3.4) — roster management for admins/owners */}
          {activeRole && canManageMembers(activeRole) && activeOrgId && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Users className="w-4 h-4 text-zinc-400" />
                  <span>Team members</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">PHASE 3 · LIVE</span>
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  People with access to the ACTIVE workspace. Editors create and edit; viewers read only.
                </p>
              </div>

              {membersLoading ? (
                <div className="text-xs text-zinc-500 flex items-center gap-2 p-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading members…
                </div>
              ) : membersError ? (
                <div className="text-xs flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="flex-1">{membersError}</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {membersList.map(m => (
                    <div key={m.userId} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border border-zinc-800/80 bg-zinc-950">
                      <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                        {m.role === 'owner' ? <User className="w-4 h-4 text-emerald-400" /> : <Users className="w-4 h-4 text-zinc-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-100 font-medium truncate">{m.email ?? `${m.userId.slice(0, 8)}…`}</div>
                        <div className="text-xs text-zinc-500">
                          {m.role === 'owner' ? 'Workspace owner' : m.joinedAt ? `Joined ${new Date(m.joinedAt).toLocaleDateString()}` : 'Member'}
                        </div>
                      </div>
                      <select
                        value={m.role}
                        disabled={memberBusyId === m.userId || m.role === 'owner'}
                        onChange={e => void handleMemberRoleChange(m, e.target.value)}
                        title={m.role === 'owner' ? 'Ownership transfer is a dedicated flow' : undefined}
                        className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-hidden focus:border-emerald-500 disabled:opacity-50"
                      >
                        {m.role === 'owner' && <option value="owner">OWNER</option>}
                        {ASSIGNABLE_MEMBER_ROLES.map(r => (
                          <option key={r} value={r}>{roleBadgeLabel(r)}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={memberBusyId === m.userId || m.role === 'owner'}
                        onClick={() => void handleRemoveMember(m)}
                        title={m.role === 'owner' ? 'The last owner cannot be removed' : undefined}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                      >
                        {memberBusyId === m.userId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Remove'}
                      </button>
                      {activeRole === 'owner' && m.role === 'admin' && (
                        <button
                          type="button"
                          disabled={!!memberBusyId || !!orgBusyId}
                          onClick={() => void handleTransferOwnership(m)}
                          title="Make this admin the workspace owner — you become an admin"
                          className="text-xs px-2.5 py-1.5 rounded-md border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 flex items-center gap-1"
                        >
                          <Crown className="w-3.5 h-3.5" />
                          Make owner
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {membersMsg && (
                <div className={`text-xs flex items-start gap-2 p-3 rounded-lg border ${
                  membersMsg.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/30 text-red-300'
                }`}>
                  {membersMsg.ok ? <Check className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                  <div className="flex-1">{membersMsg.text}</div>
                </div>
              )}

              <form onSubmit={e => void handleInviteMember(e)} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500"
                />
                <select
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'admin' | 'editor' | 'viewer')}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-sm text-zinc-200 focus:outline-hidden focus:border-emerald-500"
                >
                  {ASSIGNABLE_MEMBER_ROLES.map(r => (
                    <option key={r} value={r}>{roleBadgeLabel(r)}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={inviting}
                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors shrink-0 flex items-center justify-center gap-1.5"
                >
                  {inviting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  <span>{inviting ? 'Adding…' : 'Add member'}</span>
                </button>
              </form>
              <p className="text-[11px] text-zinc-600">
                They must already have an account — email invitations to brand-new accounts land in a later phase.
              </p>
            </div>
          )}

          {/* Sync to Cloud (full repair) */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <UploadCloud className="w-4 h-4 text-zinc-400" />
                  <span>Sync to Cloud</span>
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Full workspace push ({brands.length} brands): creates anything missing in the cloud, skips what matches (idempotent). Use it to repair after errors — daily editing needs no button.
                </p>
              </div>
              <button
                type="button"
                onClick={() => syncToCloud().catch((e: Error) => {
                  setExportMsg({ ok: false, text: e.message || 'Sync failed.' });
                  setTimeout(() => setExportMsg(null), 6000);
                })}
                disabled={syncing}
                className="text-xs px-3.5 py-2 rounded-md bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                {syncing ? 'Syncing…' : 'Full sync (repair)'}
              </button>
            </div>

            {(lastSyncAt || lastSyncSummary) && (
              <div className="text-xs flex items-start gap-2 p-3 bg-zinc-950 rounded-lg border border-zinc-800/80">
                <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  {lastSyncSummary && <div className="text-zinc-300">{lastSyncSummary}</div>}
                  {lastSyncAt && (
                    <div className="text-zinc-500 mt-0.5">
                      Last sync: {new Date(lastSyncAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {exportMsg && (
              <div
                className={`text-xs flex items-start gap-2 p-3 rounded-lg border ${
                  exportMsg.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/30 text-red-300'
                }`}
              >
                {exportMsg.ok ? <Check className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>{exportMsg.text}</span>
              </div>
            )}
          </div>

          {/* Architecture notice (Phase 2 implemented) */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Database className="w-4 h-4 text-zinc-400" />
                <span>Phase 2 Architecture (Implemented)</span>
              </h3>
              <p className="text-xs text-zinc-500 mt-1">
                Live schema on the hosted Postgres instance — migrations 0001–0008 applied.
              </p>
            </div>

            <div className="p-3.5 bg-zinc-950 border border-zinc-800/80 rounded-lg text-xs text-zinc-400 flex items-start gap-2.5">
              <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-semibold text-zinc-300 block">Live Modules</span>
                <p>
                  Per-account row-level security, multi-tenant organizations, brand voice as JSONB, append-only compliance history, server-only DB access (browser never talks to Supabase directly), and workspace-level export/import for sync &amp; backup.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-emerald-500/20 text-emerald-300">
                <Check className="w-4 h-4 shrink-0" />
                <span>Hosted PostgreSQL 17 · ap-southeast-1</span>
              </div>
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-emerald-500/20 text-emerald-300">
                <Check className="w-4 h-4 shrink-0" />
                <span>Row-Level Security · 9 tables, ENABLE+FORCE</span>
              </div>
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-emerald-500/20 text-emerald-300">
                <Check className="w-4 h-4 shrink-0" />
                <span>Server-only DB · JWT verified per request</span>
              </div>
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-emerald-500/20 text-emerald-300">
                <Check className="w-4 h-4 shrink-0" />
                <span>Default-privilege hardening · manual-exposure mode</span>
              </div>
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-amber-500/20 text-amber-300">
                <Clock className="w-4 h-4 shrink-0" />
                <span>Per-resource CRUD endpoints · Phase 3</span>
              </div>
              <div className="flex items-center gap-2 p-2.5 bg-zinc-950 rounded-lg border border-amber-500/20 text-amber-300">
                <Clock className="w-4 h-4 shrink-0" />
                <span>Real-time sync on mutation · Phase 3</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: External Integrations (Explicitly identifying all unimplemented integrations) */}
      {activeTab === 'integrations' && (
        <div className="space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-zinc-800 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Share2 className="w-4 h-4 text-emerald-400" />
                  <span>External Channel & Social Publishing Integrations</span>
                </h3>
                <p className="text-xs text-zinc-500">
                  Status of third-party social media APIs, CRM systems, and workflow webhooks.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 text-[11px] font-semibold font-mono rounded-md bg-zinc-800 text-amber-400 border border-zinc-700">
                  PHASE 1 SCOPE: LOCAL WORKFLOW ONLY
                </span>
              </div>
            </div>

            {/* Architecture Notice */}
            <div className="p-3.5 bg-zinc-950 border border-zinc-800/80 rounded-lg text-xs text-zinc-400 flex items-start gap-2.5">
              <Radio className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 animate-pulse" />
              <div className="space-y-1">
                <span className="font-semibold text-zinc-200 block">
                  Honest Integration Status Notice (Anti-Fabrication Principle)
                </span>
                <p>
                  Per Phase 1 technical rules, no external social publishing APIs, CRM connectors, or video rendering pipelines are active or fabricated. Content is generated, formatted, audited, and scheduled internally. Official API tokens and automated dispatch pipelines will be configured in Phase 2.
                </p>
              </div>
            </div>

            {/* Integration Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {[
                { name: 'Meta Graph API', desc: 'Direct publishing to Instagram Reels, Feed & Facebook Pages', target: 'Phase 2' },
                { name: 'X / Twitter API v2', desc: 'Single-click publishing for single tweets and multi-post threads', target: 'Phase 2' },
                { name: 'LinkedIn Community API', desc: 'Direct post publishing to company pages and executive profiles', target: 'Phase 2' },
                { name: 'YouTube Data API v3', desc: 'Automated video and Shorts upload with tags and descriptions', target: 'Phase 2' },
                { name: 'TikTok Content Posting API', desc: 'Direct video dispatch with custom captions and sound metadata', target: 'Phase 2' },
                { name: 'Pinterest Marketing API', desc: 'Idea pin creation and visual board categorization', target: 'Phase 2' },
                { name: 'WhatsApp Business Cloud API', desc: 'Broadcast campaign distribution and audience messaging', target: 'Phase 2' },
                { name: 'HubSpot / Salesforce CRM', desc: 'Bidirectional sync of engagement, leads, and customer inquiries', target: 'Phase 2' },
                { name: 'Zapier & Webhook Dispatcher', desc: 'Event-driven triggers on post publication and schedule events', target: 'Phase 2' },
              ].map(item => (
                <div key={item.name} className="p-3 bg-zinc-950 rounded-lg border border-zinc-800/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200">{item.name}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
                      NOT CONNECTED · {item.target}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Reset Demo Data In-UI Modal */}
      {isConfirmingReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 text-amber-400 border-b border-zinc-800 pb-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-semibold text-zinc-100">
                Confirm Demo Data Reset
              </h3>
            </div>

            <div className="space-y-2 text-xs text-zinc-300">
              <p>
                Are you sure you want to reset all workspace data to default Phase 1 demo state?
              </p>
              <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 space-y-1">
                <span className="font-semibold text-zinc-300 block">Data Affected:</span>
                <p>
                  This will clear custom brand profiles, newly created drafts, and scheduled events in your browser's local storage and re-populate the original default demo dataset.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setIsConfirmingReset(false)}
                className="px-3.5 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReset}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold shadow-xs"
              >
                Reset to Demo Data
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
