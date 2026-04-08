'use strict';
/**
 * TC-WORKFLOW: Job Status Transition Tests
 * Covers: assign-manager, assign-associate, location marking, submit-review, complete
 */

const store = require('./helpers/store');
const { post, put, setupBaseState, seedJob } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-WF-01: Assign Manager', () => {
  test('Admin can assign manager → status becomes assigned_manager', async () => {
    const { adminToken, managerId } = setupBaseState();
    const jobId = seedJob({ status: 'created' });
    const res = await put(`/api/jobs/${jobId}/assign-manager`, { managerId }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('assigned_manager');
    expect(res.body.assignedManagerId).toBe(managerId);
  });

  test('Manager can assign manager', async () => {
    const { managerToken, managerId } = setupBaseState();
    const jobId = seedJob({ status: 'created' });
    const res = await put(`/api/jobs/${jobId}/assign-manager`, { managerId }, managerToken);
    expect(res.status).toBe(200);
  });

  test('Associate cannot assign manager → 403', async () => {
    const { assocToken, managerId } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-manager`, { managerId }, assocToken);
    expect(res.status).toBe(403);
  });

  test('Assigning nonexistent managerId → 404', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-manager`, { managerId: 'nonexistent_user' }, adminToken);
    expect(res.status).toBe(404);
  });

  test('Assigning a non-manager user as manager → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-manager`, { managerId: assocId }, adminToken);
    expect(res.status).toBe(400);
  });
});

describe('TC-WF-02: Assign Associates', () => {
  test('Admin can assign associates → status becomes assigned_associate', async () => {
    const { adminToken, assocId } = setupBaseState();
    const jobId = seedJob({ status: 'assigned_manager', managerId: 'user_mgr' });
    const res = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [assocId] }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('assigned_associate');
    expect(res.body.assignedAssocId).toContain(assocId);
  });

  test('Empty associateIds array → 400', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [] }, adminToken);
    expect(res.status).toBe(400);
  });

  test('Associate cannot assign associates → 403', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [assocId] }, assocToken);
    expect(res.status).toBe(403);
  });

  test('Multiple associates assigned together', async () => {
    const { adminToken, assocId, managerId } = setupBaseState();
    const jobId = seedJob();
    const res = await put(`/api/jobs/${jobId}/assign-associate`, { associateIds: [assocId, managerId] }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.assignedAssocId).toContain(assocId);
  });
});

describe('TC-WF-03: Location Mark Done', () => {
  test('Assigned associate can mark their location done', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_1';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Aisle A1', status: 'pending', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/done`,
      { assocNotes: 'Done', capturedData: { cartons: 5 } },
      assocToken
    );
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.status).toBe('done');
  });

  test('Associate not assigned to location cannot mark it done → 403', async () => {
    const { assocToken } = setupBaseState();
    const locId = 'loc_x';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: ['other_assoc'],
      locations: [{ id: locId, name: 'Aisle X', status: 'pending', assignedAssocId: 'other_assoc' }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/done`,
      { assocNotes: 'Hack', capturedData: {} },
      assocToken
    );
    expect(res.status).toBe(403);
  });

  test('When all locations done → job auto-transitions to pending_review', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_only';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Only Location', status: 'pending', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/done`,
      { assocNotes: 'All done', capturedData: { units: 10 } },
      assocToken
    );
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.status).toBe('pending_review');
  });

  test('When only some locations done → job stays in_progress', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [
        { id: 'loc_1', name: 'Loc 1', status: 'pending', assignedAssocId: assocId },
        { id: 'loc_2', name: 'Loc 2', status: 'pending', assignedAssocId: assocId },
      ],
    });
    await put(`/api/jobs/${jobId}/locations/loc_1/done`, { assocNotes: 'ok', capturedData: {} }, assocToken);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.status).not.toBe('pending_review');
  });

  test('Non-existent location → 404', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({ assignedAssocId: [assocId], locations: [] });
    const res = await put(`/api/jobs/${jobId}/locations/no_such_loc/done`, { assocNotes: '', capturedData: {} }, assocToken);
    expect(res.status).toBe(404);
  });
});

describe('TC-WF-04: Submit for Review', () => {
  test('Assigned associate can submit for review → status pending_review', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({ status: 'in_progress', assignedAssocId: [assocId] });
    const res = await put(`/api/jobs/${jobId}/submit-review`,
      { fields: { cartons: 10 }, billable: true, associateNotes: 'All done' },
      assocToken
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_review');
    expect(res.body.submittedBy).toBe(assocId);
  });

  test('Job creator (office_support) can submit for review', async () => {
    const { supportToken, supportId } = setupBaseState();
    const jobId = seedJob({ status: 'in_progress', createdBy: supportId, assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/submit-review`, {}, supportToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_review');
  });

  test('Unrelated user cannot submit for review → 403', async () => {
    const { assocToken } = setupBaseState();
    const jobId = seedJob({ status: 'in_progress', createdBy: 'other', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/submit-review`, {}, assocToken);
    expect(res.status).toBe(403);
  });
});

describe('TC-WF-05: Complete Job (financial calculation)', () => {
  test('Manager can complete job → status completed with financial data', async () => {
    const { managerToken, assocId } = setupBaseState();
    // Seed rate cards + user cost
    const jobId = seedJob({
      status: 'pending_review',
      customerId: 'Acme Corp',
      jobTypeId: 'bts',
      assignedAssocId: [assocId],
    });
    const res = await put(`/api/jobs/${jobId}/complete`,
      { fields: { cartons: 100, labour_hours: 4 }, billable: true },
      managerToken
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    // Revenue = 100 cartons × $2.50 + 4 labour_hours × $45 = $250 + $180 = $430
    // Cost = 4h × $20 (assoc hourly cost) = $80
    // Profit = $430 - $80 = $350; Margin = 81.4% → Great
    expect(res.body.revenue).toBeCloseTo(430, 0);
    expect(res.body.cost).toBeCloseTo(80, 0);
    expect(res.body.profit).toBeCloseTo(350, 0);
    expect(res.body.rating).toBe('great');
  });

  test('Zero revenue → margin 0%, rating needs_improvement', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: {}, billable: false }, managerToken);
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(0);
    expect(res.body.marginPct).toBe(0);
    expect(res.body.rating).toBe('needs_improvement');
  });

  test('Associate cannot complete job directly (only manager/admin)', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({ status: 'pending_review', assignedAssocId: [assocId] });
    // Associates use submit-review, not complete — this tests that the complete endpoint
    // only grants manager/admin the final completion (associate-created path uses submit-review)
    // Associate IS allowed to complete if they created the job too, so test unrelated associate
    const token2 = store.createToken('other_assoc', 'associate', { email: 'other@test.com' });
    store.seedStore({
      wh_users: {
        ...store.getDoc('wh_users'),
        other_assoc: { uid: 'other_assoc', email: 'other@test.com', displayName: 'Other', role: 'associate', hourlyCost: 0, teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      },
    });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: {} }, token2);
    expect(res.status).toBe(403);
  });

  test('Good rating when margin between target-threshold and target', async () => {
    const { managerToken, assocId } = setupBaseState();
    // target=50%, good threshold=10% → good = 40-49%
    // cartons: 0 revenue, labour_hours: 4h → revenue=$180, cost=$80 → margin=55.6% → great
    // To get "good": revenue small, margin ~42% → cartons=0, labour_hours=1 → rev=$45, cost=$20 → margin=55.6% (great again)
    // Let's directly seed custom targets to force "good" margin
    store.seedStore({
      ...Object.fromEntries(['wh_users', 'wh_jobs'].map(k => [k, store.getDoc(k)])),
      wh_config: {
        customers: { list: ['Acme Corp'] },
        jobTypes: { list: [] },
        rateCards: { 'Acme Corp': { bts: { cartons: 1.00 } } }, // $1/carton
        targets: { bts: { targetMarginPct: 50, goodThresholdPct: 15 } },
      },
    });
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [assocId] });
    // 40 cartons × $1 = $40 rev, cost = 0 (no labour_hours rate) → margin 100% → great
    // Set assoc hourlyCost to make cost high: 40 cartons=$40, with labour_hours=1, assoc cost=$40/h → cost=$40, margin=0% → needs_improvement
    // Update assoc cost
    store.seedStore({
      wh_users: {
        ...store.getDoc('wh_users'),
        [assocId]: { ...store.getDoc('wh_users', assocId), hourlyCost: 20 },
      },
    });
    // cartons=50 → rev=$50, labour=1h → cost=$20 → profit=$30, margin=60% → great (above 50%)
    // cartons=20 → rev=$20, labour=1h → cost=$20 → profit=0, margin=0% → needs_improvement
    // cartons=30 → rev=$30, labour=1h → cost=$20 → profit=$10, margin=33.3% → needs_improvement (below 35%)
    // cartons=40, labour=1 → rev=$40, cost=$20 → profit=$20, margin=50% → great (>=50%)
    // For "good" (35-49%): cartons=28, labour=1 → rev=$28, cost=$20 → profit=$8, margin=28.6% → needs_improvement
    //   We need margin 35-49.9%: profit/rev=0.35 → profit=0.35*rev → rev-cost=0.35*rev → cost=0.65*rev → with cost=$20: rev=$30.77
    //   cartons=31, rev=$31, cost=$20 → margin=35.5% → GOOD!
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 31, labour_hours: 1 }, billable: true }, managerToken);
    expect(res.status).toBe(200);
    expect(res.body.rating).toBe('good');
  });
});
