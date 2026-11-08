import { authedFetch } from './authClient';

export interface GenerateRequestPayload {
  topic: string;
  platform?: string;
  audience?: string;
  objective?: string;
  language?: string;
  brandName?: string;
  brandVoice?: {
    tone?: string;
    bannedWords?: string[];
    styleGuidelines?: string;
  };
  customInstructions?: string;
}

export interface GenerateResponsePayload {
  success: boolean;
  source: string;
  isFallback?: boolean;
  fallbackReason?: string;
  note?: string;
  data: {
    title: string;
    hooks: {
      patternInterrupt: string;
      curiosityGap: string;
      directBenefit: string;
    };
    primaryCaption: string;
    callToAction: string;
    hashtags: string[];
    keyTakeaways: string[];
    targetAudienceNote: string;
    visualDirection: string;
    detectedFluff: string[];
    platformLimit: number;
    charCount: number;
    generatedAt: string;
  };
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  aiConfigured: boolean;
  model: string;
  version: string;
  storageMode: string;
  supabaseReady: boolean;
}

export interface AiStatusResponse {
  connected: boolean;
  message: string;
  model: string;
  testedAt: string;
  latencyMs: number | null;
  responseSample?: string;
}

export const apiService = {
  async getHealth(): Promise<HealthResponse> {
    // Health is intentionally unauthenticated — it reports the server's mode
    // (local vs supabase) before the user has logged in, so the AuthScreen
    // can decide whether to show "cloud active" or "local-only" copy.
    const res = await fetch('/api/health');
    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }
    return res.json();
  },

  async getAiStatus(): Promise<AiStatusResponse> {
    // /api/ai-status is unauthenticated in both modes (it doesn't touch the
    // workspace, just probes the upstream Gemini key). Authed fetch is used
    // anyway so that in supabase mode the JWT is sent — server may apply
    // per-org quotas in a future release.
    const res = await authedFetch('/api/ai-status');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `AI status check failed with status ${res.status}`);
    }
    return res.json();
  },

  async generateContent(payload: GenerateRequestPayload): Promise<GenerateResponsePayload> {
    // /api/generate is auth-gated in supabase mode (per design doc §9). In
    // local mode the gate is a no-op, so this call keeps working in the
    // integration test harness without auth.
    const res = await authedFetch('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        throw new Error('Your session has expired. Please sign in again.');
      }
      if (res.status === 429) {
        throw new Error(err.error || 'Rate limit exceeded: Please wait a minute before generating again.');
      }
      if (err.validationErrors && Array.isArray(err.validationErrors)) {
        const detailStr = err.validationErrors.map((v: any) => `${v.field}: ${v.message}`).join(', ');
        throw new Error(`Validation Error: ${detailStr}`);
      }
      throw new Error(err.error || `Generation failed with status ${res.status}`);
    }

    return res.json();
  },
};
