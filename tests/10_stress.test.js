'use strict';
/**
 * TC-STRESS: Regression & Stress Tests
 * Covers: concurrent job creation, bulk location ops, task gate enforcement,
 *         complete workflow end-to-end, rate card edge cases, high-volume data
 */

const supertest = require('supertest');
const { app } = require('../server');
const store = require('./helpers/store');
const { get, post, put, del, setupBaseState, seedJob } = require('./helpers/api');

beforeEach(() => store.reset());

// ─── TC-STRESS-01: Concurrent Job Number Generation ──────────────────────────

describe('TC-STRESS-01: Sequential job number generation (ES-XXX)', () => {
  test('10 concurrent job creations produce unique job numbers', async () => {
    const { adminToken } = setupBaseState();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp' }, adminToken)
      )
    );
    expect(results.every(r => r.status === 201)).toBe(true);
    const numbers = results.map(r => r.body.jobNumber);
    const unique = new Set(numbers);
    expect(unique.size).toBe(10); // all unique
    // All are ES-XXX format
    expect(numbers.every(n => /^ES-\d{3}$/.test(n))).toBe(true);
  });

  test('Job counter increments correctly after 5 jobs', async () => {
    const { adminToken } = setupBaseState();
    for (let i = 0; i < 5; i++) {
      await post('/api/jobs', { jobTypeId: 'bts', customerId: 'Acme Corp' }, adminToken);
    }
    const counter = store.getDoc('wh_config', 'counters');
    expect(counter.jobCounter).toBe(5);
  });
});

// ─── TC-STRESS-02: Bulk Location Operations ───────────────────────────────────

describe('TC-STRESS-02: Bulk location management', () => {
  test('Job with 50 locations — all assigned, all marked done in parallel', async () => {
    const { adminToken, assocId, assocToken } = setupBaseState();
    const numLocs = 50;
    const locations = Array.from({ length: numLocs }, (_, i) => ({
      id: `loc_${i}`,
      name: `BIN-${String(i).padStart(3, '0')}`,
      status: 'pending',
      assignedAssocId: assocId,
      referenceData: { SKU: `SKU-${i}`, Qty: String(i * 2) },
    }));

    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations,
    });

    // Mark all done in parallel
    const doneResults = await Promise.all(
      locations.map(l =>
        put(`/api/jobs/${jobId}/locations/${l.id}/done`, { assocNotes: 'ok', capturedData: {} }, assocToken)
      )
    );

    // All should succeed (last one may return allDone=true)
    const statuses = doneResults.map(r => r.status);
    expect(statuses.every(s => s === 200)).toBe(true);

    // Final job state
    const job = store.getDoc('wh_jobs', jobId);
    const allDone = job.locations.every(l => l.status === 'done');
    expect(allDone).toBe(true);
  });

  test('Location assignment preserves capturedData for already-done locations', async () => {
    const { adminToken, assocId } = setupBaseState();
    const doneLocId = 'loc_done_1';
    const existingLocs = [
      { id: doneLocId, name: 'BIN-DONE', status: 'done', assignedAssocId: assocId, capturedData: { cartons: 42 }, assocNotes: 'verified' },
      { id: 'loc_pending', name: 'BIN-PENDING', status: 'pending', assignedAssocId: null, capturedData: {} },
    ];
    const jobId = seedJob({ status: 'in_progress', assignedAssocId: [assocId], locations: existingLocs });

    // Manager reassigns locations (shouldn't wipe done data)
    await put(`/api/jobs/${jobId}/locations`, {
      locations: [
        { id: doneLocId, name: 'BIN-DONE', assignedAssocId: assocId },
        { id: 'loc_pending', name: 'BIN-PENDING', assignedAssocId: assocId },
        { id: 'loc_new', name: 'BIN-NEW', assignedAssocId: assocId },
      ],
    }, adminToken);

    const job = store.getDoc('wh_jobs', jobId);
    const doneLoc = job.locations.find(l => l.id === doneLocId);
    expect(doneLoc.status).toBe('done');
    expect(doneLoc.capturedData.cartons).toBe(42);
    expect(doneLoc.assocNotes).toBe('verified');
  });
});

// ─── TC-STRESS-03: Task Gate Enforcement ─────────────────────────────────────

describe('TC-STRESS-03: Task completion gate before job advancement', () => {
  test('submit-review blocked when pending tasks exist (non-admin)', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      createdBy: assocId,
      locations: [
        { id: 'l1', name: 'BIN-A', status: 'done', assignedAssocId: assocId },
        { id: 'l2', name: 'BIN-B', status: 'pending', assignedAssocId: assocId },
      ],
    });
    const res = await put(`/api/jobs/${jobId}/submit-review`, {}, assocToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 task/i);
  });

  test('complete blocked when pending tasks exist (non-admin manager)', async () => {
    const { managerToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'pending_review',
      assignedAssocId: [assocId],
      locations: [
        { id: 'l1', name: 'BIN-A', status: 'done', assignedAssocId: assocId },
        { id: 'l2', name: 'BIN-B', status: 'pending', assignedAssocId: assocId },
      ],
    });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 10 } }, managerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/task/i);
  });

  test('Admin can complete job even with pending tasks (bypass gate)', async () => {
    const { adminToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'pending_review',
      customerId: 'Acme Corp',
      jobTypeId: 'bts',
      assignedAssocId: [assocId],
      locations: [
        { id: 'l1', name: 'BIN-A', status: 'pending', assignedAssocId: assocId },
      ],
    });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 10 }, billable: true }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  test('submit-review allowed when ALL tasks done', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      createdBy: assocId,
      locations: [
        { id: 'l1', name: 'BIN-A', status: 'done', assignedAssocId: assocId },
        { id: 'l2', name: 'BIN-B', status: 'done', assignedAssocId: assocId },
      ],
    });
    const res = await put(`/api/jobs/${jobId}/submit-review`, {}, assocToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_review');
  });
});

// ─── TC-STRESS-04: Full End-to-End Workflow ──────────────────────────────────

describe('TC-STRESS-04: Full job lifecycle — create → assign → work → complete', () => {
  test('Complete cycle count job with all 10 locations through full workflow', async () => {
    const { adminToken, managerToken, assocId, assocToken, managerId } = setupBaseState();

    // 1. Create job
    const createRes = await post('/api/jobs', {
      jobTypeId: 'cycle_count',
      customerId: 'Acme Corp',
      notes: 'Q4 cycle count',
      instructions: 'Count all bins in Zone A',
    }, adminToken);
    expect(createRes.status).toBe(201);
    const jobId = createRes.body.id;

    // 2. Assign manager
    const mgrRes = await put(`/api/jobs/${jobId}/assign-manager`, { managerId }, adminToken);
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body.status).toBe('assigned_manager');

    // 3. Manager assigns locations + associate
    const locations = Array.from({ length: 10 }, (_, i) => ({
      id: `bin_${i}`,
      name: `BIN-A-${String(i).padStart(2, '0')}`,
      assignedAssocId: assocId,
      referenceData: { 'Bin ID': `A-${i}`, SKU: `SKU-${100 + i}` },
    }));
    const locsRes = await put(`/api/jobs/${jobId}/locations`, {
      locations,
      referenceDataTypes: { 'Bin ID': 'text', SKU: 'text' },
    }, managerToken);
    expect(locsRes.status).toBe(200);

    // 4. Assign associate
    const assocRes = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [assocId] }, managerToken);
    expect(assocRes.status).toBe(200);

    // 5. Associate marks all locations done sequentially
    for (let i = 0; i < 10; i++) {
      const res = await put(`/api/jobs/${jobId}/locations/bin_${i}/done`, {
        assocNotes: `Counted bin A-${i}`,
        capturedData: { bins: 1 },
        updatedRefData: { 'Bin ID': `A-${i}`, SKU: `SKU-${100 + i}` },
      }, assocToken);
      expect(res.status).toBe(200);
    }

    // Job should now be pending_review
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.status).toBe('pending_review');

    // 6. Manager completes job
    const completeRes = await put(`/api/jobs/${jobId}/complete`, {
      fields: { labour_hours: 5, bins: 10 },
      billable: true,
    }, managerToken);
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('completed');
    expect(completeRes.body.completedBy).toBe(managerId);
  });
});

// ─── TC-STRESS-05: Multi-Customer Rate Cards ─────────────────────────────────

describe('TC-STRESS-05: Rate card edge cases under load', () => {
  test('10 different customers, each with rate card, all complete correctly', async () => {
    const { adminToken } = setupBaseState();

    // Set up 10 customers with their rate cards
    const customers = Array.from({ length: 10 }, (_, i) => `Customer ${i + 1}`);
    await put('/api/customers', { list: customers }, adminToken);

    const rates = Object.fromEntries(
      customers.map((c, i) => [c, { bts: { cartons: (i + 1) * 1.5 } }])
    );
    await put('/api/rates', rates, adminToken);

    // Create and complete a job for each customer
    const results = await Promise.all(
      customers.map(async (customerId, i) => {
        const jobId = seedJob({ status: 'pending_review', customerId, jobTypeId: 'bts', assignedAssocId: [] });
        const res = await put(`/api/jobs/${jobId}/complete`, {
          fields: { cartons: 10 },
          billable: true,
        }, adminToken);
        return { customerId, revenue: res.body.revenue, i };
      })
    );

    // Each customer's revenue = 10 cartons × their rate
    results.forEach(({ customerId, revenue, i }) => {
      const expectedRate = (i + 1) * 1.5;
      expect(revenue).toBeCloseTo(10 * expectedRate, 1);
    });
  });

  test('Missing rate card field → that field contributes 0 to revenue (no crash)', async () => {
    const { adminToken } = setupBaseState();
    // Rate card only has 'cartons', not 'units'
    store.seedStore({
      ...Object.fromEntries(['wh_users'].map(k => [k, store.getDoc(k)])),
      wh_config: {
        customers: { list: ['Acme Corp'] },
        jobTypes: { list: [] },
        rateCards: { 'Acme Corp': { bts: { cartons: 5.00 } } }, // no units rate
        targets: { bts: { targetMarginPct: 50, goodThresholdPct: 10 } },
      },
    });
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, {
      fields: { cartons: 10, units: 500 },
      billable: true,
    }, adminToken);
    expect(res.status).toBe(200);
    // units has no rate so only cartons counted: 10 × $5 = $50
    expect(res.body.revenue).toBeCloseTo(50, 0);
  });
});

// ─── TC-STRESS-06: Security / Authorization Matrix ───────────────────────────

describe('TC-STRESS-06: Role × endpoint authorization matrix', () => {
  const securityMatrix = [
    // [endpoint, method, body, allowedRoles, description]
    ['DELETE /api/jobs/:id',         'delete', null,          ['admin'],                          'delete job'],
    ['PUT /api/jobs/:id/cancel',     'put',    {},            ['admin','manager','office_support'], 'cancel job'],
    ['PUT /api/jobs/:id/complete',   'put',    {fields:{}},   ['admin','manager'],                'complete job'],
    ['POST /api/jobs/:id/clone',     'post',   {},            ['admin','manager','office_support'], 'clone job'],
    ['PUT /api/customers',           'put',    {list:[]},     ['admin'],                          'update customers'],
    ['PUT /api/rates',               'put',    {},            ['admin'],                          'update rates'],
    ['PUT /api/targets',             'put',    {},            ['admin'],                          'update targets'],
    ['GET /api/users',               'get',    null,          ['admin'],                          'list users'],
    ['POST /api/users/invite',       'post',   {email:'a@b.com',role:'associate'}, ['admin'],    'invite user'],
    ['GET /api/logs',                'get',    null,          ['admin','manager'],                'view logs'],
  ];

  for (const [endpoint, method, body, allowedRoles, desc] of securityMatrix) {
    const allRoles = ['admin', 'manager', 'associate', 'office_support'];
    const deniedRoles = allRoles.filter(r => !allowedRoles.includes(r));

    for (const role of deniedRoles) {
      test(`${role} cannot ${desc} → 403`, async () => {
        const state = setupBaseState();
        const token = role === 'admin' ? state.adminToken
          : role === 'manager' ? state.managerToken
          : role === 'associate' ? state.assocToken
          : state.supportToken;

        let path = endpoint.split(' ')[1].replace(':id', seedJob({ status: 'in_progress' }));
        let req = supertest(app)[method](path).set('Authorization', `Bearer ${token}`);
        if (body) req = req.send(body);
        const res = await req;
        expect(res.status).toBe(403);
      });
    }
  }
});

// ─── TC-STRESS-07: Data Integrity Under Load ─────────────────────────────────

describe('TC-STRESS-07: Data integrity — multiple concurrent updates', () => {
  test('20 simultaneous job edits — all succeed, no data corruption', async () => {
    const { adminToken } = setupBaseState();
    const jobIds = Array.from({ length: 20 }, () =>
      seedJob({ status: 'created', notes: 'original', billable: true })
    );

    const results = await Promise.all(
      jobIds.map((id, i) =>
        put(`/api/jobs/${id}`, { notes: `updated-${i}`, billable: i % 2 === 0 }, adminToken)
      )
    );

    expect(results.every(r => r.status === 200)).toBe(true);

    // Verify each job has its own update (not cross-contaminated)
    jobIds.forEach((id, i) => {
      const job = store.getDoc('wh_jobs', id);
      expect(job.notes).toBe(`updated-${i}`);
      expect(job.billable).toBe(i % 2 === 0);
    });
  });

  test('Customer rename updates all matching jobs atomically', async () => {
    const { adminToken } = setupBaseState();
    // Create 15 jobs for Acme Corp
    const jobIds = Array.from({ length: 15 }, () =>
      seedJob({ customerId: 'Acme Corp', status: 'created' })
    );
    // Create 5 jobs for Widget Co (should NOT be affected)
    const widgetJobIds = Array.from({ length: 5 }, () =>
      seedJob({ customerId: 'Widget Co', status: 'created' })
    );

    const res = await put('/api/customers/rename', { oldName: 'Acme Corp', newName: 'Acme Corporation' }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(15);

    // All Acme jobs renamed
    jobIds.forEach(id => {
      expect(store.getDoc('wh_jobs', id).customerId).toBe('Acme Corporation');
    });
    // Widget Co jobs untouched
    widgetJobIds.forEach(id => {
      expect(store.getDoc('wh_jobs', id).customerId).toBe('Widget Co');
    });
  });
});

// ─── TC-STRESS-08: Input Validation / Security Boundaries ────────────────────

describe('TC-STRESS-08: Input validation and boundary conditions', () => {
  test('customerId exceeding 500 chars → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', {
      jobTypeId: 'bts',
      customerId: 'A'.repeat(501),
    }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
  });

  test('Invalid jobTypeId → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', {
      jobTypeId: 'definitely_not_a_real_type',
      customerId: 'Acme Corp',
    }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job.?type/i);
  });

  test('Locations array exceeding 1000 → 400', async () => {
    const { adminToken } = setupBaseState();
    const res = await post('/api/jobs', {
      jobTypeId: 'bts',
      customerId: 'Acme Corp',
      locations: Array.from({ length: 1001 }, (_, i) => ({ name: `BIN-${i}` })),
    }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });

  test('Invalid role assignment → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/role`, { role: 'overlord' }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid role/i);
  });

  test('Hourly cost of 0 is valid (edge case)', async () => {
    const { adminToken, assocId } = setupBaseState();
    const res = await put(`/api/users/${assocId}/cost`, { hourlyCost: 0 }, adminToken);
    expect(res.status).toBe(200);
    expect(store.getDoc('wh_users', assocId).hourlyCost).toBe(0);
  });

  test('Assign empty associateIds array → 400', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [] }, adminToken);
    expect(res.status).toBe(400);
  });

  test('UNAUTHENTICATED request to protected endpoint → 401', async () => {
    const res = await supertest(app).get('/api/init');
    expect(res.status).toBe(401);
  });

  test('GET /healthz always 200 — no auth needed', async () => {
    const res = await supertest(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('Unknown route falls back to SPA or 404 — never crashes the server', async () => {
    const res = await supertest(app).get('/some/unknown/page');
    // SPA fallback: either serves index.html (200) or 404
    expect([200, 404]).toContain(res.status);
  });
});
