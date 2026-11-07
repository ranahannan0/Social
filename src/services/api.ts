export interface GenerateRequestPayload {
  topic: string;
  platform: string;
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
  source: 'gemini-3.8-flash' | 'local_deterministic_engine';
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
    const res = await fetch('/api/health');
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    return res.json();
  },

  async getAiStatus(): Promise<AiStatusResponse> {
    const res = await fetch('/api/ai-status');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `AI status check failed with code ${res.status}`);
    }
    return res.json();
  },

  async generateContent(payload: GenerateRequestPayload): Promise<GenerateResponsePayload> {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Generation failed with status ${res.status}`);
    }

    return res.json();
  },
};
