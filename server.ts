import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { resolveTrustProxyHops } from './src/utils/proxy';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

// Detect if running inside Google AI Studio preview or standalone production
const isAiStudioPreview = Boolean(
  process.env.APP_URL?.includes('run.app') ||
  process.env.AI_STUDIO ||
  process.env.ALLOW_AI_STUDIO_IFRAME === 'true'
);

// Security: Disable Express fingerprinting
app.disable('x-powered-by');

/**
 * Trust Proxy Configuration: TRUST_PROXY_HOPS
 *
 * Strict hop-count controlled proxy trust to ensure IP-based rate limiting cannot be spoofed.
 *
 * Requirements:
 * - Default to 0 (no trusted proxy: client IP resolved from socket directly).
 * - Never use 'trust proxy = true' globally (which would trust arbitrary client-supplied headers).
 * - Do not hardcode 1 without verifying deployment topology.
 * - Accept an environment-controlled numeric hop count (TRUST_PROXY_HOPS).
 * - Prevent spoofed X-Forwarded-For headers from bypassing IP-based rate limiting.
 *
 * Topology Reference:
 * - 0 hops (default): Directly exposed Node.js or local dev. No reverse proxy trusted.
 * - 1 hop: Single reverse proxy (e.g., standard Google Cloud Run, AWS ALB, Nginx).
 * - 2 hops: Two reverse proxies (e.g., Cloudflare CDN -> Cloud Run -> Node.js).
 * - N hops: N chained reverse proxies.
 */
function configureTrustProxy(appInstance: express.Express): number {
  // Primary setting is TRUST_PROXY_HOPS; fallback to TRUST_PROXY if numeric
  const envVal = process.env.TRUST_PROXY_HOPS || process.env.TRUST_PROXY;
  const hops = resolveTrustProxyHops(envVal);

  if (hops > 0) {
    appInstance.set('trust proxy', hops);
  } else {
    // 0 hops: explicitly disable proxy trust
    appInstance.set('trust proxy', false);
  }

  return hops;
}

const configuredTrustProxyHops = configureTrustProxy(app);

/**
 * Security Headers (Section 2)
 *
 * - In Development: CSP and frameguard are relaxed to prevent breaking Vite SPA
 *   dynamic imports, module scripts, eval tooling, and AI Studio development iframe.
 * - In Production: Strict Content Security Policy (CSP) is enforced.
 * - Clickjacking Protection: Standalone production uses X-Frame-Options: SAMEORIGIN.
 *   In Google AI Studio preview, CSP frame-ancestors limits framing strictly to
 *   Google AI Studio domains and self, preventing arbitrary 3rd-party framing.
 */
app.use(
  helmet({
    contentSecurityPolicy: isDev
      ? false
      : {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: isAiStudioPreview
              ? ["'self'", 'https://aistudio.google.com', 'https://*.google.com', 'https://*.run.app']
              : ["'self'"],
          },
        },
    frameguard: isDev
      ? false
      : isAiStudioPreview
      ? false // In AI Studio preview, CSP frame-ancestors enforces legitimate Google iframe embedding
      : { action: 'sameorigin' }, // Standalone production clickjacking defense
    crossOriginEmbedderPolicy: false,
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Security: Reduce JSON request body size limit to 64kb (appropriate for text-only inputs)
app.use(express.json({ limit: '64kb' }));

// Environment configuration
function resolveModelName(): string {
  const envModel = process.env.GEMINI_MODEL?.trim();
  // Ensure GEMINI_MODEL is a valid model identifier and not an accidental credential leak
  if (
    envModel &&
    !envModel.startsWith('AQ.') &&
    !envModel.startsWith('AIza') &&
    envModel.length < 50
  ) {
    return envModel;
  }
  return 'gemini-3.8-flash';
}

const configuredModel = resolveModelName();
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

/**
 * RATE LIMITER SCALABILITY ARCHITECTURE NOTE (Section 5):
 *
 * The current rate limiters (for /api/generate and /api/ai-status) utilize express-rate-limit's
 * default in-memory MemoryStore.
 *
 * Operational Characteristics & Multi-Instance Limitations:
 * 1. Single-Instance / Local / AI Studio Container: MemoryStore is lightweight, has zero external
 *    network/database dependencies, and accurately limits requests per IP.
 * 2. Multi-Instance Deployments (e.g. horizontally auto-scaled Cloud Run instances, multi-pod Kubernetes):
 *    In-memory stores do NOT share state across instances. If N instances are running behind a round-robin
 *    load balancer, an IP could theoretically submit up to N * max requests across different instances
 *    unless sticky sessions or centralized storage is used.
 * 3. Future Scalability Migration (Phase 2):
 *    When Redis is provisioned as specified in the Phase 2 master architecture (for BullMQ queues and schedulers),
 *    express-rate-limit should be upgraded to use 'rate-limit-redis' store backed by the Redis cluster.
 *    Per engineering instructions, Redis is not added in Phase 1 to avoid unnecessary overhead before
 *    the distributed queue layer is implemented.
 */

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

// Rate limiter: 15 AI status probe requests per minute per IP (Section 1)
const aiStatusRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      connected: false,
      error: 'Rate limit exceeded for AI status probes. Maximum 15 requests per minute allowed.',
      retryAfterSeconds: 60,
    });
  },
});

// Cache for AI status probe results (60 seconds TTL) (Section 1)
interface CachedAiStatus {
  timestamp: number;
  data: {
    connected: boolean;
    message: string;
    model: string;
    testedAt: string;
    latencyMs: number | null;
    responseSample?: string;
  };
}

let cachedAiStatus: CachedAiStatus | null = null;
const PROBE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

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

/**
 * Strict Request Body Validation Middleware for /api/generate (Section 4)
 *
 * Rules:
 * - Reject missing or null body.
 * - Reject null for any supplied field (topic, audience, brandName, customInstructions, platform, language, objective, brandVoice).
 * - Reject non-string in string fields, oversized strings, and non-plain-object in object fields.
 * - Strictly validate arrays and reject null items.
 * - Halts request with HTTP 400 and structured validation errors; never triggers fallback generator for invalid input.
 */
function validateGenerateRequest(req: Request, res: Response, next: NextFunction) {
  const errors: ValidationErrorDetail[] = [];
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: 'Invalid request payload: expected non-null JSON object.',
      validationErrors: [{ field: 'body', message: 'Request body must be a non-null JSON object' }],
    });
  }

  // 1. Topic validation (required, non-null string, 1-300 chars)
  if (!('topic' in body) || body.topic === undefined) {
    errors.push({ field: 'topic', message: 'Topic is required' });
  } else if (body.topic === null) {
    errors.push({ field: 'topic', message: 'Topic cannot be null' });
  } else if (typeof body.topic !== 'string') {
    errors.push({ field: 'topic', message: 'Topic must be a string' });
  } else {
    const trimmed = body.topic.trim();
    if (trimmed.length === 0) {
      errors.push({ field: 'topic', message: 'Topic cannot be empty or whitespace' });
    } else if (trimmed.length > 300) {
      errors.push({ field: 'topic', message: 'Topic cannot exceed 300 characters' });
    }
  }

  // 2. Audience validation (optional string, if present cannot be null, max 300 chars)
  if ('audience' in body && body.audience !== undefined) {
    if (body.audience === null) {
      errors.push({ field: 'audience', message: 'Audience cannot be null' });
    } else if (typeof body.audience !== 'string') {
      errors.push({ field: 'audience', message: 'Audience must be a string' });
    } else if (body.audience.length > 300) {
      errors.push({ field: 'audience', message: 'Audience cannot exceed 300 characters' });
    }
  }

  // 3. Brand name validation (optional string, if present cannot be null, max 100 chars)
  if ('brandName' in body && body.brandName !== undefined) {
    if (body.brandName === null) {
      errors.push({ field: 'brandName', message: 'Brand name cannot be null' });
    } else if (typeof body.brandName !== 'string') {
      errors.push({ field: 'brandName', message: 'Brand name must be a string' });
    } else if (body.brandName.length > 100) {
      errors.push({ field: 'brandName', message: 'Brand name cannot exceed 100 characters' });
    }
  }

  // 4. Custom instructions validation (optional string, if present cannot be null, max 1000 chars)
  if ('customInstructions' in body && body.customInstructions !== undefined) {
    if (body.customInstructions === null) {
      errors.push({ field: 'customInstructions', message: 'Custom instructions cannot be null' });
    } else if (typeof body.customInstructions !== 'string') {
      errors.push({ field: 'customInstructions', message: 'Custom instructions must be a string' });
    } else if (body.customInstructions.length > 1000) {
      errors.push({ field: 'customInstructions', message: 'Custom instructions cannot exceed 1000 characters' });
    }
  }

  // 5. Platform validation (optional, if present cannot be null, must be in SUPPORTED_PLATFORMS)
  if ('platform' in body && body.platform !== undefined) {
    if (body.platform === null) {
      errors.push({ field: 'platform', message: 'Platform cannot be null' });
    } else if (typeof body.platform !== 'string' || !SUPPORTED_PLATFORMS.includes(body.platform as any)) {
      errors.push({
        field: 'platform',
        message: `Platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`,
      });
    }
  }

  // 6. Language validation (optional, if present cannot be null, must be in SUPPORTED_LANGUAGES)
  if ('language' in body && body.language !== undefined) {
    if (body.language === null) {
      errors.push({ field: 'language', message: 'Language cannot be null' });
    } else if (typeof body.language !== 'string' || !SUPPORTED_LANGUAGES.includes(body.language as any)) {
      errors.push({
        field: 'language',
        message: `Language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
      });
    }
  }

  // 7. Objective validation (optional, if present cannot be null, must be in SUPPORTED_OBJECTIVES)
  if ('objective' in body && body.objective !== undefined) {
    if (body.objective === null) {
      errors.push({ field: 'objective', message: 'Marketing objective cannot be null' });
    } else if (typeof body.objective !== 'string' || !SUPPORTED_OBJECTIVES.includes(body.objective as any)) {
      errors.push({
        field: 'objective',
        message: `Marketing objective must be one of: ${SUPPORTED_OBJECTIVES.join(', ')}`,
      });
    }
  }

  // 8. Brand voice validation (optional, if present cannot be null, must be a non-null plain object)
  if ('brandVoice' in body && body.brandVoice !== undefined) {
    if (body.brandVoice === null) {
      errors.push({ field: 'brandVoice', message: 'Brand voice cannot be null' });
    } else if (typeof body.brandVoice !== 'object' || Array.isArray(body.brandVoice)) {
      errors.push({ field: 'brandVoice', message: 'Brand voice must be a non-null plain object' });
    } else {
      if ('tone' in body.brandVoice && body.brandVoice.tone !== undefined) {
        if (body.brandVoice.tone === null) {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone cannot be null' });
        } else if (typeof body.brandVoice.tone !== 'string') {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone must be a string' });
        } else if (body.brandVoice.tone.length > 300) {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone cannot exceed 300 characters' });
        }
      }

      if ('styleGuidelines' in body.brandVoice && body.brandVoice.styleGuidelines !== undefined) {
        if (body.brandVoice.styleGuidelines === null) {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines cannot be null' });
        } else if (typeof body.brandVoice.styleGuidelines !== 'string') {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines must be a string' });
        } else if (body.brandVoice.styleGuidelines.length > 500) {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines cannot exceed 500 characters' });
        }
      }

      if ('bannedWords' in body.brandVoice && body.brandVoice.bannedWords !== undefined) {
        if (body.brandVoice.bannedWords === null) {
          errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words cannot be null' });
        } else if (!Array.isArray(body.brandVoice.bannedWords)) {
          errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words must be an array' });
        } else {
          if (body.brandVoice.bannedWords.length > 50) {
            errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words array cannot exceed 50 items' });
          }
          for (let i = 0; i < body.brandVoice.bannedWords.length; i++) {
            const word = body.brandVoice.bannedWords[i];
            if (word === null || word === undefined || typeof word !== 'string') {
              errors.push({ field: `brandVoice.bannedWords[${i}]`, message: 'Every banned word must be a non-null string' });
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

// API: Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    aiConfigured: isKeyConfigured,
    model: configuredModel,
    version: '2.0-phase1',
    storageMode: 'localStorage_demo',
    supabaseReady: false,
    trustProxyHops: configuredTrustProxyHops,
  });
});

// API: AI Status probe for Settings view (with 15 req/min rate limit and 60-second caching)
app.get('/api/ai-status', aiStatusRateLimiter, async (req: Request, res: Response) => {
  // Return cached probe result if within 60-second TTL
  const now = Date.now();
  if (cachedAiStatus && (now - cachedAiStatus.timestamp < PROBE_CACHE_TTL_MS)) {
    return res.json(cachedAiStatus.data);
  }

  if (!isKeyConfigured || !ai) {
    const unconfiguredResult = {
      connected: false,
      message: 'GEMINI_API_KEY is not configured or contains placeholder value. Content Studio uses local deterministic fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: null,
    };
    cachedAiStatus = {
      timestamp: now,
      data: unconfiguredResult,
    };
    return res.json(unconfiguredResult);
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

    const freshResult = {
      connected: true,
      message: `${configuredModel} operational and ready.`,
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: latency,
      responseSample: testRes.text?.trim(),
    };

    // Cache successful probe result
    cachedAiStatus = {
      timestamp: Date.now(),
      data: freshResult,
    };

    return res.json(freshResult);
  } catch (error: any) {
    const sanitizedError = error instanceof Error ? error.message : 'Unknown provider error';
    console.error('[AI Status Probe] Failed to probe Gemini API:', sanitizedError);

    const failResult = {
      connected: false,
      message: 'Upstream AI model probe failed or timed out. Studio will use safe local fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };

    // Cache probe result for 60-second TTL to prevent repeated quota consumption
    cachedAiStatus = {
      timestamp: Date.now(),
      data: failResult,
    };

    return res.json(failResult);
  }
});

// API: Hardened Content Generation Endpoint
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
