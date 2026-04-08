'use strict';
/**
 * TC-BL: Business Logic Unit Tests
 * Covers: computeFieldDiff, calculateRevenueCost (via API), financial edge cases, audit diff
 */

const store = require('./helpers/store');
const { put, setupBaseState, seedJob } = require('./helpers/api');

beforeEach(() => store.reset());

describe('TC-BL-01: Financial Calculation Edge Cases', () => {
  test('No rate card for customer → revenue is 0', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({ status: 'pending_review', customerId: 'Widget Co', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 100, units: 500 }, billable: true }, managerToken);
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(0);
    expect(res.body.profit).toBe(0);
  });

  test('No associates assigned → cost is 0 even with labour_hours', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { labour_hours: 10 }, billable: true }, managerToken);
    expect(res.status).toBe(200);
    // labour_hours rate = 45, so revenue = 450; no associates so cost = 0
    expect(res.body.revenue).toBeCloseTo(450, 0);
    expect(res.body.cost).toBe(0);
    expect(res.body.profit).toBeCloseTo(450, 0);
  });

  test('Multiple associates → cost uses average hourly rate', async () => {
    const { managerToken, assocId } = setupBaseState();
    // assoc1 = $20/h, assoc2 = $40/h → avg = $30/h
    const assoc2Id = 'assoc2';
    store.seedStore({
      wh_users: {
        ...store.getDoc('wh_users'),
        [assoc2Id]: { uid: assoc2Id, email: 'assoc2@test.com', displayName: 'Assoc 2', role: 'associate', hourlyCost: 40, teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      },
    });
    store.createToken(assoc2Id, 'associate', { email: 'assoc2@test.com' });
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [assocId, assoc2Id] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { labour_hours: 2 }, billable: true }, managerToken);
    expect(res.status).toBe(200);
    // cost = 2h × avg($20+$40)/2 = 2 × $30 = $60
    expect(res.body.cost).toBeCloseTo(60, 1);
  });

  test('Rating = great when margin ≥ targetMarginPct', async () => {
    const { managerToken } = setupBaseState();
    // Default target = 50%. Revenue=200, cost=0 → margin=100% → great
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 80 }, billable: true }, managerToken);
    expect(res.body.rating).toBe('great'); // margin = 100%
  });

  test('Rating = needs_improvement when margin < (target - threshold)', async () => {
    const { managerToken, assocId } = setupBaseState();
    // Override rate card: only cartons at $1/unit, NO labour_hours rate
    // So revenue = cartons × $1, cost = labour_hours × $20 (assoc hourly)
    // 5 cartons = $5 rev, 10 labour_hours = $200 cost → profit = -$195 → needs_improvement
    store.seedStore({
      wh_users: store.getDoc('wh_users'),
      wh_config: {
        customers: { list: ['Acme Corp'] },
        rateCards: { 'Acme Corp': { bts: { cartons: 1.00 } } }, // no labour_hours rate
        targets:   { bts: { targetMarginPct: 50, goodThresholdPct: 10 } },
      },
    });
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [assocId] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 5, labour_hours: 10 }, billable: true }, managerToken);
    expect(res.status).toBe(200);
    // rev = $5, cost = 10×$20 = $200 → profit = -$195 → margin < 0 → needs_improvement
    expect(res.body.rating).toBe('needs_improvement');
  });

  test('Non-billable job still calculates financials', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({ status: 'pending_review', customerId: 'Acme Corp', jobTypeId: 'bts', assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/complete`, { fields: { cartons: 50 }, billable: false }, managerToken);
    expect(res.status).toBe(200);
    expect(res.body.billable).toBe(false);
    expect(res.body.revenue).toBeGreaterThan(0);
  });
});

describe('TC-BL-02: Audit Diff (computeFieldDiff)', () => {
  test('Single field change recorded in diff', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ notes: 'Original', billable: true });
    await put(`/api/jobs/${jobId}`, { notes: 'Changed', billable: true }, adminToken);
    const audits = store.getAllDocs('wh_audit').filter(a => a.jobId === jobId && a.action === 'updated');
    expect(audits.length).toBeGreaterThan(0);
    const diff = audits[audits.length - 1].changes;
    expect(diff.notes).toEqual({ from: 'Original', to: 'Changed' });
  });

  test('Edit with no user-visible field change → changes only contains system fields', async () => {
    // Server always updates updatedBy/updatedByName/updatedAt so diff is never fully null.
    // Verify that business fields (notes, billable) are NOT in diff when unchanged.
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ notes: 'Same', billable: true });
    await put(`/api/jobs/${jobId}`, { notes: 'Same', billable: true }, adminToken);
    const audits = store.getAllDocs('wh_audit').filter(a => a.jobId === jobId && a.action === 'updated');
    if (audits.length > 0) {
      const diff = audits[audits.length - 1].changes || {};
      expect(diff.notes).toBeUndefined();    // notes unchanged → not in diff
      expect(diff.billable).toBeUndefined(); // billable unchanged → not in diff
    }
  });

  test('Multiple fields changed → all in diff', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ notes: 'Old', billable: true, dueDate: '2025-01-01' });
    await put(`/api/jobs/${jobId}`, { notes: 'New', billable: false, dueDate: '2025-12-31' }, adminToken);
    const audits = store.getAllDocs('wh_audit').filter(a => a.jobId === jobId && a.action === 'updated');
    const diff = audits[audits.length - 1]?.changes || {};
    expect(diff.notes?.to).toBe('New');
    expect(diff.billable?.to).toBe(false);
  });
});

describe('TC-BL-03: Location Bulk Update', () => {
  test('Saving locations preserves existing capturedData and status', async () => {
    const { adminToken, assocId } = setupBaseState();
    const existingLocs = [
      { id: 'loc_1', name: 'Aisle A', status: 'done', assignedAssocId: assocId, capturedData: { cartons: 5 }, assocNotes: 'Done' },
      { id: 'loc_2', name: 'Aisle B', status: 'pending', assignedAssocId: null, capturedData: {} },
    ];
    const jobId = seedJob({ status: 'in_progress', assignedAssocId: [assocId], locations: existingLocs });

    // PUT new locations list (manager updates assignments without clearing existing data)
    const updatedLocs = [
      { id: 'loc_1', name: 'Aisle A', assignedAssocId: assocId }, // already done
      { id: 'loc_2', name: 'Aisle B', assignedAssocId: assocId }, // assign now
      { id: 'loc_3', name: 'Aisle C', assignedAssocId: assocId }, // new location
    ];
    const res = await put(`/api/jobs/${jobId}/locations`, { locations: updatedLocs }, adminToken);
    expect(res.status).toBe(200);

    const job = store.getDoc('wh_jobs', jobId);
    const loc1 = job.locations.find(l => l.id === 'loc_1');
    expect(loc1.status).toBe('done'); // preserved
    expect(loc1.capturedData.cartons).toBe(5); // preserved

    const loc3 = job.locations.find(l => l.id === 'loc_3');
    expect(loc3).toBeDefined();
    expect(loc3.status).toBe('pending'); // new location starts pending
  });
});
