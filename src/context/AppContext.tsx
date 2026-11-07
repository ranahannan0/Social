import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  BrandProfile,
  ContentDraft,
  CalendarEvent,
  AppSettings,
  PlatformType,
} from '../types';
import {
  INITIAL_BRANDS,
  INITIAL_DRAFTS,
  INITIAL_CALENDAR_EVENTS,
} from '../services/constants';

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
  stats: {
    totalDrafts: number;
    readyDrafts: number;
    scheduledCount: number;
    totalBrands: number;
    compliancePassRate: number;
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

  // Load from LocalStorage with clean initial fallback
  const [brands, setBrands] = useState<BrandProfile[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.BRANDS);
      return stored ? JSON.parse(stored) : INITIAL_BRANDS;
    } catch {
      return INITIAL_BRANDS;
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
      return stored ? JSON.parse(stored) : INITIAL_DRAFTS;
    } catch {
      return INITIAL_DRAFTS;
    }
  });

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.EVENTS);
      return stored ? JSON.parse(stored) : INITIAL_CALENDAR_EVENTS;
    } catch {
      return INITIAL_CALENDAR_EVENTS;
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
      id: `brand-${Date.now()}`,
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
    if (brands.length <= 1) {
      return; // Keep at least one brand
    }
    const filtered = brands.filter(b => b.id !== id);
    setBrands(filtered);
    if (activeBrandId === id) {
      setActiveBrandId(filtered[0]?.id || '');
    }
  };

  // Draft actions
  const saveDraft = (draftData: Omit<ContentDraft, 'id' | 'createdAt' | 'updatedAt'>): ContentDraft => {
    const newDraft: ContentDraft = {
      ...draftData,
      id: `draft-${Date.now()}`,
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
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    // Update draft status
    const scheduledDateIso = `${date}T${time}:00`;
    updateDraft({
      ...draft,
      status: 'scheduled',
      scheduledDate: scheduledDateIso,
    });

    // Create or update calendar event
    const existingIndex = calendarEvents.findIndex(e => e.draftId === draftId);
    if (existingIndex >= 0) {
      const updatedEvents = [...calendarEvents];
      updatedEvents[existingIndex] = {
        ...updatedEvents[existingIndex],
        date,
        time,
        status: 'scheduled',
      };
      setCalendarEvents(updatedEvents);
    } else {
      addCalendarEvent({
        draftId: draft.id,
        brandId: draft.brandId,
        title: draft.title,
        platform: draft.platform,
        date,
        time,
        status: 'scheduled',
        summary: draft.caption.slice(0, 100),
      });
    }
  };

  // Calendar actions
  const addCalendarEvent = (eventData: Omit<CalendarEvent, 'id'>): CalendarEvent => {
    const newEvent: CalendarEvent = {
      ...eventData,
      id: `event-${Date.now()}`,
    };
    setCalendarEvents(prev => [...prev, newEvent]);
    return newEvent;
  };

  const updateCalendarEvent = (updated: CalendarEvent) => {
    setCalendarEvents(prev => prev.map(e => (e.id === updated.id ? updated : e)));
  };

  const deleteCalendarEvent = (id: string) => {
    setCalendarEvents(prev => prev.filter(e => e.id !== id));
  };

  const updateSettings = (newSettings: Partial<AppSettings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  const resetToDemoData = () => {
    setBrands(INITIAL_BRANDS);
    setDrafts(INITIAL_DRAFTS);
    setCalendarEvents(INITIAL_CALENDAR_EVENTS);
    setSettings(DEFAULT_SETTINGS);
    setActiveBrandId(INITIAL_BRANDS[0].id);
    localStorage.removeItem(STORAGE_KEYS.BRANDS);
    localStorage.removeItem(STORAGE_KEYS.DRAFTS);
    localStorage.removeItem(STORAGE_KEYS.EVENTS);
    localStorage.removeItem(STORAGE_KEYS.SETTINGS);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_BRAND);
  };

  // Statistics calculation for the Dashboard
  const stats = useMemo(() => {
    const total = drafts.length;
    const ready = drafts.filter(d => d.status === 'ready').length;
    const scheduled = calendarEvents.filter(e => e.status === 'scheduled').length;
    const passedCompliance = drafts.filter(d => d.complianceStatus?.passed).length;
    const rate = total > 0 ? Math.round((passedCompliance / total) * 100) : 100;

    const breakdown: Record<PlatformType, number> = {
      linkedin: 0,
      x: 0,
      instagram_reels: 0,
      instagram_feed: 0,
      youtube: 0,
      tiktok: 0,
      pinterest: 0,
      whatsapp: 0,
      email: 0,
      blog_seo: 0,
    };

    drafts.forEach(d => {
      if (breakdown[d.platform] !== undefined) {
        breakdown[d.platform]++;
      }
    });

    return {
      totalDrafts: total,
      readyDrafts: ready,
      scheduledCount: scheduled,
      totalBrands: brands.length,
      compliancePassRate: rate,
      platformBreakdown: breakdown,
    };
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
