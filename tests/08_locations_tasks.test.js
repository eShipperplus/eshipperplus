'use strict';
/**
 * TC-LOC: Location / Task Management Tests
 * Covers: reopen task, referenceDataTypes, updatedRefData, associate add-task,
 *         photo upload, location Excel export
 */

const store = require('./helpers/store');
const { get, post, put, del, setupBaseState, seedJob } = require('./helpers/api');

beforeEach(() => store.reset());

// ─── TC-LOC-01: Reopen Task ───────────────────────────────────────────────────

describe('TC-LOC-01: Reopen Task', () => {
  test('Manager can reopen a done location', async () => {
    const { managerToken, assocId } = setupBaseState();
    const locId = 'loc_done';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Shelf A', status: 'done', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/reopen`, {}, managerToken);
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.status).toBe('pending');
  });

  test('Assigned associate can reopen their own done location', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_mine';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Shelf B', status: 'done', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/reopen`, {}, assocToken);
    expect(res.status).toBe(200);
  });

  test('Unrelated associate cannot reopen location → 403', async () => {
    const { assocId } = setupBaseState();
    store.seedStore({
      wh_users: {
        ...store.getDoc('wh_users'),
        other_assoc: { uid: 'other_assoc', email: 'other@test.com', displayName: 'Other', role: 'associate', hourlyCost: 0, teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      },
    });
    const otherToken = store.createToken('other_assoc', 'associate', { email: 'other@test.com' });
    const locId = 'loc_x';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Shelf X', status: 'done', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/reopen`, {}, otherToken);
    expect(res.status).toBe(403);
  });

  test('Cannot reopen location on a completed job → 400', async () => {
    const { adminToken, assocId } = setupBaseState();
    const locId = 'loc_c';
    const jobId = seedJob({
      status: 'completed',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Completed Loc', status: 'done', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/reopen`, {}, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/completed/i);
  });

  test('Reopening a location on pending_review job reverts job status to in_progress', async () => {
    const { managerToken, assocId } = setupBaseState();
    const locId = 'loc_r';
    const jobId = seedJob({
      status: 'pending_review',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Revisit', status: 'done', assignedAssocId: assocId }],
    });
    await put(`/api/jobs/${jobId}/locations/${locId}/reopen`, {}, managerToken);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.status).toBe('in_progress');
  });

  test('Reopen nonexistent location → 404', async () => {
    const { adminToken } = setupBaseState();
    const jobId = seedJob({ assignedAssocId: [], locations: [] });
    const res = await put(`/api/jobs/${jobId}/locations/no_such/reopen`, {}, adminToken);
    expect(res.status).toBe(404);
  });
});

// ─── TC-LOC-02: referenceDataTypes ───────────────────────────────────────────

describe('TC-LOC-02: referenceDataTypes saved by manager on PUT locations', () => {
  test('Manager saves referenceDataTypes alongside locations', async () => {
    const { managerToken, assocId } = setupBaseState();
    const jobId = seedJob({ status: 'assigned_manager', assignedAssocId: [] });
    const referenceDataTypes = { 'Expiry Date': 'date', SKU: 'text', Qty: 'number' };
    const res = await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: 'loc1', name: 'BIN24-A', assignedAssocId: assocId, referenceData: { 'Expiry Date': '', SKU: '', Qty: '' } }],
      referenceDataTypes,
    }, managerToken);
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.referenceDataTypes).toEqual(referenceDataTypes);
  });

  test('All three column types (text, number, date) are persisted correctly', async () => {
    const { adminToken, assocId } = setupBaseState();
    const jobId = seedJob({ status: 'assigned_manager', assignedAssocId: [] });
    await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: 'loc_a', name: 'BIN-A', assignedAssocId: assocId }],
      referenceDataTypes: { Qty: 'number', Notes: 'text', 'MFG Date': 'date' },
    }, adminToken);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.referenceDataTypes.Qty).toBe('number');
    expect(job.referenceDataTypes.Notes).toBe('text');
    expect(job.referenceDataTypes['MFG Date']).toBe('date');
  });

  test('Empty referenceDataTypes object is accepted', async () => {
    const { adminToken, assocId } = setupBaseState();
    const jobId = seedJob({ assignedAssocId: [] });
    const res = await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: 'loc_b', name: 'BIN-B', assignedAssocId: assocId }],
      referenceDataTypes: {},
    }, adminToken);
    expect(res.status).toBe(200);
  });
});

// ─── TC-LOC-03: updatedRefData on mark-done ──────────────────────────────────

describe('TC-LOC-03: Reference data corrected on mark-done (updatedRefData)', () => {
  test('Associate corrects reference data values when marking done', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_ref';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      referenceDataTypes: { 'Expiry Date': 'date', SKU: 'text' },
      locations: [{
        id: locId, name: 'BIN99', status: 'pending', assignedAssocId: assocId,
        referenceData: { 'Expiry Date': '20251201', SKU: 'SKU-100' },
      }],
    });
    const res = await put(`/api/jobs/${jobId}/locations/${locId}/done`, {
      assocNotes: 'Corrected expiry',
      capturedData: {},
      updatedRefData: { 'Expiry Date': '20260101', SKU: 'SKU-100' },
    }, assocToken);
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.referenceData['Expiry Date']).toBe('20260101');
    expect(loc.referenceData.SKU).toBe('SKU-100');
    expect(loc.status).toBe('done');
  });

  test('updatedRefData merges with existing keys — does not wipe unlisted fields', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_merge';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{
        id: locId, name: 'BIN-M', status: 'pending', assignedAssocId: assocId,
        referenceData: { PO: 'PO-001', SKU: 'SKU-200', Qty: '50' },
      }],
    });
    await put(`/api/jobs/${jobId}/locations/${locId}/done`, {
      assocNotes: '',
      capturedData: {},
      updatedRefData: { SKU: 'SKU-200-CORR' },
    }, assocToken);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.referenceData.PO).toBe('PO-001');
    expect(loc.referenceData.Qty).toBe('50');
    expect(loc.referenceData.SKU).toBe('SKU-200-CORR');
  });

  test('mark-done without updatedRefData preserves original referenceData', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_noref';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{
        id: locId, name: 'BIN-NR', status: 'pending', assignedAssocId: assocId,
        referenceData: { PO: 'PO-999' },
      }],
    });
    await put(`/api/jobs/${jobId}/locations/${locId}/done`, { assocNotes: '', capturedData: {} }, assocToken);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.referenceData.PO).toBe('PO-999');
  });
});

// ─── TC-LOC-04: Associate add-task ───────────────────────────────────────────

describe('TC-LOC-04: Associates can add new tasks (not modify existing ones)', () => {
  test('Assigned associate can add a new location', async () => {
    const { assocToken, assocId } = setupBaseState();
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: 'loc_existing', name: 'Old Loc', status: 'pending', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: 'loc_new_1', name: 'BIN25-B', assignedAssocId: assocId, referenceData: { SKU: 'SKU-300' } }],
    }, assocToken);
    expect(res.status).toBe(200);
    const job = store.getDoc('wh_jobs', jobId);
    expect(job.locations.some(l => l.name === 'BIN25-B')).toBe(true);
  });

  test('Associate cannot modify existing location IDs → 403', async () => {
    const { assocToken, assocId } = setupBaseState();
    const existingLocId = 'loc_ex';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: existingLocId, name: 'Original', status: 'pending', assignedAssocId: assocId }],
    });
    const res = await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: existingLocId, name: 'Hacked Name', assignedAssocId: assocId }],
    }, assocToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/modify existing/i);
  });

  test('Unassigned associate cannot add tasks → 403', async () => {
    const { assocId } = setupBaseState();
    store.seedStore({
      wh_users: {
        ...store.getDoc('wh_users'),
        assoc_b: { uid: 'assoc_b', email: 'b@test.com', displayName: 'B', role: 'associate', hourlyCost: 0, teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      },
    });
    const otherToken = store.createToken('assoc_b', 'associate', { email: 'b@test.com' });
    const jobId = seedJob({ status: 'in_progress', assignedAssocId: [assocId], locations: [] });
    const res = await put(`/api/jobs/${jobId}/locations`, {
      locations: [{ id: 'loc_n', name: 'BIN99', assignedAssocId: 'assoc_b' }],
    }, otherToken);
    expect(res.status).toBe(403);
  });
});

// ─── TC-LOC-05: Photo Upload ──────────────────────────────────────────────────

describe('TC-LOC-05: Photo Upload', () => {
  const smallJpeg = 'data:image/jpeg;base64,' + Buffer.from('FAKEJPEGDATA').toString('base64');

  test('Authenticated user can upload a photo to a location', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_photo';
    const jobId = seedJob({
      status: 'in_progress',
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Photo Loc', status: 'pending', assignedAssocId: assocId, photos: [] }],
    });
    const res = await post(`/api/jobs/${jobId}/locations/${locId}/photos`, { imageData: smallJpeg }, assocToken);
    expect(res.status).toBe(200);
    expect(res.body.url).toBeDefined();
    expect(typeof res.body.url).toBe('string');
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.photos).toHaveLength(1);
  });

  test('Missing imageData → 400', async () => {
    const { assocToken, assocId } = setupBaseState();
    const locId = 'loc_nophoto';
    const jobId = seedJob({
      assignedAssocId: [assocId],
      locations: [{ id: locId, name: 'Loc', status: 'pending', assignedAssocId: assocId }],
    });
    const res = await post(`/api/jobs/${jobId}/locations/${locId}/photos`, {}, assocToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageData/i);
  });

  test('Photo upload on nonexistent job → 404', async () => {
    const { assocToken } = setupBaseState();
    const res = await post('/api/jobs/ghost_job/locations/loc_1/photos', { imageData: smallJpeg }, assocToken);
    expect(res.status).toBe(404);
  });

  test('Multiple photos accumulate in the location array', async () => {
    const { adminToken } = setupBaseState();
    const locId = 'loc_multi';
    const jobId = seedJob({
      assignedAssocId: [],
      locations: [{ id: locId, name: 'Multi', status: 'pending', photos: [] }],
    });
    await post(`/api/jobs/${jobId}/locations/${locId}/photos`, { imageData: smallJpeg }, adminToken);
    await post(`/api/jobs/${jobId}/locations/${locId}/photos`, { imageData: smallJpeg }, adminToken);
    const job = store.getDoc('wh_jobs', jobId);
    const loc = job.locations.find(l => l.id === locId);
    expect(loc.photos).toHaveLength(2);
  });
});

// ─── TC-LOC-06: Location Excel Export ────────────────────────────────────────

describe('TC-LOC-06: Excel Export', () => {
  test('Manager can export job locations to Excel', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({
      status: 'completed',
      locations: [
        { id: 'l1', name: 'BIN-A', status: 'done', assignedAssocId: null, referenceData: { SKU: 'SKU-001' }, capturedData: { cartons: 5 }, assocNotes: 'ok', photos: [] },
        { id: 'l2', name: 'BIN-B', status: 'done', assignedAssocId: null, referenceData: { SKU: 'SKU-002' }, capturedData: { cartons: 3 }, assocNotes: '', photos: [] },
      ],
    });
    const res = await get(`/api/jobs/${jobId}/export/locations`, managerToken);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheet|excel|octet/i);
  });

  test('Export job with no locations → 400', async () => {
    const { managerToken } = setupBaseState();
    const jobId = seedJob({ status: 'completed', locations: [] });
    const res = await get(`/api/jobs/${jobId}/export/locations`, managerToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no locations/i);
  });

  test('Export nonexistent job → 404', async () => {
    const { managerToken } = setupBaseState();
    const res = await get('/api/jobs/ghost_job/export/locations', managerToken);
    expect(res.status).toBe(404);
  });
});
