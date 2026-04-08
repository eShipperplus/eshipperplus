'use strict';
/**
 * TC-CFG: Configuration Tests
 * Covers: customers, job types, rate cards, targets, teams
 */

const store = require('./helpers/store');
const { get, post, put, del, setupBaseState } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-CFG-01: Customers', () => {
  test('Admin can update customers list', async () => {
    const { adminToken } = setupBaseState();
    const newList = ['Acme Corp', 'New Customer', 'Third Co'];
    const res = await put('/api/customers', { list: newList }, adminToken);
    expect(res.status).toBe(200);
    const cfg = store.getDoc('wh_config', 'customers');
    expect(cfg.list).toEqual(newList);
  });

  test('Non-admin cannot update customers → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await put('/api/customers', { list: ['X'] }, managerToken);
    expect(res.status).toBe(403);
  });

  test('Rename customer updates all jobs', async () => {
    const { adminToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_jobs: {
        job_1: { customerId: 'Acme Corp', jobTypeId: 'bts', status: 'created', createdAt: store.Timestamp.now() },
        job_2: { customerId: 'Acme Corp', jobTypeId: 'bts', status: 'completed', createdAt: store.Timestamp.now() },
        job_3: { customerId: 'Widget Co', jobTypeId: 'bts', status: 'created', createdAt: store.Timestamp.now() },
      },
    });
    const res = await put('/api/customers/rename', { oldName: 'Acme Corp', newName: 'Acme Corporation' }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(store.getDoc('wh_jobs', 'job_1').customerId).toBe('Acme Corporation');
    expect(store.getDoc('wh_jobs', 'job_2').customerId).toBe('Acme Corporation');
    expect(store.getDoc('wh_jobs', 'job_3').customerId).toBe('Widget Co'); // unchanged
  });

  test('Rename with missing fields → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await put('/api/customers/rename', { oldName: 'Acme Corp' }, adminToken);
    expect(res.status).toBe(400);
  });
});

describe('TC-CFG-02: Job Types', () => {
  test('Admin can update job types list', async () => {
    const { adminToken } = setupBaseState();
    const newTypes = [{ id: 'custom_type', name: 'Custom Type', color: 'blue', fields: [{ id: 'units', label: 'Units', type: 'number', required: false }] }];
    const res = await put('/api/jobtypes', { list: newTypes }, adminToken);
    expect(res.status).toBe(200);
  });

  test('Non-admin cannot update job types → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await put('/api/jobtypes', { list: [] }, managerToken);
    expect(res.status).toBe(403);
  });

  test('Admin can seed built-in job types', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobtypes/seed', {}, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.added).toBeGreaterThan(0);
    expect(Array.isArray(res.body.types)).toBe(true);
  });

  test('Seeding is idempotent — second call adds 0 types', async () => {
    const { adminToken } = setupBaseState();
    await post('/api/jobtypes/seed', {}, adminToken);
    const res = await post('/api/jobtypes/seed', {}, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
  });

  test('Init merges built-in + Firestore types (Firestore wins on duplicates)', async () => {
    const { adminToken } = setupBaseState();
    // Put a custom version of 'bts' in Firestore
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_config: {
        ...store.getDoc('wh_config'),
        jobTypes: { list: [{ id: 'bts', name: 'Custom BTS', color: 'red', fields: [] }] },
      },
    });
    const res = await get('/api/init', adminToken);
    expect(res.status).toBe(200);
    const bts = res.body.jobTypes.find(jt => jt.id === 'bts');
    expect(bts.name).toBe('Custom BTS'); // Firestore version wins
    expect(bts.color).toBe('red');
  });
});

describe('TC-CFG-03: Rate Cards', () => {
  test('Admin can set rate cards', async () => {
    const { adminToken } = setupBaseState();
    const rates = { 'Acme Corp': { bts: { cartons: 3.00, units: 0.15 } } };
    const res = await put('/api/rates', rates, adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_config', 'rateCards')['Acme Corp'].bts.cartons).toBe(3.00);
  });

  test('Non-admin cannot set rate cards → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await put('/api/rates', {}, managerToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-CFG-04: Profitability Targets', () => {
  test('Admin can set targets', async () => {
    const { adminToken } = setupBaseState();
    const targets = { bts: { targetMarginPct: 60, goodThresholdPct: 15 } };
    const res = await put('/api/targets', targets, adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_config', 'targets').bts.targetMarginPct).toBe(60);
  });

  test('Non-admin cannot set targets → 403', async () => {
    const { assocToken } = setupBaseState();
    const res = await put('/api/targets', {}, assocToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-CFG-05: Teams', () => {
  test('Admin can create a team', async () => {
    const { adminToken, managerId } = setupBaseState();
    const res = await post('/api/teams', { name: 'Alpha Team', managerId }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    const team = store.getDoc('wh_teams', res.body.id);
    expect(team.name).toBe('Alpha Team');
    expect(team.managerId).toBe(managerId);
  });

  test('Create team without name → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/teams', { managerId: 'x' }, adminToken);
    expect(res.status).toBe(400);
  });

  test('Non-admin cannot create team → 403', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/teams', { name: 'Rogue Team' }, managerToken);
    expect(res.status).toBe(403);
  });

  test('Admin can add member to team', async () => {
    const { adminToken, assocId } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_teams: { team_a: { name: 'Team A', managerId: null, memberIds: [] } },
    });
    const res = await put('/api/teams/team_a/members', { action: 'add', uid: assocId }, adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_teams', 'team_a').memberIds).toContain(assocId);
    expect(store.getDoc('wh_users', assocId).teamId).toBe('team_a');
  });

  test('Admin can remove member from team', async () => {
    const { adminToken, assocId } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_teams: { team_a: { name: 'Team A', managerId: null, memberIds: [assocId] } },
    });
    const users = store.getDoc('wh_users');
    users[assocId] = { ...users[assocId], teamId: 'team_a' };
    store.seedStore({ wh_users: users });

    const res = await put('/api/teams/team_a/members', { action: 'remove', uid: assocId }, adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_teams', 'team_a').memberIds).not.toContain(assocId);
    expect(store.getDoc('wh_users', assocId).teamId).toBeNull();
  });

  test('Admin can delete a team', async () => {
    const { adminToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_teams: { team_del: { name: 'Delete Me', memberIds: [] } },
    });
    const res = await del('/api/teams/team_del', adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_teams', 'team_del')).toBeUndefined();
  });
});
