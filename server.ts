import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Security: Disable Express fingerprinting
app.disable('x-powered-by');

// Security: Configure trust proxy for Cloud Run and reverse-proxy deployment environments
app.set('trust proxy', 1);

// Security: Apply security headers via helmet
// Allow iframe embedding in Google AI Studio and Vite inline scripts in dev
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: false, // Required for AI Studio iframe preview
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Security: Reduce JSON request body size limit to 64kb (appropriate for text-only inputs)
app.use(express.json({ limit: '64kb' }));

// Environment configuration
const configuredModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const rawApiKey = (process.env.GEMINI_API_KEY || '').trim();

// Treat empty string or default example placeholder as unconfigured
const isKeyConfigured = Boolean(
  rawApiKey && rawApiKey !== '' && rawApiKey !== 'MY_GEMINI_API_KEY'
);

// Initialize Gemini SDK with User-Agent telemetry if real key is configured
const ai = isKeyConfigured
  ? new GoogleGenAI({
      apiKey: rawApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Supported domain enums for validation
const SUPPORTED_PLATFORMS = [
  'linkedin',
  'x',
  'instagram_reels',
  'instagram_feed',
  'youtube',
  'tiktok',
  'pinterest',
  'whatsapp',
  'email',
  'blog_seo',
] as const;

const SUPPORTED_LANGUAGES = [
  'English',
  'Roman Urdu',
  'Urdu (Script)',
  'Hindi',
  'Spanish',
  'Arabic',
] as const;

const SUPPORTED_OBJECTIVES = [
  'Awareness',
  'Lead Gen',
  'Authority',
  'Sales',
  'Engagement',
] as const;

// Banned AI Fluff Phrases as codified in Omni Channel Plus v2.0 Spec Appendix
const BANNED_PHRASES = [
  "in today's fast-paced world",
  "it's important to note",
  "delve into",
  "tapestry",
  "game-changer",
  "revolutionary",
  "cutting-edge",
  "at the forefront",
  "i'm excited to share",
  "thrilled to announce",
  "in the realm of",
  "navigating the complexities of",
  "a testament to",
  "in conclusion",
  "when it comes to",
  "leverage",
];

function detectBannedPhrases(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter(phrase => lower.includes(phrase));
}

// Platform Character & Safe Zone limits per Spec Section 2.1
const PLATFORM_LIMITS: Record<string, { maxChars: number; defaultHashtags: number; safeZoneNote?: string }> = {
  linkedin: { maxChars: 3000, defaultHashtags: 3 },
  x: { maxChars: 280, defaultHashtags: 2 },
  instagram_reels: { maxChars: 2200, defaultHashtags: 8, safeZoneNote: 'Top 180px & bottom 450px reserved for UI' },
  instagram_feed: { maxChars: 2200, defaultHashtags: 8 },
  youtube: { maxChars: 5000, defaultHashtags: 5 },
  tiktok: { maxChars: 2200, defaultHashtags: 4, safeZoneNote: 'Top 150px & bottom 400px reserved for UI' },
  pinterest: { maxChars: 500, defaultHashtags: 4 },
  whatsapp: { maxChars: 1024, defaultHashtags: 0 },
  email: { maxChars: 10000, defaultHashtags: 0 },
  blog_seo: { maxChars: 25000, defaultHashtags: 0 },
};

// Rate limiter: 10 generation requests per minute per IP
const generateRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Maximum 10 generation requests per minute allowed.',
      retryAfterSeconds: 60,
    });
  },
});

// Helper with timeout to prevent hanging if external connection experiences latency
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs)),
  ]);
}

// Validation interface
interface ValidationErrorDetail {
  field: string;
  message: string;
}

// Middleware: Strict request body validation for /api/generate
function validateGenerateRequest(req: Request, res: Response, next: NextFunction) {
  const errors: ValidationErrorDetail[] = [];
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: 'Invalid request payload: expected JSON object.',
      validationErrors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    });
  }

  // 1. Topic validation (required, string, 1-300 chars)
  if (typeof body.topic !== 'string') {
    errors.push({ field: 'topic', message: 'Topic is required and must be a string' });
  } else {
    const trimmed = body.topic.trim();
    if (trimmed.length === 0) {
      errors.push({ field: 'topic', message: 'Topic cannot be empty or whitespace' });
    } else if (trimmed.length > 300) {
      errors.push({ field: 'topic', message: 'Topic cannot exceed 300 characters' });
    }
  }

  // 2. Audience validation (optional string, max 300 chars)
  if (body.audience !== undefined && body.audience !== null) {
    if (typeof body.audience !== 'string') {
      errors.push({ field: 'audience', message: 'Audience must be a string' });
    } else if (body.audience.length > 300) {
      errors.push({ field: 'audience', message: 'Audience cannot exceed 300 characters' });
    }
  }

  // 3. Brand name validation (optional string, max 100 chars)
  if (body.brandName !== undefined && body.brandName !== null) {
    if (typeof body.brandName !== 'string') {
      errors.push({ field: 'brandName', message: 'Brand name must be a string' });
    } else if (body.brandName.length > 100) {
      errors.push({ field: 'brandName', message: 'Brand name cannot exceed 100 characters' });
    }
  }

  // 4. Custom instructions validation (optional string, max 1000 chars)
  if (body.customInstructions !== undefined && body.customInstructions !== null) {
    if (typeof body.customInstructions !== 'string') {
      errors.push({ field: 'customInstructions', message: 'Custom instructions must be a string' });
    } else if (body.customInstructions.length > 1000) {
      errors.push({ field: 'customInstructions', message: 'Custom instructions cannot exceed 1000 characters' });
    }
  }

  // 5. Platform validation (must be in SUPPORTED_PLATFORMS)
  if (body.platform !== undefined && body.platform !== null) {
    if (typeof body.platform !== 'string' || !SUPPORTED_PLATFORMS.includes(body.platform as any)) {
      errors.push({
        field: 'platform',
        message: `Platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`,
      });
    }
  }

  // 6. Language validation (must be in SUPPORTED_LANGUAGES)
  if (body.language !== undefined && body.language !== null) {
    if (typeof body.language !== 'string' || !SUPPORTED_LANGUAGES.includes(body.language as any)) {
      errors.push({
        field: 'language',
        message: `Language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
      });
    }
  }

  // 7. Objective validation (must be in SUPPORTED_OBJECTIVES)
  if (body.objective !== undefined && body.objective !== null) {
    if (typeof body.objective !== 'string' || !SUPPORTED_OBJECTIVES.includes(body.objective as any)) {
      errors.push({
        field: 'objective',
        message: `Marketing objective must be one of: ${SUPPORTED_OBJECTIVES.join(', ')}`,
      });
    }
  }

  // 8. Brand voice validation (optional object)
  if (body.brandVoice !== undefined && body.brandVoice !== null) {
    if (typeof body.brandVoice !== 'object' || Array.isArray(body.brandVoice)) {
      errors.push({ field: 'brandVoice', message: 'Brand voice must be a JSON object' });
    } else {
      if (body.brandVoice.tone !== undefined && body.brandVoice.tone !== null) {
        if (typeof body.brandVoice.tone !== 'string') {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone must be a string' });
        } else if (body.brandVoice.tone.length > 300) {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone cannot exceed 300 characters' });
        }
      }

      if (body.brandVoice.styleGuidelines !== undefined && body.brandVoice.styleGuidelines !== null) {
        if (typeof body.brandVoice.styleGuidelines !== 'string') {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines must be a string' });
        } else if (body.brandVoice.styleGuidelines.length > 500) {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines cannot exceed 500 characters' });
        }
      }

      if (body.brandVoice.bannedWords !== undefined && body.brandVoice.bannedWords !== null) {
        if (!Array.isArray(body.brandVoice.bannedWords)) {
          errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words must be an array of strings' });
        } else {
          if (body.brandVoice.bannedWords.length > 50) {
            errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words array cannot exceed 50 items' });
          }
          for (let i = 0; i < body.brandVoice.bannedWords.length; i++) {
            const word = body.brandVoice.bannedWords[i];
            if (typeof word !== 'string') {
              errors.push({ field: `brandVoice.bannedWords[${i}]`, message: 'Every banned word must be a string' });
              break;
            } else if (word.length > 50) {
              errors.push({ field: `brandVoice.bannedWords[${i}]`, message: 'Banned word entry cannot exceed 50 characters' });
              break;
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed for content generation request.',
      validationErrors: errors,
    });
  }

  next();
}

// API: Health check (Task 4: accurate status, configurable model, supabaseReady=false)
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    aiConfigured: isKeyConfigured,
    model: configuredModel,
    version: '2.0-phase1',
    storageMode: 'localStorage_demo',
    supabaseReady: false,
  });
});

// API: AI Status probe for Settings view (Task 4: accurate live probe, no false positives)
app.get('/api/ai-status', async (req: Request, res: Response) => {
  if (!isKeyConfigured || !ai) {
    return res.json({
      connected: false,
      message: 'GEMINI_API_KEY is not configured or contains placeholder value. Content Studio uses local deterministic fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: null,
    });
  }

  const start = Date.now();
  try {
    const testRes = await withTimeout(
      ai.models.generateContent({
        model: configuredModel,
        contents: 'Respond with exactly: OMNI_CHANNEL_PLUS_OK',
      }),
      8000,
      'Gemini probe timed out after 8000ms'
    );
    const latency = Date.now() - start;
    return res.json({
      connected: true,
      message: `${configuredModel} operational and ready.`,
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: latency,
      responseSample: testRes.text?.trim(),
    });
  } catch (error: any) {
    const sanitizedError = error instanceof Error ? error.message : 'Unknown provider error';
    console.error('[AI Status Probe] Failed to probe Gemini API:', sanitizedError);

    return res.json({
      connected: false,
      message: 'Upstream AI model probe failed or timed out. Studio will use safe local fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    });
  }
});

// API: Hardened Content Generation Endpoint (Tasks 1, 2, 3)
app.post(
  '/api/generate',
  generateRateLimiter,
  validateGenerateRequest,
  async (req: Request, res: Response) => {
    const {
      topic,
      platform = 'linkedin',
      audience = '',
      objective = 'Awareness',
      language = 'English',
      brandName = 'OmniBrand',
      brandVoice = {},
      customInstructions = '',
    } = req.body;

    const platformMeta = PLATFORM_LIMITS[platform] || { maxChars: 2500, defaultHashtags: 3 };

    // If Gemini API key is configured, invoke Gemini with timeout and error handling
    if (isKeyConfigured && ai) {
      try {
        const prompt = `
You are the Content Studio Engine of OMNI CHANNEL PLUS v2.0.
Generate high-converting, platform-native content according to the master spec.

BRAND CONTEXT:
- Brand Name: ${brandName}
- Target Audience: ${audience || 'General Tech / Business Professionals'}
- Brand Tone: ${brandVoice.tone || 'Authoritative, direct, concise'}
- Preferred Language: ${language}
- Banned Brand Words: ${brandVoice.bannedWords ? brandVoice.bannedWords.join(', ') : 'None'}

CAMPAIGN PARAMETERS:
- Topic / Seed Keyword: "${topic}"
- Target Platform: ${platform}
- Marketing Objective: ${objective}
- Platform Character Limit: ${platformMeta.maxChars}
- Custom Instructions: ${customInstructions || 'Follow platform best practices'}

CRITICAL COMPLIANCE RULES:
- STRICTLY DO NOT use any of these banned AI fluff phrases:
  "In today's fast-paced world", "It's important to note", "Delve into", "Tapestry", "Game-changer",
  "Revolutionary", "Cutting-edge", "At the forefront", "I'm excited to share", "Thrilled to announce",
  "In the realm of", "Navigating the complexities of", "A testament to", "In conclusion", "When it comes to", "Leverage".
- Produce 3 distinct hook variations:
  1. Pattern Interrupt (challenges status quo or stops the scroll)
  2. Curiosity Gap (provocative question or unseen dilemma)
  3. Direct Benefit (actionable promise or tangible outcome)
- Output must be in ${language}. If Roman Urdu is selected, write natural conversational Roman Urdu suitable for Pakistani/South Asian digital audiences without robotic phrasing.

Respond with strict JSON matching this schema.
`;

        const response = await withTimeout(
          ai.models.generateContent({
            model: configuredModel,
            contents: prompt,
            config: {
              systemInstruction: `You are the Omni Channel Plus AI Content Studio Engine. You craft human-sounding, punchy, platform-optimized marketing assets. Never use AI fluff phrases. Output strict valid JSON only.`,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: 'Short descriptive title for this project' },
                  hooks: {
                    type: Type.OBJECT,
                    properties: {
                      patternInterrupt: { type: Type.STRING, description: 'Pattern Interrupt hook variation' },
                      curiosityGap: { type: Type.STRING, description: 'Curiosity Gap hook variation' },
                      directBenefit: { type: Type.STRING, description: 'Direct Benefit hook variation' },
                    },
                    required: ['patternInterrupt', 'curiosityGap', 'directBenefit'],
                  },
                  primaryCaption: { type: Type.STRING, description: 'Complete body caption using the best hook' },
                  callToAction: { type: Type.STRING, description: 'High-converting platform CTA' },
                  hashtags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Relevant non-spammy hashtags without #'
                  },
                  keyTakeaways: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '3 core insights from the content'
                  },
                  targetAudienceNote: { type: Type.STRING, description: 'Why this resonates with the chosen audience' },
                  visualDirection: { type: Type.STRING, description: 'Visual or B-roll recommendation' },
                },
                required: ['title', 'hooks', 'primaryCaption', 'callToAction', 'hashtags', 'keyTakeaways'],
              },
            },
          }),
          14000,
          'Gemini generation timed out'
        );

        const parsed = JSON.parse(response.text || '{}');
        const detectedFluff = detectBannedPhrases(parsed.primaryCaption || '');

        return res.json({
          success: true,
          source: configuredModel,
          isFallback: false,
          data: {
            ...parsed,
            detectedFluff,
            platformLimit: platformMeta.maxChars,
            charCount: (parsed.primaryCaption || '').length,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (err: any) {
        // Sanitize error logging: never log API keys or raw tokens
        const sanitizedMsg = err instanceof Error ? err.message : 'Unknown generation error';
        console.error('[Gemini Generation] Upstream error, engaging local deterministic fallback:', sanitizedMsg);

        // Safe client message without leaking internal URLs or credentials
        const fallbackReason = sanitizedMsg.toLowerCase().includes('timed out')
          ? 'upstream_timeout'
          : sanitizedMsg.toLowerCase().includes('quota') || sanitizedMsg.toLowerCase().includes('429')
          ? 'quota_exceeded'
          : 'upstream_unavailable';

        const fallback = generateIntelligentFallback({
          topic,
          platform,
          audience: audience || 'Professional decision makers',
          objective,
          language,
          brandName,
        });

        return res.json({
          success: true,
          source: 'local_deterministic_engine',
          isFallback: true,
          fallbackReason,
          note: 'Content generated using local deterministic engine. Upstream Gemini API call was unavailable or timed out.',
          data: fallback,
        });
      }
    }

    // Deterministic Intelligent Fallback when no API key is configured
    const fallback = generateIntelligentFallback({
      topic,
      platform,
      audience: audience || 'Professional decision makers',
      objective,
      language,
      brandName,
    });

    return res.json({
      success: true,
      source: 'local_deterministic_engine',
      isFallback: true,
      fallbackReason: 'missing_api_key',
      note: 'Content generated using local deterministic engine. Configure GEMINI_API_KEY in the Secrets panel to enable live Gemini AI generation.',
      data: fallback,
    });
  }
);

// Fallback generator matching Omni Channel Plus specification
function generateIntelligentFallback(params: {
  topic: string;
  platform: string;
  audience: string;
  objective: string;
  language: string;
  brandName: string;
}) {
  const { topic, platform, audience, objective, language, brandName } = params;
  const isUrdu = language.toLowerCase().includes('urdu');

  let hookA = `Most teams get ${topic} completely backwards.`;
  let hookB = `There's a subtle bottleneck in ${topic} that cost us weeks to identify.`;
  let hookC = `Here is the step-by-step breakdown to master ${topic} this quarter.`;

  if (isUrdu) {
    hookA = `${topic} ke baray mein 90% log wahi purani ghalti dohra rahe hain.`;
    hookB = `Agar aap ${topic} se results chahte hain, toh yeh ek choti si change zaroori hai.`;
    hookC = `${topic} ko master karne ka seedha aur practical tareeqa — baghair kisi faltu complexity ke.`;
  }

  let body = isUrdu
    ? `${hookA}\n\nJab aap ${topic} par kaam karte hain, toh sab se pehle clear context aur intent zaroori hota hai.\n\n3 Bunyadi baten:\n1. Problem ko root level par identify karein.\n2. Over-automation se bachein aur real value deliver karein.\n3. Har metric ko measurable outcomes ke sath align karein.\n\nAap is par kya approach letay hain?`
    : `${hookA}\n\nWhen optimizing for ${topic}, surface-level tweaks rarely move the needle.\n\nHere are 3 core fundamentals we focus on at ${brandName}:\n\n1. Strip away bloated processes before adding new tooling.\n2. Measure outcomes, not just task completion rates.\n3. Keep the feedback loop under 48 hours for rapid iteration.\n\nWhat is your biggest friction point with ${topic} right now?`;

  const cta = isUrdu
    ? `Comments mein batayein: aap ka current workflow kaisa chal raha hai?`
    : `Drop your thoughts below or bookmark this framework for your next strategy session.`;

  const cleanTopic = topic.replace(/[^a-zA-Z0-9]/g, '');
  const hashtags = [cleanTopic, 'GrowthEngine', 'SaaS', 'Strategy', 'OmniChannel'].slice(0, 4);

  return {
    title: `${topic} - ${objective} Campaign`,
    hooks: {
      patternInterrupt: hookA,
      curiosityGap: hookB,
      directBenefit: hookC,
    },
    primaryCaption: body,
    callToAction: cta,
    hashtags,
    keyTakeaways: [
      `Prioritize foundational clarity before scaling ${topic}`,
      `Eliminate redundant workflow steps to speed up delivery`,
      `Maintain continuous measurement against actual business KPIs`
    ],
    targetAudienceNote: `Tailored for ${audience} focusing on ${objective}.`,
    visualDirection: platform.includes('reels') || platform.includes('tiktok')
      ? 'Vertical 9:16 talking-head with fast-cut b-roll overlays and high-contrast word subtitles.'
      : 'Crisp minimal infographic card or clean branded screenshot with subtle dark gradient border.',
    detectedFluff: [],
    platformLimit: PLATFORM_LIMITS[platform]?.maxChars || 2500,
    charCount: body.length,
    generatedAt: new Date().toISOString(),
  };
}

// Setup Vite middleware in dev or static files in production
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, () => {
    console.log(`OMNI CHANNEL PLUS Server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
