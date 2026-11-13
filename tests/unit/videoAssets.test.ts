/**
 * Video assets helpers (P6) — pure function coverage.
 * Mirrors the DB enum CHECK constraint and the server's upload validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
  VIDEO_STATUSES,
  VIDEO_WRITE_NOTE,
  normalizeVideoMime,
  mimeToExt,
  sanitizeFileName,
  buildFallbackVideoAnalysis,
} from '../../src/utils/videoAssets';

test('video mime list has exact parity with the migration 0009 CHECK', () => {
  // supabase/migrations/0009_video_assets.sql and the storage bucket allow
  // exactly these three types — the list is the single source of truth.
  assert.deepEqual([...VIDEO_MIME_TYPES], ['video/mp4', 'video/webm', 'video/quicktime']);
});

test('video status list has exact parity with the migration 0009 CHECK', () => {
  assert.deepEqual([...VIDEO_STATUSES], ['uploaded', 'analyzing', 'analyzed', 'failed']);
});

test('normalizeVideoMime accepts bare and parameterized allowed types', () => {
  assert.equal(normalizeVideoMime('video/mp4'), 'video/mp4');
  assert.equal(normalizeVideoMime('video/mp4; codecs="avc1.42E01E"'), 'video/mp4');
  assert.equal(normalizeVideoMime('VIDEO/WEBM'), 'video/webm');
  assert.equal(normalizeVideoMime(' video/quicktime '), 'video/quicktime');
});

test('normalizeVideoMime rejects everything outside the allowed set', () => {
  assert.equal(normalizeVideoMime('video/x-msvideo'), null);
  assert.equal(normalizeVideoMime('video/'), null);
  assert.equal(normalizeVideoMime('image/png'), null);
  assert.equal(normalizeVideoMime(''), null);
  assert.equal(normalizeVideoMime(undefined), null);
  assert.equal(normalizeVideoMime(123), null);
});

test('mimeToExt maps each allowed type to its storage extension', () => {
  assert.equal(mimeToExt('video/mp4'), 'mp4');
  assert.equal(mimeToExt('video/webm'), 'webm');
  assert.equal(mimeToExt('video/quicktime'), 'mov');
});

test('sanitizeFileName strips paths, control chars and length runaways', () => {
  assert.equal(sanitizeFileName('clip.mp4'), 'clip.mp4');
  assert.equal(sanitizeFileName('/etc/passwd/evil.mp4'), 'evil.mp4');
  assert.equal(sanitizeFileName('C:\\videos\\brand ad.mp4'), 'brand ad.mp4');
  assert.equal(sanitizeFileName('bad\u0000name.mp4'), 'badname.mp4');
  assert.equal(sanitizeFileName('   '), null);
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName(undefined), null);
  assert.equal(sanitizeFileName('x'.repeat(201)), null);
  assert.equal(sanitizeFileName('x'.repeat(200)), 'x'.repeat(200));
});

test('upload ceiling is 25 MB and matches the migration CHECK', () => {
  assert.equal(VIDEO_MAX_BYTES, 25 * 1024 * 1024);
});

test('VIDEO_WRITE_NOTE is the honest shared 403 mirror', () => {
  assert.equal(VIDEO_WRITE_NOTE.code, 'VIDEO_WRITE_FORBIDDEN');
  assert.ok(VIDEO_WRITE_NOTE.message.length > 10);
});

test('fallback analysis is honest, structured and size-aware', () => {
  const small = buildFallbackVideoAnalysis({ fileName: 'teaser.mp4', mimeType: 'video/mp4', sizeBytes: 512 * 1024 });
  const big = buildFallbackVideoAnalysis({ fileName: 'documentary.mov', mimeType: 'video/quicktime', sizeBytes: 20 * 1024 * 1024 });

  for (const a of [small, big]) {
    assert.equal(typeof a.summary, 'string');
    assert.ok(a.summary.length > 20);
    assert.ok(Array.isArray(a.strengths) && a.strengths.length > 0);
    assert.ok(Array.isArray(a.improvements) && a.improvements.length > 0);
    assert.ok(Array.isArray(a.suggestions) && a.suggestions.length > 0);
    assert.ok(a.suggestions.every(s => s.title && s.detail && ['high', 'medium', 'low'].includes(s.priority)));
    assert.ok(Array.isArray(a.bestPlatforms) && a.bestPlatforms.length > 0);
    assert.equal(typeof a.suggestedCaption, 'string');
    assert.ok(Array.isArray(a.suggestedHashtags));
  }

  // Size awareness: small clips point at short-form platforms, long files get
  // a cut-down improvement first.
  assert.ok(small.bestPlatforms.includes('instagram_reels'));
  assert.ok(small.strengths.some(s => s.includes('short clip')));
  assert.ok(big.improvements[0].includes('longer edit'));
});
