'use strict';
/**
 * TC-TPL: Job Templates Tests
 * Covers: CRUD, access control, field validation
 */

const store = require('./helpers/store');
const { get, post, put, del, setupBaseState } = require('./helpers/api');

beforeEach(() => store.reset());

const sampleTemplate = {
  name: 'Weekly BTS - Acme',
  jobTypeId: 'bts',
  customerId: 'Acme Corp',
  billable: true,
  dueDaysOffset: 3,
  instructions: 'Process back-to-stock items from receiving area',
  notes: 'Check pallet count first',
  locations: [
    { name: 'Aisle A1', instructions: 'SKU range 100-199', referenceData: { zone: 'A' } },
    { name: 'Aisle B2', instructions: 'SKU range 200-299', referenceData: { zone: 'B' } },
  ],
  csvCaptureFields: [],
};

describe('TC-TPL-01: Create Template', () => {
  test('Manager can create a template', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/templates', sampleTemplate, managerToken);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    const tpl = store.getDoc('wh_templates', res.body.id);
    expect(tpl.name).toBe('Weekly BTS - Acme');
    expect(tpl.locations).toHaveLength(2);
    expect(tpl.dueDaysOffset).toBe(3);
    expect(tpl.createdBy).toBe('user_mgr');
  });

  test('Admin can create a template', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/templates', { name: 'Admin TPL', jobTypeId: 'bts', customerId: 'Acme Corp' }, adminToken);
    expect(res.status).toBe(201);
  });

  test('Associate cannot create template → 403', async () => {
    const { assocToken } = setupBaseState();
    const res = await post('/api/templates', sampleTemplate, assocToken);
    expect(res.status).toBe(403);
  });

  test('Office Support cannot create template → 403', async () => {
    const { supportToken } = setupBaseState();
    const res = await post('/api/templates', sampleTemplate, supportToken);
    expect(res.status).toBe(403);
  });

  test('Missing required name → 400', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/templates', { jobTypeId: 'bts', customerId: 'Acme Corp' }, managerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('Missing jobTypeId → 400', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/templates', { name: 'T', customerId: 'Acme Corp' }, managerToken);
    expect(res.status).toBe(400);
  });

  test('Missing customerId → 400', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/templates', { name: 'T', jobTypeId: 'bts' }, managerToken);
    expect(res.status).toBe(400);
  });

  test('Template with dueDaysOffset=0 stored correctly', async () => {
    const { managerToken } = setupBaseState();
    const res = await post('/api/templates', { ...sampleTemplate, dueDaysOffset: 0 }, managerToken);
    expect(res.status).toBe(201);
    const tpl = store.getDoc('wh_templates', res.body.id);
    expect(tpl.dueDaysOffset).toBe(0);
  });

  test('Template without dueDaysOffset stores null', async () => {
    const { managerToken } = setupBaseState();
    const { dueDaysOffset, ...noOffset } = sampleTemplate;
    const res = await post('/api/templates', noOffset, managerToken);
    expect(res.status).toBe(201);
    const tpl = store.getDoc('wh_templates', res.body.id);
    expect(tpl.dueDaysOffset).toBeNull();
  });
});

describe('TC-TPL-02: Read Templates', () => {
  test('Manager gets template list', async () => {
    const { managerToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: {
        tpl_1: { name: 'T1', jobTypeId: 'bts', customerId: 'Acme Corp', createdAt: store.Timestamp.now() },
        tpl_2: { name: 'T2', jobTypeId: 'kit', customerId: 'Widget Co', createdAt: store.Timestamp.now() },
      },
    });
    const res = await get('/api/templates', managerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  test('Admin gets templates in /api/init', async () => {
    const { adminToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: { tpl_x: { name: 'TX', jobTypeId: 'bts', customerId: 'Acme Corp', createdAt: store.Timestamp.now() } },
    });
    const res = await get('/api/init', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.some(t => t.id === 'tpl_x')).toBe(true);
  });

  test('Associate does NOT see templates in /api/init', async () => {
    const { assocToken } = setupBaseState();
    const res = await get('/api/init', assocToken);
    expect(res.status).toBe(200);
    expect(res.body.templates).toBeUndefined();
  });
});

describe('TC-TPL-03: Update Template', () => {
  test('Manager can update a template', async () => {
    const { managerToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: { tpl_u: { name: 'Old Name', jobTypeId: 'bts', customerId: 'Acme Corp', locations: [], csvCaptureFields: [], createdAt: store.Timestamp.now() } },
    });
    const res = await put('/api/templates/tpl_u', { name: 'New Name', jobTypeId: 'bts', customerId: 'Acme Corp', locations: [], csvCaptureFields: [] }, managerToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_templates', 'tpl_u').name).toBe('New Name');
  });

  test('Associate cannot update template → 403', async () => {
    const { assocToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: { tpl_u2: { name: 'T', jobTypeId: 'bts', customerId: 'Acme Corp', createdAt: store.Timestamp.now() } },
    });
    const res = await put('/api/templates/tpl_u2', { name: 'Hacked' }, assocToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-TPL-04: Delete Template', () => {
  test('Manager can delete a template', async () => {
    const { managerToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: { tpl_d: { name: 'Delete Me', jobTypeId: 'bts', customerId: 'Acme Corp', createdAt: store.Timestamp.now() } },
    });
    const res = await del('/api/templates/tpl_d', managerToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_templates', 'tpl_d')).toBeUndefined();
  });

  test('Associate cannot delete template → 403', async () => {
    const { assocToken } = setupBaseState();
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_config'].map(k => [k, store.getDoc(k)])),
      wh_templates: { tpl_d2: { name: 'T', jobTypeId: 'bts', customerId: 'Acme Corp', createdAt: store.Timestamp.now() } },
    });
    const res = await del('/api/templates/tpl_d2', assocToken);
    expect(res.status).toBe(403);
  });
});
