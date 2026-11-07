export type PlatformType =
  | 'linkedin'
  | 'x'
  | 'instagram_reels'
  | 'instagram_feed'
  | 'youtube'
  | 'tiktok'
  | 'pinterest'
  | 'whatsapp'
  | 'email'
  | 'blog_seo';

export type MarketingObjective =
  | 'Awareness'
  | 'Lead Gen'
  | 'Authority'
  | 'Sales'
  | 'Engagement';

export type SupportedLanguage =
  | 'English'
  | 'Roman Urdu'
  | 'Urdu (Script)'
  | 'Hindi'
  | 'Spanish'
  | 'Arabic';

export interface ProductOrService {
  id: string;
  name: string;
  description: string;
  tierOrPrice?: string;
}

export interface BrandProfile {
  id: string;
  name: string;
  tagline: string;
  industry: string;
  website?: string;
  targetAudience: string;
  brandVoice: {
    tone: string;
    bannedWords: string[];
    styleGuidelines: string;
    sampleCopy: string;
  };
  preferredLanguage: SupportedLanguage;
  productsAndServices: ProductOrService[];
  createdAt: string;
  updatedAt: string;
}

export type HookType = 'patternInterrupt' | 'curiosityGap' | 'directBenefit';

export interface HookVariations {
  patternInterrupt: string;
  curiosityGap: string;
  directBenefit: string;
}

export interface ComplianceCheckResult {
  passed: boolean;
  detectedFluff: string[];
  charCount: number;
  maxLimit: number;
  warnings: string[];
}

export type ContentStatus = 'draft' | 'ready' | 'scheduled';

export interface ContentDraft {
  id: string;
  brandId: string;
  title: string;
  topic: string;
  platform: PlatformType;
  objective: MarketingObjective;
  language: SupportedLanguage;
  audience: string;
  selectedHookType: HookType;
  hooks: HookVariations;
  caption: string;
  callToAction: string;
  hashtags: string[];
  visualDirection?: string;
  keyTakeaways?: string[];
  status: ContentStatus;
  scheduledDate?: string;
  complianceStatus: ComplianceCheckResult;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  draftId?: string;
  brandId: string;
  title: string;
  platform: PlatformType;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  status: 'draft' | 'scheduled';
  summary?: string;
}

export interface AppSettings {
  workspaceName: string;
  defaultBrandId: string;
  defaultLanguage: SupportedLanguage;
  timezone: string;
  enableFluffHighlighting: boolean;
  autoSaveDrafts: boolean;
}

export interface PlatformMetadata {
  id: PlatformType;
  label: string;
  category: 'social' | 'video' | 'editorial' | 'messaging';
  maxChars: number;
  aspectRatio: string;
  hashtagStrategy: string;
  iconName: string;
  safeZoneNote?: string;
}
