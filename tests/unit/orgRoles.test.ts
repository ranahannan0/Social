/**
 * P3.3 role-aware UI unit tests — pure decision logic.
 *
 * orgRoles.ts mirrors the DB's org_role enum and can_write() policy for the
 * frontend. The RLS layer remains the real gate (verified live in authSmoke);
 * these tests pin the UI's read-only decision logic so a viewer never
 * submits a write that the server would have to reject.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSIGNABLE_MEMBER_ROLES, canManageMembers, canWriteRole, isOrgRole, roleBadgeLabel, roleForOrg } from '../../src/utils/orgRoles';
import type { OrgSummary } from '../../src/utils/workspaceHydrate';

function org(id: string, role?: OrgSummary['role']): OrgSummary {
  return { id, name: `Org ${id}`, defaultTimezone: null, role };
}

// ── isOrgRole ────────────────────────────────────────────────────────────────

test('isOrgRole: accepts exactly the four DB enum values', () => {
  for (const role of ['owner', 'admin', 'editor', 'viewer']) {
    assert.equal(isOrgRole(role), true, `${role} should be valid`);
  }
});

test('isOrgRole: rejects non-enum strings, non-strings and nullish', () => {
  assert.equal(isOrgRole('member'), false); // pre-migration enum name — not valid
  assert.equal(isOrgRole('OWNER'), false); // case-sensitive, like the DB enum
  assert.equal(isOrgRole(''), false);
  assert.equal(isOrgRole(null), false);
  assert.equal(isOrgRole(undefined), false);
  assert.equal(isOrgRole(42), false);
  assert.equal(isOrgRole({ role: 'owner' }), false);
});

// ── roleForOrg ───────────────────────────────────────────────────────────────

test('roleForOrg: finds the role for the matching org id', () => {
  const orgs = [org('a', 'viewer'), org('b', 'owner')];
  assert.equal(roleForOrg(orgs, 'a'), 'viewer');
  assert.equal(roleForOrg(orgs, 'b'), 'owner');
});

test('roleForOrg: null orgId (local mode) → null', () => {
  assert.equal(roleForOrg([org('a', 'owner')], null), null);
});

test('roleForOrg: unknown org id → null (never guess a role)', () => {
  assert.equal(roleForOrg([org('a', 'owner')], 'missing'), null);
});

test('roleForOrg: empty org list → null', () => {
  assert.equal(roleForOrg([], 'a'), null);
});

test('roleForOrg: org present but role missing/invalid → null', () => {
  // Before GET /api/orgs merge, role is undefined; a malformed value (e.g.
  // the pre-migration 'member' enum) must not silently become a role.
  assert.equal(roleForOrg([org('a')], 'a'), null);
  assert.equal(roleForOrg([{ id: 'a', role: 'member' }], 'a'), null);
});

// ── canWriteRole (mirror of the DB can_write() policy) ──────────────────────

test('canWriteRole: viewer cannot write', () => {
  assert.equal(canWriteRole('viewer'), false);
});

test('canWriteRole: editor, admin and owner can write', () => {
  assert.equal(canWriteRole('editor'), true);
  assert.equal(canWriteRole('admin'), true);
  assert.equal(canWriteRole('owner'), true);
});

test('canWriteRole: unknown role (null) → writable, RLS is the real gate', () => {
  // Local mode has no RLS; legacy sessions predate the role merge. The
  // server-side can_write() policy protects every cloud write regardless.
  assert.equal(canWriteRole(null), true);
});

// ── roleBadgeLabel ──────────────────────────────────────────────────────────

test('roleBadgeLabel: uppercase badge text', () => {
  assert.equal(roleBadgeLabel('owner'), 'OWNER');
  assert.equal(roleBadgeLabel('viewer'), 'VIEWER');
});

// ── canManageMembers (mirror of the members_* RLS policies) ────────────────

test('canManageMembers: admins and owners manage the roster', () => {
  assert.equal(canManageMembers('admin'), true);
  assert.equal(canManageMembers('owner'), true);
});

test('canManageMembers: editors, viewers and unknown roles cannot', () => {
  assert.equal(canManageMembers('editor'), false);
  assert.equal(canManageMembers('viewer'), false);
  assert.equal(canManageMembers(null), false);
});

test('ASSIGNABLE_MEMBER_ROLES: owner is deliberately not assignable', () => {
  // Ownership transfer is a dedicated flow, never a dropdown value.
  assert.ok(!ASSIGNABLE_MEMBER_ROLES.includes('owner'));
  assert.deepEqual([...ASSIGNABLE_MEMBER_ROLES], ['admin', 'editor', 'viewer']);
});
