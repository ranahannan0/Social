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
import { authedFetch } from '../services/authClient';
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
  // On success, replace local state with the server-side workspace. On empty
  // workspace (newly-signed-up user), auto-import the local demo seed so the
  // user sees familiar content and the cloud account is bootstrapped. On
  // failure, fall back to local state (the user can still see demo data and
  // retry the sync from Settings).
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
   * explicit "Sync to Cloud" action in Settings.
   */
  async function pushLocalToCloud(): Promise<{
    created: { brands: number; drafts: number; events: number; checks: number };
    skipped: { brands: number; drafts: number; events: number; checks: number };
    notes: string[];
    errors: string[];
  }> {
    const exportFile = {
      formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'localStorage' as const,
      data: {
        brands,
        drafts,
        calendarEvents,
        settings,
        activeBrandId,
      },
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

  // Sync state changes to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.BRANDS, JSON.stringify(brands));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [brands]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.DRAFTS, JSON.stringify(drafts));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [drafts]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(calendarEvents));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [calendarEvents]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_BRAND, activeBrandId);
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }, [activeBrandId]);

  const activeBrand = useMemo(() => {
    return brands.find(b => b.id === activeBrandId) || brands[0];
  }, [brands, activeBrandId]);

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
    return newBrand;
  };

  const updateBrand = (updated: BrandProfile) => {
    setBrands(prev =>
      prev.map(b => (b.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : b))
    );
  };

  const deleteBrand = (id: string) => {
    const res = cascadeDeleteBrand({
      brands,
      drafts,
      calendarEvents,
      activeBrandId,
      targetBrandId: id,
    });
    setBrands(res.brands);
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
    setActiveBrandId(res.activeBrandId);
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
    return newDraft;
  };

  const updateDraft = (updated: ContentDraft) => {
    setDrafts(prev =>
      prev.map(d => (d.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : d))
    );
  };

  const deleteDraft = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
    setCalendarEvents(prev => prev.filter(e => e.draftId !== id));
  };

  const scheduleDraft = (draftId: string, date: string, time: string) => {
    const res = syncScheduleDraft({
      drafts,
      calendarEvents,
      draftId,
      date,
      time,
    });
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
  };

  // Calendar actions
  const addCalendarEvent = (eventData: Omit<CalendarEvent, 'id'>): CalendarEvent => {
    const newEvent: CalendarEvent = {
      ...eventData,
      id: generateEntityId('event'),
    };
    setCalendarEvents(prev => [...prev, newEvent]);
    return newEvent;
  };

  const updateCalendarEvent = (updated: CalendarEvent) => {
    // Compute the merged event list once from the current render-scope state
    // (same guarantee the original code relied on for event handlers), then
    // reuse it for both state updates to avoid stale closures.
    const mergedEvents = calendarEvents.map(e => (e.id === updated.id ? updated : e));
    setCalendarEvents(mergedEvents);
    // If the event is linked to a draft, recompute the draft's schedule state
    // from ALL of its events so status and scheduledDate stay consistent even
    // when several events reference the same draft.
    if (updated.draftId) {
      setDrafts(prev => recomputeDraftScheduleState({ drafts: prev, calendarEvents: mergedEvents, draftId: updated.draftId! }));
    }
  };

  const deleteCalendarEvent = (id: string) => {
    const res = syncDeleteCalendarEvent({
      drafts,
      calendarEvents,
      targetEventId: id,
    });
    setDrafts(res.drafts);
    setCalendarEvents(res.calendarEvents);
  };

  const updateSettings = (newSettings: Partial<AppSettings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  const resetToDemoData = () => {
    const freshBrands = buildInitialBrands();
    setBrands(freshBrands);
    setDrafts(buildInitialDrafts());
    setCalendarEvents(buildInitialCalendarEvents());
    setSettings(DEFAULT_SETTINGS);
    setActiveBrandId(freshBrands[0].id);
    localStorage.removeItem(STORAGE_KEYS.BRANDS);
    localStorage.removeItem(STORAGE_KEYS.DRAFTS);
    localStorage.removeItem(STORAGE_KEYS.EVENTS);
    localStorage.removeItem(STORAGE_KEYS.SETTINGS);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_BRAND);
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
