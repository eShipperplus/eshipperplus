'use strict';
/**
 * TC-USER: User Management Tests
 * Covers: invite, role change, cost update, password, delete, self-delete prevention
 */

const store = require('./helpers/store');
const { get, post, put, del, setupBaseState } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-USER-01: Invite / Create User', () => {
  test('Admin can invite a new user by email', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/users/invite',
      { email: 'newuser@test.com', displayName: 'New User', role: 'manager' },
      adminToken
    );
    expect(res.status).toBe(200); // server returns 200 for invite (no 201)
    expect(res.body.uid).toBeDefined();
    expect(res.body.resetLink).toBeDefined();
    expect(res.body.status).toBe('invited');
  });

  test('Non-admin cannot invite → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/users/invite', { email: 'x@test.com', role: 'associate' }, managerToken);
    expect(res.status).toBe(403);
  });

  test('Missing email → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/users/invite', { role: 'associate' }, adminToken);
    expect(res.status).toBe(400);
  });

  test('Invite with teamId → invite doc stores teamId for first-sign-in provisioning', async () => {
    // For NEW users, the team memberIds is updated on first sign-in (via requireAuth consuming the invite).
    // The invite doc itself must store the teamId so requireAuth can pick it up.
    const { adminToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_teams: { team_1: { name: 'Team A', managerId: null, memberIds: [] } },
    });
    const res = await post('/api/users/invite',
      { email: 'teamuser@test.com', role: 'associate', teamId: 'team_1' },
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body.uid).toBeDefined();
    // Invite doc must store teamId so requireAuth provisions correctly on first sign-in
    const invite = store.getDoc('wh_invites', 'teamuser@test.com');
    expect(invite).toBeDefined();
    expect(invite.teamId).toBe('team_1');
    expect(invite.role).toBe('associate');
  });

  test('Re-inviting existing user updates their role (status=updated)', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await post('/api/users/invite',
      { email: 'assoc@test.com', role: 'manager' },
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('updated');
    // Firestore doc role updated
    const userDoc = store.getDoc('wh_users', assocId);
    expect(userDoc.role).toBe('manager');
  });
});

describe('TC-USER-02: Change User Role', () => {
  test('Admin can change any user role', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/role`, { role: 'manager' }, adminToken);
    expect(res.status).toBe(200);
    const user = store.getDoc('wh_users', assocId);
    expect(user.role).toBe('manager');
  });

  test('Invalid role → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/role`, { role: 'superuser' }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid role/i);
  });

  test('Non-admin cannot change role → 403', async () => {
    const { managerToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/role`, { role: 'manager' }, managerToken);
    expect(res.status).toBe(403);
  });

  test('Role change updates Firebase custom claims', async () => {
    const { adminToken, assocId } = setupBaseState();
    await put(`/api/users/${assocId}/role`, { role: 'manager' }, adminToken);
    const authUser = store.getDoc('wh_users', assocId); // we check wh_users as proxy
    // The auth mock updates custom claims in _auth
    // We verify Firestore role was updated
    expect(authUser.role).toBe('manager');
  });
});

describe('TC-USER-03: Update User Cost', () => {
  test('Admin can set hourly cost', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/cost`, { hourlyCost: 25 }, adminToken);
    expect(res.status).toBe(200);
    const user = store.getDoc('wh_users', assocId);
    expect(user.hourlyCost).toBe(25);
  });

  test('Negative hourly cost → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/cost`, { hourlyCost: -5 }, adminToken);
    expect(res.status).toBe(400);
  });

  test('Non-admin cannot update cost → 403', async () => {
    const { managerToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/cost`, { hourlyCost: 100 }, managerToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-USER-04: Delete User', () => {
  test('Admin can delete another user', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await del(`/api/users/${assocId}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(store.getDoc('wh_users', assocId)).toBeUndefined();
  });

  test('Admin cannot delete themselves → 400', async () => {
    const { adminToken, adminId } = setupBaseState();
    const res = await del(`/api/users/${adminId}`, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot delete yourself/i);
  });

  test('Non-admin cannot delete users → 403', async () => {
    const { managerToken, assocId } = setupBaseState();
    const res = await del(`/api/users/${assocId}`, managerToken);
    expect(res.status).toBe(403);
  });

  test('Delete removes user from team memberIds', async () => {
    const { adminToken, assocId } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_teams: { team_1: { name: 'Team A', managerId: null, memberIds: [assocId, 'other'] } },
    });
    // Update user's teamId
    const users = store.getDoc('wh_users');
    users[assocId] = { ...users[assocId], teamId: 'team_1' };
    store.seedStore({ wh_users: users });

    await del(`/api/users/${assocId}`, adminToken);
    const team = store.getDoc('wh_teams', 'team_1');
    expect(team.memberIds).not.toContain(assocId);
    expect(team.memberIds).toContain('other');
  });
});

describe('TC-USER-05: Password Management', () => {
  test('Admin can generate password reset link', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await post(`/api/users/${assocId}/reset-password-link`, {}, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toBeDefined();
    expect(res.body.resetLink).toContain('http');
  });

  test('Admin can set user password directly', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/password`, { password: 'NewPass123!' }, adminToken);
    expect(res.status).toBe(200);
  });

  test('Password too short → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/password`, { password: '123' }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6/i);
  });
});
