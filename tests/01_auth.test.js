'use strict';
/**
 * TC-AUTH: Authentication & Authorization Tests
 * Covers: requireAuth middleware, requireRole, first-sign-in provisioning, role enforcement
 */

const request = require('supertest');
const { app } = require('../server');
const store = require('./helpers/store');
const { get, post, put, del, setupBaseState } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-AUTH-01: Missing / malformed Authorization header', () => {
  test('No Authorization header → 401', async () => {
    const res = await request(app).get('/api/init');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing auth token/i);
  });

  test('Authorization without Bearer prefix → 401', async () => {
    const res = await request(app).get('/api/init').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
  });

  test('Invalid / unknown token → 401', async () => {
    const res = await request(app).get('/api/init').set('Authorization', 'Bearer this_is_not_a_real_token');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid auth token/i);
  });
});

describe('TC-AUTH-02: Valid token - first-time sign-in provisioning', () => {
  test('New user with no invite → provisioned as associate', async () => {
    const token = store.createToken('newuid', 'associate', { email: 'new@test.com' });
    // No wh_users doc, no invite
    store.seedStore({ wh_users: {}, wh_config: { customers: { list: [] }, jobTypes: { list: [] }, rateCards: {}, targets: {} } });

    const res = await get('/api/init', token);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('associate');
    expect(res.body.user.uid).toBe('newuid');

    // Firestore doc should have been created
    const userDoc = store.getDoc('wh_users', 'newuid');
    expect(userDoc).toBeTruthy();
    expect(userDoc.role).toBe('associate');
  });

  test('New user with pre-existing invite → provisioned with invite role', async () => {
    const token = store.createToken('inviteduid', 'associate', { email: 'invited@test.com' });
    store.seedStore({
      wh_users: {},
      wh_invites: { 'invited@test.com': { role: 'manager', displayName: 'Invited Mgr', teamId: null } },
      wh_config: { customers: { list: [] }, jobTypes: { list: [] }, rateCards: {}, targets: {} },
    });

    const res = await get('/api/init', token);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('manager');

    // Invite should be consumed
    const invite = store.getDoc('wh_invites', 'invited@test.com');
    expect(invite).toBeUndefined();
  });

  test('Existing user → role from Firestore (not token claim)', async () => {
    // Token says associate but Firestore says admin (role was promoted)
    const token = store.createToken('existuid', 'associate', { email: 'exist@test.com' });
    store.seedStore({
      wh_users: { existuid: { uid: 'existuid', email: 'exist@test.com', displayName: 'Exist', role: 'admin', hourlyCost: 0, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() } },
      wh_config: { customers: { list: [] }, jobTypes: { list: [] }, rateCards: {}, targets: {} },
    });

    const res = await get('/api/init', token);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin'); // Firestore wins
  });
});

describe('TC-AUTH-03: requireRole enforcement', () => {
  test('Admin can access admin-only endpoints', async () => {
    const { adminToken } = setupBaseState();
    const res = await get('/api/users', adminToken);
    expect(res.status).toBe(200);
  });

  test('Manager cannot access admin-only /api/users → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await get('/api/users', managerToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
  });

  test('Associate cannot access admin-only /api/users → 403', async () => {
    const { assocToken } = setupBaseState();
    const res = await get('/api/users', assocToken);
    expect(res.status).toBe(403);
  });

  test('Office Support cannot access admin-only /api/users → 403', async () => {
    const { supportToken } = setupBaseState();
    const res = await get('/api/users', supportToken);
    expect(res.status).toBe(403);
  });

  test('Manager can access /api/templates (manager|admin only)', async () => {
    const { managerToken } = setupBaseState();
    store.seedStore({ ...store.getDoc('wh_config') ? {} : {}, wh_templates: {} });
    const res = await get('/api/templates', managerToken);
    expect(res.status).toBe(200);
  });

  test('Associate cannot access /api/templates → 403', async () => {
    const { assocToken } = setupBaseState();
    const res = await get('/api/templates', assocToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-AUTH-04: Health endpoint requires no auth', () => {
  test('GET /healthz returns 200 without auth', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('TC-AUTH-05: Data scoping by role', () => {
  test('Admin receives users + teams in /api/init', async () => {
    const { adminToken } = setupBaseState();
    const res = await get('/api/init', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(Array.isArray(res.body.teams)).toBe(true);
  });

  test('Manager receives templates but NOT users in /api/init', async () => {
    const { managerToken } = setupBaseState();
    store.seedStore({ ...store.getDoc('wh_templates') ? {} : {}, wh_templates: {} });
    const res = await get('/api/init', managerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.users).toBeUndefined();
  });

  test('Associate only sees own + assigned jobs in /api/init', async () => {
    const { assocId, assocToken, adminId } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_jobs: {
        job_own:      { customerId: 'Acme Corp', jobTypeId: 'bts', status: 'created', createdBy: assocId, assignedAssocId: [], createdAt: store.Timestamp.now() },
        job_assigned: { customerId: 'Acme Corp', jobTypeId: 'bts', status: 'in_progress', createdBy: adminId, assignedAssocId: [assocId], createdAt: store.Timestamp.now() },
        job_other:    { customerId: 'Acme Corp', jobTypeId: 'bts', status: 'created', createdBy: adminId, assignedAssocId: [], createdAt: store.Timestamp.now() },
      },
    });
    const res = await get('/api/init', assocToken);
    expect(res.status).toBe(200);
    const ids = res.body.jobs.map(j => j.id);
    expect(ids).toContain('job_own');
    expect(ids).toContain('job_assigned');
    expect(ids).not.toContain('job_other');
  });
});
