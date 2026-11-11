/**
 * Phase 3.3 — Role-aware UI helpers.
 *
 * The database is the enforcement layer: RLS policies gate every table via
 * `org_role_at()` (viewer = read-only, editor+ = write, admin+ = admin).
 * These helpers let the UI MIRROR that reality — disabling create/edit
 * entry points for viewers so they never submit a write that RLS would
 * reject with 403. The UI gate is a courtesy, never the guarantee.
 */

/** Matches the `public.org_role` enum in the Phase 2 schema. */
export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';

const ORG_ROLE_VALUES: readonly OrgRole[] = ['owner', 'admin', 'editor', 'viewer'];

/** Narrow an unknown value (e.g. a JSON API field) to a valid OrgRole. */
export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLE_VALUES as readonly string[]).includes(value);
}

/** Any membership row shape that carries an optional role. */
export interface RoleBearingOrg {
  id: string;
  role?: OrgRole | string | null;
}

/**
 * The caller's role in `orgId`, or null when unknown:
 * - local mode (no Supabase) — there are no org rows at all
 * - org list not yet merged with GET /api/orgs role data
 * - orgId not in the list (defensive: never guess a role)
 */
export function roleForOrg(orgs: readonly RoleBearingOrg[], orgId: string | null): OrgRole | null {
  if (!orgId) return null;
  const found = orgs.find(o => o.id === orgId);
  if (!found) return null;
  return isOrgRole(found.role) ? found.role : null;
}

/**
 * Mirrors the DB `can_write()` policy: editor, admin and owner may write;
 * viewer may not. Unknown role (null) returns TRUE — local mode has no RLS
 * and legacy single-org sessions predate role merging, and in every cloud
 * case the server-side RLS remains the real gate either way.
 */
export function canWriteRole(role: OrgRole | null): boolean {
  return role === null || role === 'editor' || role === 'admin' || role === 'owner';
}

/** Uppercase badge label for the workspace switcher. */
export function roleBadgeLabel(role: OrgRole): string {
  return role.toUpperCase();
}
