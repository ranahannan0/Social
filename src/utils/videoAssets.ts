/**
 * Video assets (P6 vertical slice) — shared pure helpers.
 *
 * Used by BOTH the server (upload validation, fallback analysis) and the
 * browser (client-side file checks) so the two never drift. Keep this module
 * free of imports that pull in Node or DOM APIs.
 */

/** Hard upload ceiling — matches the storage bucket limit (25 MB). */
export const VIDEO_MAX_BYTES = 25 * 1024 * 1024;

/** Server body-buffer ceiling: the raw payload itself plus framing slack. */
export const VIDEO_BODY_LIMIT = '26mb';

/** Exact mime types the bucket + RLS storage policies accept. */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

/** DB enum mirror: asset lifecycle. */
export const VIDEO_STATUSES = ['uploaded', 'analyzing', 'analyzed', 'failed'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Shared 403 mirror: same code for non-members and under-privileged members
 * (viewers) so org existence never leaks through the video endpoints. */
export const VIDEO_WRITE_NOTE = {
  code: 'VIDEO_WRITE_FORBIDDEN',
  message: 'Your role in this workspace cannot upload or analyze videos.',
} as const;

function isVideoMimeType(value: unknown): value is VideoMimeType {
  return typeof value === 'string' && (VIDEO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Normalize a client-supplied content type to one of the allowed mime types.
 * Browsers append codecs parameters ("video/mp4; codecs=avc1..."), which we
 * strip before matching. Returns null for anything we do not accept.
 */
export function normalizeVideoMime(rawContentType: unknown): VideoMimeType | null {
  if (typeof rawContentType !== 'string') return null;
  const base = rawContentType.split(';')[0].trim().toLowerCase();
  return isVideoMimeType(base) ? base : null;
}

/** Storage object extension for a mime type (mp4 / webm / mov). */
export function mimeToExt(mime: VideoMimeType): string {
  switch (mime) {
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
  }
}

/**
 * Sanitize a client-supplied file name for display: strip path components,
 * control characters and length-runaway. The storage path NEVER uses this
 * string (object names are `<orgId>/<uuid>.<ext>`); it is display metadata.
 */
export function sanitizeFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length < 1 || cleaned.length > 200) return null;
  return cleaned;
}

/** The shape both the Gemini path and the fallback path produce. */
export interface VideoAnalysis {
  summary: string;
  strengths: string[];
  improvements: string[];
  suggestions: Array<{ title: string; detail: string; priority: 'high' | 'medium' | 'low' }>;
  bestPlatforms: string[];
  suggestedCaption: string;
  suggestedHashtags: string[];
}

/**
 * Deterministic, honest fallback analysis when GEMINI_API_KEY is not
 * configured or the upstream call failed. It reasons ONLY from file metadata
 * (size, mime, name) — it never pretends to have watched the video, and the
 * result is always persisted with analysis_is_fallback = true so the UI can
 * label it (same convention as Content Studio's isFallback flag).
 */
export function buildFallbackVideoAnalysis(meta: {
  fileName: string;
  mimeType: VideoMimeType;
  sizeBytes: number;
}): VideoAnalysis {
  const sizeMb = Math.round((meta.sizeBytes / (1024 * 1024)) * 10) / 10;
  const likelyShort = meta.sizeBytes < 2 * 1024 * 1024;
  const likelyLong = meta.sizeBytes > 15 * 1024 * 1024;

  const strengths: string[] = [`File is a valid ${meta.mimeType} upload (${sizeMb} MB) — accepted by every major platform's native uploader.`];
  if (likelyShort) strengths.push('Small file size usually means a short clip — ideal for Reels/Shorts-style vertical cuts where the first seconds carry everything.');

  const improvements: string[] = [
    'Add burned-in captions: a large share of social video plays muted, so captions carry the message.',
    'Put the hook in the first 3 seconds — state the promise or the problem before any branding.',
    'End with one explicit CTA (what to do next), not a fade-out.',
  ];
  if (likelyLong) improvements.unshift('File size suggests a longer edit — cut a 15-30s vertical excerpt for feed platforms and keep the long version for YouTube.');

  return {
    summary:
      `Heuristic pre-analysis of "${meta.fileName}" (${sizeMb} MB, ${meta.mimeType}). ` +
      'This is NOT AI viewing of the video: full visual/audio analysis needs the Gemini API key to be configured. The advice below is standard high-performance video practice you can apply immediately.',
    strengths,
    improvements,
    suggestions: [
      { title: 'Captions on every frame', detail: 'Burn in or platform-generate captions; most feed views are muted.', priority: 'high' },
      { title: '3-second hook', detail: 'Open with the strongest claim or visual — branding can wait until the audience is hooked.', priority: 'high' },
      { title: 'One CTA, one action', detail: 'Close with a single next step (follow, save, click) instead of a soft ending.', priority: 'medium' },
      { title: 'Platform-native crops', detail: 'Export 9:16 for Reels/Shorts/Stories, 1:1 or 4:5 for feed, 16:9 for YouTube.', priority: 'medium' },
    ],
    bestPlatforms: likelyShort ? ['instagram_reels', 'tiktok', 'youtube'] : ['youtube', 'linkedin', 'instagram_feed'],
    suggestedCaption: '',
    suggestedHashtags: [],
  };
}
