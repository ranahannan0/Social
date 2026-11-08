/**
 * Cloud sync engine (Stage B — real-time sync on mutation).
 *
 * Every AppContext mutation enqueues a small task here instead of waiting
 * for a manual "Sync now". The queue is pumped FIFO (a create is always
 * applied before a later update of the same entity), single-flight, with:
 *
 * - DELETE of an entity drops any pending create/update for it (the row
 *   will never exist server-side, so replaying them would only error).
 * - A newer UPDATE replaces an older pending UPDATE of the same entity
 *   (coalescing — the DB only needs the latest field values).
 * - PERMANENT failures (400 invalid payload, 404 already gone, 409 no
 *   workspace) drop the task and surface the reason: retrying cannot help.
 * - TRANSIENT failures (network, 401 expired session, 429, 5xx) keep the
 *   task at the head and retry after 15s or on window 'online'.
 *
 * Only DB-shaped (UUID) ids are ever sent: entities created before a
 * successful bootstrap still carry legacy local ids and are intentionally
 * skipped — the manual full sync (workspace import) converges them.
 *
 * BROWSER-ONLY module (uses window/event listeners guarded for tests).
 */

import type { BrandProfile, ContentDraft, CalendarEvent } from '../types';
import { authedFetch } from './authClient';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDbUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export type SyncEntity = 'brand' | 'draft' | 'event';

interface CreateTask {
  kind: SyncEntity;
  op: 'create';
  localId: string;
  body: unknown;
  onAck?: (row: Record<string, unknown>) => void;
}
interface UpdateTask {
  kind: SyncEntity;
  op: 'update';
  id: string;
  body: unknown;
}
interface DeleteTask {
  kind: SyncEntity;
  op: 'delete';
  id: string;
}
export type SyncTask = CreateTask | UpdateTask | DeleteTask;

export interface SyncState {
  pending: number;
  lastError: string | null;
}

const queue: SyncTask[] = [];
let pumping = false;
let lastError: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(s: SyncState) => void>();

function notify(): void {
  const state: SyncState = { pending: queue.length, lastError };
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      // listener errors must never break the pump
    }
  }
}

export function subscribeSync(listener: (s: SyncState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSyncState(): SyncState {
  return { pending: queue.length, lastError };
}

/**
 * Enqueue a task and start pumping. Never throws — sync failures surface
 * through the subscription state, never through the UI mutation itself
 * (local state is already applied; the cloud converges or the user sees
 * the pending badge / error).
 */
export function enqueueSync(task: SyncTask): void {
  if (task.op === 'delete') {
    for (let i = queue.length - 1; i >= 0; i--) {
      const t = queue[i];
      const sameEntity =
        t.kind === task.kind &&
        ((t.op === 'create' && t.localId === task.id) || (t.op !== 'create' && t.id === task.id));
      if (sameEntity) queue.splice(i, 1);
    }
  } else if (task.op === 'update') {
    const idx = queue.findIndex(t => t.kind === task.kind && t.op === 'update' && t.id === task.id);
    if (idx >= 0) queue.splice(idx, 1);
  }
  queue.push(task);
  notify();
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const task = queue[0];
      try {
        await execTask(task);
        queue.shift();
        if (lastError) lastError = null;
        notify();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 400 || status === 404 || status === 409 || status === 422) {
          // Permanent: drop and surface. 404 after a cascade delete is the
          // expected benign case (parent delete already removed this row).
          queue.shift();
          lastError = (err as Error).message;
          notify();
          continue;
        }
        // Transient: keep at head, retry later.
        lastError = (err as Error)?.message ?? 'Cloud sync failed.';
        notify();
        scheduleRetry();
        break;
      }
    }
  } finally {
    pumping = false;
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (queue.length > 0) void pump();
  }, 15_000);
}

async function execTask(task: SyncTask): Promise<void> {
  const base = task.kind === 'brand' ? '/api/brands' : task.kind === 'draft' ? '/api/drafts' : '/api/events';
  let res: Response;
  if (task.op === 'create') {
    res = await authedFetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task.body),
    });
  } else if (task.op === 'update') {
    res = await authedFetch(`${base}/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task.body),
    });
  } else {
    res = await authedFetch(`${base}/${task.id}`, { method: 'DELETE' });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      (body as { message?: string; errors?: string[] })?.message ??
      ((body as { errors?: string[] })?.errors ?? []).join('; ') ??
      `Sync failed (status ${res.status}).`;
    const err = new Error(message) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (task.op !== 'delete') {
    const row = await res.json().catch(() => null);
    if (row && typeof row === 'object') {
      (task as CreateTask).onAck?.(row as Record<string, unknown>);
    }
  }
}

/** User-visible retry (Settings → "Retry pending changes"). */
export function retrySync(): void {
  lastError = null;
  notify();
  if (queue.length > 0) void pump();
}

/**
 * Hard reset of the queue. Called on SIGN OUT: pending tasks belong to the
 * outgoing session — replaying them under a different account would write
 * stale entities into the wrong workspace. Local state that never made it
 * is lost by design (cloud is the source of truth once authed).
 */
export function resetSyncQueue(): void {
  queue.length = 0;
  lastError = null;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  notify();
}

/**
 * Resolves once the queue is empty or `maxWaitMs` elapsed with tasks still
 * stuck (transient failure). Used by workspace reset before re-seeding.
 */
export async function drainSyncQueue(maxWaitMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  void pump();
  while (queue.length > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
  }
  return queue.length === 0;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (queue.length > 0) void pump();
  });
}

// ── Payload builders (frontend shape → CRUD body) ───────────────────────────
// Field sets mirror the workspace import mapper exactly, so per-resource
// rows and full-import rows are indistinguishable in the DB.

export function brandSyncBody(b: BrandProfile): unknown {
  return {
    name: b.name,
    tagline: b.tagline,
    industry: b.industry,
    targetAudience: b.targetAudience,
    brandVoice: {
      tone: b.brandVoice.tone,
      bannedWords: b.brandVoice.bannedWords,
      styleGuidelines: b.brandVoice.styleGuidelines,
      sampleCopy: b.brandVoice.sampleCopy,
    },
    preferredLanguage: b.preferredLanguage,
    productsAndServices: b.productsAndServices.map(p => ({ name: p.name })),
  };
}

export function draftSyncBody(d: ContentDraft): unknown {
  return {
    brandId: d.brandId,
    title: d.title,
    topic: d.topic,
    platform: d.platform,
    objective: d.objective,
    language: d.language,
    audience: d.audience,
    selectedHookType: d.selectedHookType,
    hooks: {
      patternInterrupt: d.hooks.patternInterrupt,
      curiosityGap: d.hooks.curiosityGap,
      directBenefit: d.hooks.directBenefit,
    },
    caption: d.caption,
    callToAction: d.callToAction,
    hashtags: d.hashtags,
    status: d.status,
    ...(d.scheduledDate !== undefined ? { scheduledDate: d.scheduledDate } : {}),
    ...(d.complianceStatus ? { complianceStatus: d.complianceStatus } : {}),
  };
}

export function eventSyncBody(e: CalendarEvent): unknown {
  return {
    brandId: e.brandId,
    ...(e.draftId ? { draftId: e.draftId } : { draftId: null }),
    title: e.title,
    platform: e.platform,
    date: e.date,
    time: e.time,
    status: e.status,
    summary: e.summary ?? '',
  };
}
