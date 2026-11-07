import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Initialize Gemini SDK with User-Agent as instructed by guidelines
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

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

// Helper to check for banned phrases
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

// Helper with timeout to prevent hanging if external connection experiences latency
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs)),
  ]);
}

// API: Health & AI status check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    aiConfigured: Boolean(apiKey),
    model: 'gemini-3.8-flash',
    version: '2.0-phase1',
    storageMode: 'localStorage_demo',
    supabaseReady: true,
  });
});

// API: AI Status probe for Settings view
app.get('/api/ai-status', async (req: Request, res: Response) => {
  if (!ai || !apiKey) {
    return res.json({
      connected: false,
      message: 'GEMINI_API_KEY is not configured in environment. Content studio will use built-in intelligent fallback generation.',
      model: 'gemini-3.8-flash',
      testedAt: new Date().toISOString(),
      latencyMs: null,
    });
  }

  const start = Date.now();
  try {
    const testRes = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: 'Respond with exactly: OMNI_CHANNEL_PLUS_OK',
      }),
      8000,
      'Gemini probe timed out after 8000ms'
    );
    const latency = Date.now() - start;
    return res.json({
      connected: true,
      message: 'Gemini 3.8 Flash operational and ready.',
      model: 'gemini-3.8-flash',
      testedAt: new Date().toISOString(),
      latencyMs: latency,
      responseSample: testRes.text?.trim(),
    });
  } catch (error: any) {
    return res.json({
      connected: false,
      message: error?.message || 'Error communicating with Gemini API',
      model: 'gemini-3.8-flash',
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    });
  }
});

// API: Content Generation Endpoint
app.post('/api/generate', async (req: Request, res: Response) => {
  const {
    topic,
    platform = 'linkedin',
    audience,
    objective = 'Awareness',
    language = 'English',
    brandName = 'OmniBrand',
    brandVoice = {},
    customInstructions = '',
  } = req.body;

  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic or seed keyword is required.' });
  }

  const platformMeta = PLATFORM_LIMITS[platform] || { maxChars: 2500, defaultHashtags: 3 };

  // If Gemini API is available, invoke Gemini 3.8 Flash
  if (ai && apiKey) {
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
          model: 'gemini-3.8-flash',
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
        source: 'gemini-3.8-flash',
        data: {
          ...parsed,
          detectedFluff,
          platformLimit: platformMeta.maxChars,
          charCount: (parsed.primaryCaption || '').length,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      console.error('Gemini generation failed, falling back to deterministic engine:', err);
      // Fallback cleanly below with notice
    }
  }

  // Deterministic Intelligent Fallback (if no API key or API temporarily unavailable)
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
    note: apiKey ? 'Fallback triggered due to upstream API notice.' : 'Generated using local template engine (Gemini API key not set).',
    data: fallback,
  });
});

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
