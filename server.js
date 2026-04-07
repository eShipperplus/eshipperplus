'use strict';

const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { Parser } = require('json2csv');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
const firebaseConfig = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : undefined;

initializeApp(firebaseConfig ? { credential: cert(firebaseConfig) } : undefined);

const db = getFirestore();
const auth = getAuth();

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP handled separately for SPA
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const ROLES = ['admin', 'manager', 'associate', 'office_support'];
const STATUSES = ['created', 'assigned_manager', 'assigned_associate', 'in_progress', 'completed'];

const JOB_TYPE_DEFS = {
  bts: {
    id: 'bts',
    name: 'Back to Stock',
    fields: [
      { id: 'order_number', label: 'Order Number', type: 'text', required: true },
      { id: 'cartons', label: 'Cartons', type: 'number', required: false },
      { id: 'labels', label: 'Labels', type: 'number', required: false },
      { id: 'units', label: 'Units', type: 'number', required: false },
      { id: 'pallets_wrapped', label: 'Pallets Wrapped', type: 'number', required: false },
      { id: 'labour_hours', label: 'Labour Hours', type: 'number', required: false },
    ],
  },
  kit: {
    id: 'kit',
    name: 'Kitting',
    fields: [
      { id: 'labour_hours', label: 'Labour Hours', type: 'number', required: false },
      { id: 'units', label: 'Units', type: 'number', required: false },
      { id: 'pallets', label: 'Pallets', type: 'number', required: false },
      { id: 'labels', label: 'Labels', type: 'number', required: false },
      { id: 'skus', label: 'SKUs', type: 'number', required: false },
      { id: 'kits_made', label: 'Kits Made', type: 'number', required: false },
    ],
  },
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────
// Role source of truth: Firebase Custom Claims (set server-side, embedded in token)
// Firestore wh_users.role is kept in sync but the token claim wins on read.

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = header.slice(7);
  try {
    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email;
    req.displayName = decoded.name || decoded.email;

    const userRef = db.collection('wh_users').doc(decoded.uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      // Check if admin pre-invited this email
      const inviteSnap = await db.collection('wh_invites').doc(decoded.email.toLowerCase()).get();
      const invite = inviteSnap.exists ? inviteSnap.data() : null;

      const claimRole = invite?.role || (ROLES.includes(decoded.role) ? decoded.role : 'associate');
      const userData = {
        uid: decoded.uid,
        email: decoded.email,
        displayName: invite?.displayName || decoded.name || decoded.email,
        role: claimRole,
        teamId: invite?.teamId || null,
        hourlyCost: 0,
        createdAt: Timestamp.now(),
        lastSeen: Timestamp.now(),
      };
      await userRef.set(userData);

      // If invite had a team, add this user to the team's memberIds
      if (invite?.teamId) {
        db.collection('wh_teams').doc(invite.teamId).update({
          memberIds: FieldValue.arrayUnion(decoded.uid),
        }).catch(() => {});
      }

      // Consume the invite
      if (invite) inviteSnap.ref.delete().catch(() => {});
      // Stamp custom claim if not already set
      if (!decoded.role) {
        auth.setCustomUserClaims(decoded.uid, { role: claimRole }).catch(() => {});
      }
      req.user = userData;
    } else {
      const data = snap.data();
      userRef.update({ lastSeen: Timestamp.now() }).catch(() => {});

      // If custom claim role differs from Firestore (e.g. role was changed by admin),
      // the Firestore value is authoritative — re-stamp the claim so next token refresh picks it up
      const firestoreRole = data.role || 'associate';
      if (decoded.role !== firestoreRole) {
        auth.setCustomUserClaims(decoded.uid, { role: firestoreRole }).catch(() => {});
      }
      // Always use Firestore role (admin panel changes take effect immediately server-side)
      data.role = firestoreRole;
      req.user = data;
    }
    next();
  } catch (err) {
    console.error('requireAuth error:', err.message);
    return res.status(401).json({ error: 'Invalid auth token', detail: err.message });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ─── Audit Helper ─────────────────────────────────────────────────────────────
async function writeAudit(jobId, action, uid, name, before, after) {
  await db.collection('wh_audit').add({
    jobId,
    action,
    performedBy: uid,
    performedByName: name,
    timestamp: Timestamp.now(),
    before: before || null,
    after: after || null,
  });
}

// ─── Revenue Calculation ──────────────────────────────────────────────────────
async function calculateRevenueCost(job, fields) {
  const rateSnap = await db.collection('wh_config').doc('rateCards').get();
  const rateCards = rateSnap.exists ? rateSnap.data() : {};
  const rates = (rateCards[job.customerId] || {})[job.jobTypeId] || {};

  let revenue = 0;
  for (const [fieldId, value] of Object.entries(fields)) {
    if (typeof value === 'number' && rates[fieldId]) {
      revenue += value * rates[fieldId];
    }
  }

  // Cost: labour_hours × avg hourly cost of assigned associates
  let cost = 0;
  const assocIds = job.assignedAssocId || [];
  if (assocIds.length > 0 && fields.labour_hours) {
    const costPromises = assocIds.map((uid) =>
      db.collection('wh_users').doc(uid).get().then((s) => (s.exists ? s.data().hourlyCost || 0 : 0))
    );
    const costs = await Promise.all(costPromises);
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    cost = (fields.labour_hours || 0) * avgCost;
  }

  const profit = revenue - cost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  // Rating
  const targetSnap = await db.collection('wh_config').doc('targets').get();
  const targets = targetSnap.exists ? targetSnap.data() : {};
  const jobTargets = targets[job.jobTypeId] || {};
  const targetMargin = jobTargets.targetMarginPct || 50;
  const goodThreshold = jobTargets.goodThresholdPct || 10;

  let rating = 'needs_improvement';
  if (marginPct >= targetMargin) rating = 'great';
  else if (marginPct >= targetMargin - goodThreshold) rating = 'good';

  return { revenue, cost, profit, marginPct, rating };
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ─── Init ─────────────────────────────────────────────────────────────────────
app.get('/api/init', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;

    // Fetch config docs in parallel
    const [customersSnap, jobTypesSnap, rateCardsSnap, targetsSnap] = await Promise.all([
      db.collection('wh_config').doc('customers').get(),
      db.collection('wh_config').doc('jobTypes').get(),
      db.collection('wh_config').doc('rateCards').get(),
      db.collection('wh_config').doc('targets').get(),
    ]);

    const customers = customersSnap.exists ? customersSnap.data().list : [];
    const jobTypes = jobTypesSnap.exists ? jobTypesSnap.data().list : Object.values(JOB_TYPE_DEFS);
    const rateCards = rateCardsSnap.exists ? rateCardsSnap.data() : {};
    const targets = targetsSnap.exists ? targetsSnap.data() : {};

    // Fetch jobs scoped by role
    let jobsQuery = db.collection('wh_jobs').orderBy('createdAt', 'desc').limit(500);
    let jobsSnap;

    if (user.role === 'admin' || user.role === 'manager') {
      jobsSnap = await jobsQuery.get();
    } else if (user.role === 'office_support') {
      jobsSnap = await db
        .collection('wh_jobs')
        .where('createdBy', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
    } else {
      // Associate: own jobs + assigned jobs
      const [ownSnap, assignedSnap] = await Promise.all([
        db.collection('wh_jobs').where('createdBy', '==', uid).orderBy('createdAt', 'desc').limit(100).get(),
        db.collection('wh_jobs').where('assignedAssocId', 'array-contains', uid).orderBy('createdAt', 'desc').limit(100).get(),
      ]);
      const jobMap = new Map();
      [...ownSnap.docs, ...assignedSnap.docs].forEach((d) => jobMap.set(d.id, { id: d.id, ...d.data() }));
      const jobs = Array.from(jobMap.values());
      return res.json({ user, jobs, customers, jobTypes, rateCards, targets });
    }

    const jobs = jobsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const payload = { user, jobs, customers, jobTypes, rateCards, targets };

    // Admin-only: include all users and teams
    if (user.role === 'admin') {
      const [usersSnap, teamsSnap] = await Promise.all([
        db.collection('wh_users').get(),
        db.collection('wh_teams').get(),
      ]);
      payload.users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      payload.teams = teamsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    res.json(payload);
  } catch (err) {
    console.error('GET /api/init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────
app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;
    const { jobTypeId, customerId, fields, billable, dueDate, notes, assignedManagerId } = req.body;

    if (!jobTypeId || !customerId) {
      return res.status(400).json({ error: 'jobTypeId and customerId are required' });
    }
    // Validate against built-in types and any custom types stored in Firestore
    const jobTypesDoc = await db.collection('wh_config').doc('jobTypes').get();
    const validJobTypeIds = jobTypesDoc.exists
      ? (jobTypesDoc.data().list || []).map(jt => jt.id)
      : Object.keys(JOB_TYPE_DEFS);
    if (!validJobTypeIds.includes(jobTypeId)) {
      return res.status(400).json({ error: `Invalid jobTypeId: ${jobTypeId}` });
    }

    const now = Timestamp.now();
    const job = {
      jobTypeId,
      customerId,
      status: 'created',
      billable: billable !== false,
      fields: fields || {},
      dueDate: dueDate || null,
      notes: notes || '',
      createdBy: uid,
      createdByName: user.displayName,
      createdByEmail: user.email,
      createdByRole: user.role,
      createdAt: now,
      assignedManagerId: assignedManagerId || null,
      assignedManagerName: '',
      assignedAssocId: [],
      assignedAssocNames: [],
      completedBy: null,
      completedByName: null,
      completedAt: null,
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: now,
      revenue: null,
      cost: null,
      profit: null,
      marginPct: null,
      rating: null,
    };

    if (assignedManagerId) {
      const mgrSnap = await db.collection('wh_users').doc(assignedManagerId).get();
      if (mgrSnap.exists) {
        job.assignedManagerName = mgrSnap.data().displayName;
        job.status = 'assigned_manager';
      }
    }

    const docRef = await db.collection('wh_jobs').add(job);
    await writeAudit(docRef.id, 'created', uid, user.displayName, null, job);
    res.status(201).json({ id: docRef.id, ...job });
  } catch (err) {
    console.error('POST /api/jobs error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;
    const jobRef = db.collection('wh_jobs').doc(req.params.id);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Job not found' });

    const before = snap.data();

    // Permission check
    const canEdit =
      user.role === 'admin' ||
      user.role === 'manager' ||
      before.createdBy === uid ||
      (before.assignedAssocId || []).includes(uid);

    if (!canEdit) return res.status(403).json({ error: 'Cannot edit this job' });

    const allowedFields = ['fields', 'billable', 'dueDate', 'notes'];
    const update = { updatedBy: uid, updatedByName: user.displayName, updatedAt: Timestamp.now() };
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }

    await jobRef.update(update);
    await writeAudit(req.params.id, 'updated', uid, user.displayName, before, update);
    res.json({ id: req.params.id, ...before, ...update });
  } catch (err) {
    console.error('PUT /api/jobs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id/assign-manager', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { user, uid } = req;
    const { managerId } = req.body;
    if (!managerId) return res.status(400).json({ error: 'managerId required' });

    const [jobSnap, mgrSnap] = await Promise.all([
      db.collection('wh_jobs').doc(req.params.id).get(),
      db.collection('wh_users').doc(managerId).get(),
    ]);

    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    if (!mgrSnap.exists) return res.status(404).json({ error: 'Manager not found' });
    if (!['manager', 'admin'].includes(mgrSnap.data().role)) {
      return res.status(400).json({ error: 'User is not a manager' });
    }

    const before = jobSnap.data();
    const update = {
      assignedManagerId: managerId,
      assignedManagerName: mgrSnap.data().displayName,
      status: 'assigned_manager',
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: Timestamp.now(),
    };

    await db.collection('wh_jobs').doc(req.params.id).update(update);
    await writeAudit(req.params.id, 'assigned_manager', uid, user.displayName, before, update);
    res.json({ id: req.params.id, ...before, ...update });
  } catch (err) {
    console.error('PUT assign-manager error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id/assign-associate', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { user, uid } = req;
    const { associateIds } = req.body; // array
    if (!associateIds || !Array.isArray(associateIds) || associateIds.length === 0) {
      return res.status(400).json({ error: 'associateIds array required' });
    }

    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });

    const assocSnaps = await Promise.all(
      associateIds.map((id) => db.collection('wh_users').doc(id).get())
    );
    const validAssocs = assocSnaps.filter((s) => s.exists && ['associate', 'manager', 'admin'].includes(s.data().role));
    if (validAssocs.length === 0) return res.status(400).json({ error: 'No valid associates found' });

    const before = jobSnap.data();
    const update = {
      assignedAssocId: validAssocs.map((s) => s.id),
      assignedAssocNames: validAssocs.map((s) => s.data().displayName),
      status: 'assigned_associate',
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: Timestamp.now(),
    };

    await db.collection('wh_jobs').doc(req.params.id).update(update);
    await writeAudit(req.params.id, 'assigned_associate', uid, user.displayName, before, update);
    res.json({ id: req.params.id, ...before, ...update });
  } catch (err) {
    console.error('PUT assign-associate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id/complete', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });

    const job = jobSnap.data();

    // Permission: admin, manager, or assigned associate
    const canComplete =
      user.role === 'admin' ||
      user.role === 'manager' ||
      (job.assignedAssocId || []).includes(uid) ||
      job.createdBy === uid;

    if (!canComplete) return res.status(403).json({ error: 'Cannot complete this job' });

    const { fields, billable } = req.body;
    const mergedFields = { ...job.fields, ...(fields || {}) };

    const { revenue, cost, profit, marginPct, rating } = await calculateRevenueCost(
      { ...job, assignedAssocId: job.assignedAssocId || [] },
      mergedFields
    );

    const now = Timestamp.now();
    const update = {
      fields: mergedFields,
      billable: billable !== undefined ? billable : job.billable,
      status: 'completed',
      completedBy: uid,
      completedByName: user.displayName,
      completedAt: now,
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: now,
      revenue,
      cost,
      profit,
      marginPct,
      rating,
    };

    await db.collection('wh_jobs').doc(req.params.id).update(update);
    await writeAudit(req.params.id, 'completed', uid, user.displayName, job, update);
    res.json({ id: req.params.id, ...job, ...update, rating });
  } catch (err) {
    console.error('PUT complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/jobs/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { user, uid } = req;
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });

    const before = jobSnap.data();
    await db.collection('wh_jobs').doc(req.params.id).delete();
    await writeAudit(req.params.id, 'deleted', uid, user.displayName, before, null);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/jobs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CSV Export ───────────────────────────────────────────────────────────────
app.get('/api/export/csv', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { customerId, jobTypeId, billable, dateFrom, dateTo } = req.query;

    let query = db.collection('wh_jobs').orderBy('createdAt', 'desc');
    if (customerId) query = query.where('customerId', '==', customerId);
    if (jobTypeId) query = query.where('jobTypeId', '==', jobTypeId);
    if (billable !== undefined) query = query.where('billable', '==', billable === 'true');

    const snap = await query.get();
    let jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Date filter post-query
    if (dateFrom) {
      const from = new Date(dateFrom);
      jobs = jobs.filter((j) => j.createdAt && j.createdAt.toDate() >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      jobs = jobs.filter((j) => j.createdAt && j.createdAt.toDate() <= to);
    }

    const rows = jobs.map((j) => ({
      Date: j.createdAt ? j.createdAt.toDate().toISOString().split('T')[0] : '',
      Customer: j.customerId || '',
      'Job Type': j.jobTypeId === 'bts' ? 'Back to Stock' : j.jobTypeId === 'kit' ? 'Kitting' : j.jobTypeId,
      Status: j.status || '',
      Billable: j.billable ? 'Yes' : 'No',
      'Assigned Associates': (j.assignedAssocNames || []).join('; '),
      'Order Number': j.fields?.order_number || '',
      'Labour Hours': j.fields?.labour_hours || '',
      'Units Handled': j.fields?.units || '',
      Pallets: j.fields?.pallets || '',
      Labels: j.fields?.labels || '',
      SKUs: j.fields?.skus || '',
      'Kits Made': j.fields?.kits_made || '',
      Cartons: j.fields?.cartons || '',
      'Pallets Wrapped': j.fields?.pallets_wrapped || '',
      Revenue: j.revenue != null ? j.revenue.toFixed(2) : '',
      Cost: j.cost != null ? j.cost.toFixed(2) : '',
      Profit: j.profit != null ? j.profit.toFixed(2) : '',
      'Margin %': j.marginPct != null ? j.marginPct.toFixed(1) : '',
      Rating: j.rating || '',
      'Created By': j.createdByName || '',
      'Created At': j.createdAt ? j.createdAt.toDate().toISOString() : '',
      'Completed By': j.completedByName || '',
      'Completed At': j.completedAt ? j.completedAt.toDate().toISOString() : '',
    }));

    const parser = new Parser();
    const csv = parser.parse(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="warehouse-jobs-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('GET /api/export/csv error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Config Routes ────────────────────────────────────────────────────────────
app.put('/api/customers', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { list } = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'list must be an array' });
    await db.collection('wh_config').doc('customers').set({ list });
    res.json({ list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a customer and update all jobs that reference the old name
app.put('/api/customers/rename', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
    if (oldName === newName) return res.json({ updated: 0 });

    // Update the customers list
    const custRef = db.collection('wh_config').doc('customers');
    const custSnap = await custRef.get();
    const list = custSnap.exists ? (custSnap.data().list || []) : [];
    const newList = list.map(c => c === oldName ? newName : c);
    await custRef.set({ list: newList });

    // Batch update all jobs referencing the old customer name
    const jobsSnap = await db.collection('wh_jobs').where('customerId', '==', oldName).get();
    const batch = db.batch();
    jobsSnap.docs.forEach(d => batch.update(d.ref, { customerId: newName }));
    await batch.commit();

    res.json({ list: newList, updated: jobsSnap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a user's profile fields (name, hourlyCost, teamId) — role has its own endpoint
app.put('/api/users/:uid/profile', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { displayName, hourlyCost, teamId } = req.body;
    const update = { updatedAt: Timestamp.now() };
    if (displayName !== undefined) update.displayName = displayName;
    if (hourlyCost !== undefined) update.hourlyCost = Number(hourlyCost) || 0;
    if (teamId !== undefined) update.teamId = teamId || null;
    await db.collection('wh_users').doc(req.params.uid).update(update);
    // If team changed, update team memberIds
    if (teamId !== undefined) {
      // Remove from all teams first
      const teamsSnap = await db.collection('wh_teams').get();
      const teamBatch = db.batch();
      teamsSnap.docs.forEach(t => {
        teamBatch.update(t.ref, { memberIds: FieldValue.arrayRemove(req.params.uid) });
      });
      await teamBatch.commit();
      // Add to new team
      if (teamId) {
        await db.collection('wh_teams').doc(teamId).update({
          memberIds: FieldValue.arrayUnion(req.params.uid),
        });
      }
    }
    res.json({ uid: req.params.uid, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobtypes', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { list } = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'list must be an array' });
    await db.collection('wh_config').doc('jobTypes').set({ list });
    res.json({ list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rates', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rates = req.body; // { [customerId]: { [jobTypeId]: { [fieldId]: number } } }
    await db.collection('wh_config').doc('rateCards').set(rates);
    res.json(rates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/targets', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const targets = req.body; // { [jobTypeId]: { targetMarginPct, goodThresholdPct } }
    await db.collection('wh_config').doc('targets').set(targets);
    res.json(targets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const snap = await db.collection('wh_users').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:uid/role', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Write to both Firestore AND Firebase custom claims so role is in the token itself
    await Promise.all([
      db.collection('wh_users').doc(req.params.uid).update({ role }),
      auth.setCustomUserClaims(req.params.uid, { role }),
    ]);
    res.json({ uid: req.params.uid, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:uid/cost', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { hourlyCost } = req.body;
    if (typeof hourlyCost !== 'number' || hourlyCost < 0) {
      return res.status(400).json({ error: 'hourlyCost must be a non-negative number' });
    }
    await db.collection('wh_users').doc(req.params.uid).update({ hourlyCost });
    res.json({ uid: req.params.uid, hourlyCost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Invite a user by email — creates Firebase Auth account and returns a password-set link
app.post('/api/users/invite', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { email, displayName, role, teamId } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const emailKey = email.toLowerCase().trim();
    const nameToUse = displayName || email.split('@')[0];

    // Check if Firebase Auth user already exists
    let authUser = null;
    try {
      authUser = await auth.getUserByEmail(emailKey);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    // Check if user already exists in wh_users by email
    const existingSnap = await db.collection('wh_users').where('email', '==', emailKey).limit(1).get();
    if (!existingSnap.empty) {
      // User already signed up — update their record directly
      const existingDoc = existingSnap.docs[0];
      const updates = {};
      if (role) updates.role = role;
      if (displayName) updates.displayName = displayName;
      if (teamId !== undefined) updates.teamId = teamId;
      await existingDoc.ref.update(updates);
      if (role) await auth.setCustomUserClaims(existingDoc.id, { role }).catch(() => {});
      if (teamId) {
        await db.collection('wh_teams').doc(teamId).update({
          memberIds: FieldValue.arrayUnion(existingDoc.id),
        }).catch(() => {});
      }
      // Generate password reset link so admin can share it
      const resetLink = await auth.generatePasswordResetLink(emailKey).catch(() => null);
      return res.json({ status: 'updated', uid: existingDoc.id, resetLink });
    }

    // Create Firebase Auth account if it doesn't exist yet
    if (!authUser) {
      authUser = await auth.createUser({
        email: emailKey,
        displayName: nameToUse,
        emailVerified: false,
      });
    }

    // Set custom claims for role immediately
    const claimRole = role || 'associate';
    await auth.setCustomUserClaims(authUser.uid, { role: claimRole });

    // Store invite so requireAuth picks up role/team on first sign-in
    await db.collection('wh_invites').doc(emailKey).set({
      email: emailKey,
      displayName: nameToUse,
      role: claimRole,
      teamId: teamId || null,
      invitedBy: req.uid,
      invitedAt: Timestamp.now(),
    });

    // Generate a password-set link (looks like password reset but lets them choose their password)
    const resetLink = await auth.generatePasswordResetLink(emailKey).catch(() => null);

    res.json({ status: 'invited', email: emailKey, uid: authUser.uid, resetLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate a password reset link for any user (admin only)
app.post('/api/users/:uid/reset-password-link', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const userRecord = await auth.getUser(req.params.uid);
    if (!userRecord.email) return res.status(400).json({ error: 'User has no email address' });
    const resetLink = await auth.generatePasswordResetLink(userRecord.email);
    res.json({ resetLink, email: userRecord.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:uid', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (req.params.uid === req.uid) return res.status(400).json({ error: 'Cannot delete yourself' });
    await db.collection('wh_users').doc(req.params.uid).delete();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Teams ────────────────────────────────────────────────────────────────────
app.get('/api/teams', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const snap = await db.collection('wh_teams').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/teams', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, managerId, memberIds } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const team = { name, managerId: managerId || null, memberIds: memberIds || [] };
    const ref = await db.collection('wh_teams').add(team);
    res.status(201).json({ id: ref.id, ...team });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/teams/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, managerId, memberIds } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (managerId !== undefined) update.managerId = managerId;
    if (memberIds !== undefined) update.memberIds = memberIds;
    await db.collection('wh_teams').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add or remove a single member from a team
app.put('/api/teams/:id/members', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { action, uid } = req.body; // action: 'add' | 'remove'
    if (!uid) return res.status(400).json({ error: 'uid required' });
    const update = action === 'add'
      ? { memberIds: FieldValue.arrayUnion(uid) }
      : { memberIds: FieldValue.arrayRemove(uid) };
    await db.collection('wh_teams').doc(req.params.id).update(update);
    // Keep wh_users.teamId in sync
    if (action === 'add') {
      await db.collection('wh_users').doc(uid).update({ teamId: req.params.id }).catch(() => {});
    } else {
      await db.collection('wh_users').doc(uid).update({ teamId: null }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/teams/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.collection('wh_teams').doc(req.params.id).delete();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Warehouse Billing server listening on port ${PORT}`));
