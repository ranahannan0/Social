import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  BrandProfile,
  ContentDraft,
  CalendarEvent,
  AppSettings,
  PlatformType,
} from '../types';
import {
  cascadeDeleteBrand,
  syncDeleteCalendarEvent,
  syncScheduleDraft,
  calculateComplianceStats,
  recomputeDraftScheduleState,
  generateEntityId,
} from '../utils/dataIntegrity';
import {
  buildInitialBrands,
  buildInitialDrafts,
  buildInitialCalendarEvents,
} from '../services/constants';
import { authedFetch, hasValidSession } from '../services/authClient';
import {
  enqueueSync,
  isDbUuid,
  retrySync,
  drainSyncQueue,
  subscribeSync,
  brandSyncBody,
  draftSyncBody,
  eventSyncBody,
  type SyncState,
  type SyncTask,
} from '../services/cloudSync';
import { hydrateWorkspaceFromExport, HydrateError } from '../utils/workspaceHydrate';
import {
  WORKSPACE_EXPORT_FORMAT_VERSION,
  validateWorkspaceExport,
} from '../utils/workspaceFile';

interface AppContextType {
  activeSection: string;
  setActiveSection: (section: string) => void;
  brands: BrandProfile[];
  activeBrandId: string;
  setActiveBrandId: (id: string) => void;
  activeBrand: BrandProfile | undefined;
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  settings: AppSettings;
  addBrand: (brandData: Omit<BrandProfile, 'id' | 'createdAt' | 'updatedAt'>) => BrandProfile;
  updateBrand: (brand: BrandProfile) => void;
  deleteBrand: (id: string) => void;
  saveDraft: (draftData: Omit<ContentDraft, 'id' | 'createdAt' | 'updatedAt'>) => ContentDraft;
  updateDraft: (draft: ContentDraft) => void;
  deleteDraft: (id: string) => void;
  scheduleDraft: (draftId: string, date: string, time: string) => void;
  addCalendarEvent: (eventData: Omit<CalendarEvent, 'id'>) => CalendarEvent;
  updateCalendarEvent: (event: CalendarEvent) => void;
  deleteCalendarEvent: (id: string) => void;
  updateSettings: (newSettings: Partial<AppSettings>) => void;
  resetToDemoData: () => void;
  /**
   * Push the current local state to the cloud via /api/workspace/import.
   * Returns the import report on success. Throws on network/server error.
   */
  syncToCloud: () => Promise<{
    created: { brands: number; drafts: number; events: number; checks: number };
    skipped: { brands: number; drafts: number; events: number; checks: number };
    notes: string[];
    errors: string[];
  }>;
  /** Hydration status: 'idle' (pre-mount), 'loading', 'ready', 'error'. */
  hydrationStatus: 'idle' | 'loading' | 'ready' | 'error';
  hydrationError: string | null;
  /** True when a syncToCloud call is in flight. */
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncSummary: string | null;
  /** Stage B auto-sync: pending task count + last permanent error. */
  syncState: SyncState;
  /** Retry any pending cloud-sync tasks after a failure. */
  retryPendingSync: () => void;
  stats: {
    totalDrafts: number;
    readyDrafts: number;
    scheduledCount: number;
    totalBrands: number;
    evaluatedCount: number;
    compliancePassRate: number | null;
    hasEvaluatedContent: boolean;
    platformBreakdown: Record<PlatformType, number>;
  };
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const STORAGE_KEYS = {
  BRANDS: 'omni_plus_brands_v2',
  DRAFTS: 'omni_plus_drafts_v2',
  EVENTS: 'omni_plus_events_v2',
  SETTINGS: 'omni_plus_settings_v2',
  ACTIVE_BRAND: 'omni_plus_active_brand_v2',
};

const DEFAULT_SETTINGS: AppSettings = {
  workspaceName: 'Growth Core HQ',
  defaultBrandId: 'brand-01',
  defaultLanguage: 'English',
  timezone: 'Asia/Karachi (PKT, UTC+5)',
  enableFluffHighlighting: true,
  autoSaveDrafts: true,
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeSection, setActiveSection] = useState<string>('dashboard');

  // Hydration lifecycle. AppProvider is mounted AFTER the auth boot probe
  // resolves a user (see App.tsx SessionGate), so by the time this effect
  // runs we know there is a valid JWT in sessionStorage.
  const [hydrationStatus, setHydrationStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [hydrationError, setHydrationError] = useState<string | null>(null);

  // Sync status for the explicit "Sync to Cloud" action in Settings.
  const [syncing, setSyncing] = useState<boolean>(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  // Stage B auto-sync: subscription to the cloudSync engine's queue state.
  const [syncState, setSyncState] = useState<SyncState>(() => ({ pending: 0, lastError: null }));
  useEffect(() => subscribeSync(setSyncState), []);

  // Load from LocalStorage with clean initial fallback
  // Seed factories build dates relative to the actual current date, so the
  // demo workspace never opens on a frozen calendar month.
  const [brands, setBrands] = useState<BrandProfile[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.BRANDS);
      return stored ? JSON.parse(stored) : buildInitialBrands();
    } catch {
      return buildInitialBrands();
    }
  });

  const [activeBrandId, setActiveBrandId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.ACTIVE_BRAND);
      if (stored && brands.some(b => b.id === stored)) return stored;
      return brands[0]?.id || 'brand-01';
    } catch {
      return 'brand-01';
    }
  });

  const [drafts, setDrafts] = useState<ContentDraft[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.DRAFTS);
      return stored ? JSON.parse(stored) : buildInitialDrafts();
    } catch {
      return buildInitialDrafts();
    }
  });

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.EVENTS);
      return stored ? JSON.parse(stored) : buildInitialCalendarEvents();
    } catch {
      return buildInitialCalendarEvents();
    }
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // ── Cloud hydration: fetch /api/workspace/export on mount ───────────────
  // On success, replace local state with the server-side workspace (DB UUIDs
  // — from here on every mutation can target a real cloud row). On empty
  // workspace (newly-signed-up user), auto-import the local demo seed, then
  // RE-FETCH so the session adopts the cloud-generated ids immediately. On
  // failure, fall back to local state (the user can still see demo data and
  // retry the sync from Settings).

  /** One-time retirement of the localStorage namespace (Stage B). */
  function retireLocalStorage(): void {
    try {
      for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
    } catch {
      // private-browsing mode — nothing to retire
    }
  }

  /** Fetch the cloud workspace and replace local state with it (UUID adoption). */
  async function fetchAndApplyCloudWorkspace(): Promise<void> {
    const res = await authedFetch('/api/workspace/export');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.message || `Export failed (status ${res.status}).`);
    }
    const data = await res.json();
    const hydrated = hydrateWorkspaceFromExport(data);
    if (hydrated.organizationId === null) return; // still empty — nothing to adopt
    setBrands(hydrated.brands.length > 0 ? hydrated.brands : buildInitialBrands());
    setDrafts(hydrated.drafts);
    setCalendarEvents(hydrated.calendarEvents);
    setSettings(hydrated.settings);
    if (hydrated.activeBrandId) {
      setActiveBrandId(hydrated.activeBrandId);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHydrationStatus('loading');
      setHydrationError(null);
      try {
        const res = await authedFetch('/api/workspace/export');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.message || `Export failed (status ${res.status}).`);
        }
        const data = await res.json();
        const hydrated = hydrateWorkspaceFromExport(data);
        if (cancelled) return;
        if (hydrated.organizationId === null) {
          // Empty cloud workspace — bootstrap from local demo seed.
          try {
            await bootstrapEmptyCloud();
            if (cancelled) return;
            // Adopt the cloud-generated UUIDs right away so Stage B
            // mutations target real rows instead of legacy local ids.
            await fetchAndApplyCloudWorkspace();
            if (cancelled) return;
            retireLocalStorage();
            setHydrationStatus('ready');
            setLastSyncAt(new Date().toISOString());
            setLastSyncSummary('Cloud workspace bootstrapped with demo content.');
          } catch (bootErr) {
            if (cancelled) return;
            // Bootstrap failed — keep local demo data, surface a soft warning.
            console.warn('[AppContext] cloud bootstrap failed:', bootErr);
            setHydrationStatus('ready');
            setLastSyncSummary('Cloud workspace empty; showing local demo data. Use Sync to push.');
          }
          return;
        }
        // Replace local state with the server-side workspace.
        setBrands(hydrated.brands.length > 0 ? hydrated.brands : buildInitialBrands());
        setDrafts(hydrated.drafts);
        setCalendarEvents(hydrated.calendarEvents);
        setSettings(hydrated.settings);
        if (hydrated.activeBrandId) {
          setActiveBrandId(hydrated.activeBrandId);
        }
        retireLocalStorage();
        setHydrationStatus('ready');
      } catch (err) {
        if (cancelled) return;
        console.warn('[AppContext] hydration failed:', err);
        setHydrationStatus('error');
        setHydrationError(err instanceof Error ? err.message : 'Unknown hydration error.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Build a Phase 1.5 export file from the current local state and POST it
   * to /api/workspace/import. Used both for first-login bootstrap and the
   * explicit "Sync to Cloud" action in Settings. An `explicit` data bundle
   * overrides the render-scope state (workspace reset pushes fresh seeds).
   */
  async function pushLocalToCloud(explicit?: {
    brands: BrandProfile[];
    drafts: ContentDraft[];
    calendarEvents: CalendarEvent[];
    settings: AppSettings;
    activeBrandId: string;
  }): Promise<{
    created: { brands: number; drafts: number; events: number; checks: number };
    skipped: { brands: number; drafts: number; events: number; checks: number };
    notes: string[];
    errors: string[];
  }> {
    const src = explicit ?? { brands, drafts, calendarEvents, settings, activeBrandId };
    const exportFile = {
      formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'localStorage' as const,
      data: src,
    };
    // Validate locally first so we never push a malformed file.
    const validation = validateWorkspaceExport(exportFile);
    if (!validation.ok) {
      throw new Error(
        'Local workspace failed validation: ' +
          validation.issues.map(i => `${i.field} (${i.problem})`).join('; ')
      );
    }
    const res = await authedFetch('/api/workspace/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportFile),
    });
    if (res.status === 501) {
      throw new Error('Cloud storage is not configured on the server.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) {
      throw new Error(body?.message || `Import failed (status ${res.status}).`);
    }
    return {
      created: body?.created ?? { brands: 0, drafts: 0, events: 0, checks: 0 },
      skipped: body?.skipped ?? { brands: 0, drafts: 0, events: 0, checks: 0 },
      notes: body?.notes ?? [],
      errors: body?.errors ?? [],
    };
  }

  /** First-login bootstrap: push the local demo seed to the empty cloud. */
  async function bootstrapEmptyCloud(): Promise<void> {
    await pushLocalToCloud();
  }

  const syncToCloud = async () => {
    setSyncing(true);
    try {
      const report = await pushLocalToCloud();
      setLastSyncAt(new Date().toISOString());
      const total =
        report.created.brands + report.created.drafts + report.created.events + report.created.checks;
      const skipped =
        report.skipped.brands + report.skipped.drafts + report.skipped.events + report.skipped.checks;
      setLastSyncSummary(
        `Synced: ${total} new, ${skipped} unchanged.` +
          (report.errors.length > 0 ? ` ${report.errors.length} error(s).` : '')
      );
      return report;
    } finally {
      setSyncing(false);
    }
  };

  // Sync state changes to localStorage — RETIRED in cloud sessions (Stage B):
  // once a valid session exists, the cloud is the single source of truth and
  // the omni_plus_* keys are cleared during hydration. Local writes remain
  // only as a defensive fallback for a hypothetical unauthenticated mount.
  useEffect(() => {
    if (hasValidSession()) return;
    try {
      localStorage.setItem(STORAGE_KEYS.BRANDS, JSON.stringify(brands));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [brands]);

  useEffect(() => {
    if (hasValidSession()) return;
    try {
      localStorage.setItem(STORAGE_KEYS.DRAFTS, JSON.stringify(drafts));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [drafts]);

  useEffect(() => {
    if (hasValidSession()) return;
    try {
      localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(calendarEvents));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [calendarEvents]);

  useEffect(() => {
    if (hasValidSession()) return;
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [settings]);

  useEffect(() => {
    if (hasValidSession()) return;
    try {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_BRAND, activeBrandId);
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [activeBrandId]);

  const activeBrand = useMemo(() => {
    return brands.find(b => b.id === activeBrandId) || brands[0];
  }, [brands, activeBrandId]);

  // ── Stage B auto-sync wiring ────────────────────────────────────────────
  // Every mutation applies locally FIRST (the UI never waits on the network),
  // then enqueues a cloud task. Tasks only flow once hydration established
  // the workspace; only DB-shaped (UUID) ids are ever sent — legacy local ids
  // are intentionally skipped and left to the full "Sync to Cloud" repair.
  const cloudReady = hydrationStatus === 'ready';

  function adoptBrandRow(localId: string, row: Record<string, unknown>): void {
    const dbId = typeof row.id === 'string' ? row.id : null;
    if (!dbId || dbId === localId) return;
    const stamp = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
    setBrands(prev =>
      prev.map(b =>
        b.id === localId
          ? { ...b, id: dbId, createdAt: stamp(row.created_at, b.createdAt), updatedAt: stamp(row.updated_at, b.updatedAt) }
          : b
      )
    );
    setDrafts(prev => prev.map(d => (d.brandId === localId ? { ...d, brandId: dbId } : d)));
    setCalendarEvents(prev => prev.map(e => (e.brandId === localId ? { ...e, brandId: dbId } : e)));
    setActiveBrandId(prev => (prev === localId ? dbId : prev));
  }

  function adoptDraftRow(localId: string, row: Record<string, unknown>): void {
    const dbId = typeof row.id === 'string' ? row.id : null;
    if (!dbId || dbId === localId) return;
    const stamp = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
    setDrafts(prev =>
      prev.map(d =>
        d.id === localId
          ? { ...d, id: dbId, createdAt: stamp(row.created_at, d.createdAt), updatedAt: stamp(row.updated_at, d.updatedAt) }
          : d
      )
    );
    setCalendarEvents(prev => prev.map(e => (e.draftId === localId ? { ...e, draftId: dbId } : e)));
  }

  function adoptEventRow(localId: string, row: Record<string, unknown>): void {
    const dbId = typeof row.id === 'string' ? row.id : null;
    if (!dbId || dbId === localId) return;
    setCalendarEvents(prev => prev.map(e => (e.id === localId ? { ...e, id: dbId } : e)));
  }

  /** Diff two event snapshots and enqueue create/update/delete cloud ops. */
  function enqueueEventOps(before: CalendarEvent[], after: CalendarEvent[]): void {
    const beforeMap = new Map(before.map(e => [e.id, e]));
    for (const e of after) {
      const b = beforeMap.get(e.id);
      if (!b) {
        if (isDbUuid(e.brandId)) {
          enqueueSync({
            kind: 'event',
            op: 'create',
            localId: e.id,
            body: eventSyncBody(e),
            onAck: row => adoptEventRow(e.id, row),
          });
        }
      } else if (JSON.stringify(b) !== JSON.stringify(e)) {
        if (isDbUuid(e.id)) enqueueSync({ kind: 'event', op: 'update', id: e.id, body: eventSyncBody(e) });
      }
    }
    const afterIds = new Set(after.map(e => e.id));
    for (const b of before) {
      if (!afterIds.has(b.id) && isDbUuid(b.id)) enqueueSync({ kind: 'event', op: 'delete', id: b.id });
    }
  }

  // Brand actions
  const addBrand = (brandData: Omit<BrandProfile, 'id' | 'createdAt' | 'updatedAt'>): BrandProfile => {
    const newBrand: BrandProfile = {
      ...brandData,
      id: generateEntityId('brand'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setBrands(prev => [newBrand, ...prev]);
    setActiveBrandId(newBrand.id);
    if (cloudReady) {
      enqueueSync({
        kind: 'brand',
        op: 'create',
        localId: newBrand.id,
        body: brandSyncBody(newBrand),
        onAck: row => adoptBrandRow(newBrand.id, row),
      });
    }
    return newBrand;
  };

  const updateBrand = (updated: BrandProfile) => {
    const next = { ...updated, updatedAt: new Date().toISOString() };
    setBrands(prev => prev.map(b => (b.id === next.id ? next : b)));
    if (isDbUuid(next.id)) enqueueSync({ kind: 'brand', op: 'update', id: next.id, body: brandSyncBody(next) });
  };

  const deleteBrand = (id: string) => {
    const res = cascadeDeleteBrand({
      brands,
      drafts,
      calendarEvents,
      activeBrandId,
      targetBrandId: id,
    });
    const removed = res.brands.length !== brands.length;
    setBrands(res.brands);
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
    setActiveBrandId(res.activeBrandId);
    // A single delete op is enough: DB FKs cascade the brand's drafts,
    // events and checks server-side (per-child deletes would just 404).
    if (removed && isDbUuid(id)) enqueueSync({ kind: 'brand', op: 'delete', id });
  };

  // Draft actions
  const saveDraft = (draftData: Omit<ContentDraft, 'id' | 'createdAt' | 'updatedAt'>): ContentDraft => {
    const newDraft: ContentDraft = {
      ...draftData,
      id: generateEntityId('draft'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setDrafts(prev => [newDraft, ...prev]);
    if (cloudReady && isDbUuid(newDraft.brandId)) {
      enqueueSync({
        kind: 'draft',
        op: 'create',
        localId: newDraft.id,
        body: draftSyncBody(newDraft),
        onAck: row => adoptDraftRow(newDraft.id, row),
      });
    }
    return newDraft;
  };

  const updateDraft = (updated: ContentDraft) => {
    const next = { ...updated, updatedAt: new Date().toISOString() };
    setDrafts(prev => prev.map(d => (d.id === next.id ? next : d)));
    if (!isDbUuid(next.id)) return;
    const body = draftSyncBody(next) as Record<string, unknown>;
    // Only carry complianceStatus when it actually changed — otherwise every
    // unrelated edit would append a duplicate compliance_checks row.
    const prevDraft = drafts.find(d => d.id === next.id);
    if (
      prevDraft &&
      JSON.stringify(prevDraft.complianceStatus ?? null) === JSON.stringify(next.complianceStatus ?? null)
    ) {
      delete body.complianceStatus;
    }
    enqueueSync({ kind: 'draft', op: 'update', id: next.id, body });
  };

  const deleteDraft = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
    setCalendarEvents(prev => prev.filter(e => e.draftId !== id));
    // Server-side cascade removes the draft's events + checks.
    if (isDbUuid(id)) enqueueSync({ kind: 'draft', op: 'delete', id });
  };

  const scheduleDraft = (draftId: string, date: string, time: string) => {
    const beforeEvents = calendarEvents;
    const res = syncScheduleDraft({
      drafts,
      calendarEvents,
      draftId,
      date,
      time,
    });
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
    const nextDraft = res.drafts.find(d => d.id === draftId);
    if (nextDraft && isDbUuid(draftId)) {
      enqueueSync({ kind: 'draft', op: 'update', id: draftId, body: draftSyncBody(nextDraft) });
    }
    enqueueEventOps(beforeEvents, res.calendarEvents);
  };

  // Calendar actions
  const addCalendarEvent = (eventData: Omit<CalendarEvent, 'id'>): CalendarEvent => {
    const newEvent: CalendarEvent = {
      ...eventData,
      id: generateEntityId('event'),
    };
    setCalendarEvents(prev => [...prev, newEvent]);
    if (cloudReady && isDbUuid(newEvent.brandId)) {
      enqueueSync({
        kind: 'event',
        op: 'create',
        localId: newEvent.id,
        body: eventSyncBody(newEvent),
        onAck: row => adoptEventRow(newEvent.id, row),
      });
    }
    return newEvent;
  };

  const updateCalendarEvent = (updated: CalendarEvent) => {
    // Compute merged events + recomputed drafts once from render-scope state
    // (same guarantee the original code relied on), then reuse the results
    // for BOTH state updates and cloud ops — no stale closures.
    const beforeDrafts = drafts;
    const mergedEvents = calendarEvents.map(e => (e.id === updated.id ? updated : e));
    let nextDrafts = drafts;
    if (updated.draftId) {
      nextDrafts = recomputeDraftScheduleState({
        drafts,
        calendarEvents: mergedEvents,
        draftId: updated.draftId,
      });
    }
    setCalendarEvents(mergedEvents);
    if (updated.draftId) {
      setDrafts(nextDrafts);
    }
    if (isDbUuid(updated.id)) {
      enqueueSync({ kind: 'event', op: 'update', id: updated.id, body: eventSyncBody(updated) });
    }
    if (updated.draftId && isDbUuid(updated.draftId)) {
      const before = beforeDrafts.find(d => d.id === updated.draftId);
      const next = nextDrafts.find(d => d.id === updated.draftId);
      if (before && next && (before.status !== next.status || before.scheduledDate !== next.scheduledDate)) {
        enqueueSync({ kind: 'draft', op: 'update', id: next.id, body: draftSyncBody(next) });
      }
    }
  };

  const deleteCalendarEvent = (id: string) => {
    const target = calendarEvents.find(e => e.id === id);
    const res = syncDeleteCalendarEvent({
      drafts,
      calendarEvents,
      targetEventId: id,
    });
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
    if (isDbUuid(id)) enqueueSync({ kind: 'event', op: 'delete', id });
    // The recompute may have demoted the linked draft back to 'ready'.
    if (target?.draftId && isDbUuid(target.draftId)) {
      const before = drafts.find(d => d.id === target.draftId);
      const next = res.drafts.find(d => d.id === target.draftId);
      if (before && next && (before.status !== next.status || before.scheduledDate !== next.scheduledDate)) {
        enqueueSync({ kind: 'draft', op: 'update', id: next.id, body: draftSyncBody(next) });
      }
    }
  };

  const updateSettings = (newSettings: Partial<AppSettings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  const resetToDemoData = () => {
    const cloudBrandIds = brands.filter(b => isDbUuid(b.id)).map(b => b.id);
    const freshBrands = buildInitialBrands();
    const freshDrafts = buildInitialDrafts();
    const freshEvents = buildInitialCalendarEvents();
    setBrands(freshBrands);
    setDrafts(freshDrafts);
    setCalendarEvents(freshEvents);
    setSettings(DEFAULT_SETTINGS);
    setActiveBrandId(freshBrands[0].id);
    retireLocalStorage();
    if (!cloudReady || cloudBrandIds.length === 0) return;
    // Cloud mode: wipe the workspace (each brand delete cascades its drafts
    // and events), then re-seed the fresh demo content as a full import and
    // adopt the new cloud ids.
    void (async () => {
      try {
        for (const bid of cloudBrandIds) enqueueSync({ kind: 'brand', op: 'delete', id: bid });
        await drainSyncQueue();
        await pushLocalToCloud({
          brands: freshBrands,
          drafts: freshDrafts,
          calendarEvents: freshEvents,
          settings: DEFAULT_SETTINGS,
          activeBrandId: freshBrands[0].id,
        });
        await fetchAndApplyCloudWorkspace();
        setLastSyncAt(new Date().toISOString());
        setLastSyncSummary('Workspace reset — demo content restored to the cloud.');
      } catch (err) {
        console.warn('[AppContext] cloud reset failed:', err);
        setLastSyncSummary('Workspace reset locally; cloud reset failed. Use Sync to repair.');
      }
    })();
  };

  // Statistics calculation for the Dashboard
  const stats = useMemo(() => {
    return calculateComplianceStats({ drafts, calendarEvents, brands });
  }, [drafts, calendarEvents, brands]);

  return (
    <AppContext.Provider
      value={{
        activeSection,
        setActiveSection,
        brands,
        activeBrandId,
        setActiveBrandId,
        activeBrand,
        drafts,
        calendarEvents,
        settings,
        addBrand,
        updateBrand,
        deleteBrand,
        saveDraft,
        updateDraft,
        deleteDraft,
        scheduleDraft,
        addCalendarEvent,
        updateCalendarEvent,
        deleteCalendarEvent,
        updateSettings,
        resetToDemoData,
        syncToCloud,
        hydrationStatus,
        hydrationError,
        syncing,
        lastSyncAt,
        lastSyncSummary,
        syncState,
        retryPendingSync: retrySync,
        stats,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
