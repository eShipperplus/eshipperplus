'use strict';
/**
 * TC-JOB: Job CRUD Tests
 * Covers: POST /api/jobs, PUT /api/jobs/:id, DELETE /api/jobs/:id
 */

const store = require('./helpers/store');
const { get, post, put, del, setupBaseState, seedJob } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-JOB-01: Create Job — validation', () => {
  test('Missing customerId → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', { jobTypeId: 'bts' }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customerId/i);
  });

  test('Missing jobTypeId → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', { customerId: 'Acme Corp' }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobTypeId/i);
  });

  test('Valid job creates with status "created"', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp' }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('created');
  });

  test('Job with assignedManagerId → status "assigned_manager"', async () => {
    const { adminToken, managerId } = setupBaseState();
    const res = await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp', assignedManagerId: managerId }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('assigned_manager');
    expect(res.body.assignedManagerId).toBe(managerId);
  });

  test('Job created by any authenticated user (all roles can create)', async () => {
    const { assocToken, supportToken, managerToken } = setupBaseState();
    for (const tok of [assocToken, supportToken, managerToken]) {
      const res = await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp' }, tok);
      expect(res.status).toBe(201);
    }
  });

  test('Locations array stored on job', async () => {
    const { adminToken } = setupBaseState();
    const locations = [
      { name: 'Aisle A1', instructions: 'Check SKU 100', referenceData: { sku: 'SKU100' } },
      { name: 'Aisle B2', instructions: 'Check SKU 200', referenceData: { sku: 'SKU200' } },
    ];
    const res = await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp', locations }, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.locations).toHaveLength(2);
    expect(res.body.locations[0].name).toBe('Aisle A1');
    expect(res.body.locations[0].status).toBe('pending');
    expect(res.body.locations[0].id).toBeDefined();
  });

  test('Audit record created on job creation', async () => {
    const { adminToken } = setupBaseState();
    await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp' }, adminToken);
    const audits = store.getAllDocs('wh_audit');
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[audits.length - 1].action).toBe('created');
  });
});

describe('TC-JOB-02: Edit Job — permissions & validation', () => {
  test('Admin can edit any job', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}`, { notes: 'Updated notes' }, adminToken);
    expect(res.status).toBe(200);
  });

  test('Manager can edit any job', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}`, { notes: 'Manager notes' }, managerToken);
    expect(res.status).toBe(200);
  });

  test('Associate can edit job they created', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({ createdBy: assocId });
    const res = await put(`/api/jobs/${jobId}`, { notes: 'My notes' }, assocToken);
    expect(res.status).toBe(200);
  });

  test('Associate cannot edit job they did not create and are not assigned to → 403', async () => {
    const { assocToken } = setupBaseState();
    const jobId = seedJob({ createdBy: 'other_user', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}`, { notes: 'Hacker notes' }, assocToken);
    expect(res.status).toBe(403);
  });

  test('Edit non-existent job → 404', async () => {
    const { adminToken } = setupBaseState();
    const res = await put('/api/jobs/does_not_exist', { notes: 'test' }, adminToken);
    expect(res.status).toBe(404);
  });

  test('Audit diff recorded on edit', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ notes: 'Old notes' });
    await put(`/api/jobs/${jobId}`, { notes: 'New notes' }, adminToken);
    const audits = store.getAllDocs('wh_audit').filter(a => a.jobId === jobId);
    const editAudit = audits.find(a => a.action === 'updated');
    expect(editAudit).toBeDefined();
    expect(editAudit.changes?.notes?.from).toBe('Old notes');
    expect(editAudit.changes?.notes?.to).toBe('New notes');
  });
});

describe('TC-JOB-03: Delete Job — admin only', () => {
  test('Admin can delete a job', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob();
    const res = await del(`/api/jobs/${jobId}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(store.getDoc('wh_jobs', jobId)).toBeUndefined();
  });

  test('Manager cannot delete a job → 403', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob();
    const res = await del(`/api/jobs/${jobId}`, managerToken);
    expect(res.status).toBe(403);
  });

  test('Associate cannot delete a job → 403', async () => {
    const { assocToken } = setupBaseState();
    const jobId = seedJob();
    const res = await del(`/api/jobs/${jobId}`, assocToken);
    expect(res.status).toBe(403);
  });

  test('Delete non-existent job → 404', async () => {
    const { adminToken } = setupBaseState();
    const res = await del('/api/jobs/ghost_job', adminToken);
    expect(res.status).toBe(404);
  });

  test('Audit snapshot recorded on deletion', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ customerId: 'Acme Corp' });
    await del(`/api/jobs/${jobId}`, adminToken);
    const audits = store.getAllDocs('wh_audit').filter(a => a.jobId === jobId);
    const delAudit = audits.find(a => a.action === 'deleted');
    expect(delAudit).toBeDefined();
    expect(delAudit.snapshot).toBeDefined();
    expect(delAudit.snapshot.customerId).toBe('Acme Corp');
  });
});
