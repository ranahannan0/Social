import { BANNED_AI_FLUFF_PHRASES, PLATFORMS_CONFIG } from './constants';
import { ComplianceCheckResult, PlatformType } from '../types';

export function detectFluffPhrases(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return BANNED_AI_FLUFF_PHRASES.filter(phrase => lower.includes(phrase));
}

export function runComplianceCheck(text: string, platform: PlatformType): ComplianceCheckResult {
  const detected = detectFluffPhrases(text);
  const platformMeta = PLATFORMS_CONFIG[platform] || { maxChars: 3000 };
  const charCount = text ? text.length : 0;
  const maxLimit = platformMeta.maxChars;

  const warnings: string[] = [];

  if (charCount > maxLimit) {
    warnings.push(`Character limit exceeded (${charCount}/${maxLimit} chars). Content will be truncated on ${platformMeta.label}.`);
  }

  if (detected.length > 0) {
    warnings.push(`Detected ${detected.length} banned AI fluff phrase(s): ${detected.map(p => `"${p}"`).join(', ')}. Rewrite for authentic brand voice.`);
  }

  // Safe zone checks for vertical videos
  if (platform === 'instagram_reels' || platform === 'tiktok') {
    warnings.push(`Vertical video notice: Ensure on-screen typography stays within safe zones (top 150-180px and bottom 400-450px reserved for platform UI).`);
  }

  const passed = detected.length === 0 && charCount <= maxLimit;

  return {
    passed,
    detectedFluff: detected,
    charCount,
    maxLimit,
    warnings,
  };
}
