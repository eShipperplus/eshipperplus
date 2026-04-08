'use strict';

const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { Parser } = require('json2csv');
const XLSX = require('xlsx');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
const firebaseConfig = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : undefined;

const STORAGE_BUCKET = 'eshipper-f56c3.firebasestorage.app';
initializeApp(firebaseConfig
  ? { credential: cert(firebaseConfig), storageBucket: STORAGE_BUCKET }
  : { storageBucket: STORAGE_BUCKET });

const db = getFirestore();
const auth = getAuth();
const bucket = getStorage().bucket();

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP handled separately for SPA
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const ROLES = ['admin', 'manager', 'associate', 'office_support'];
const STATUSES = ['created', 'assigned_manager', 'assigned_associate', 'in_progress', 'pending_review', 'completed'];

const JOB_TYPE_DEFS = {
  bts: {
    id: 'bts', name: 'Back to Stock', color: 'blue',
    fields: [
      { id: 'order_number',    label: 'SO Code / Order Number',  type: 'text',   required: true  },
      { id: 'pallets_provided', label: 'Pallets Provided',       type: 'number', required: false },
      { id: 'pallets_wrapped', label: 'Pallets Wrapped & Shipped', type: 'number', required: false },
      { id: 'cartons',         label: 'Cartons Handled',         type: 'number', required: false },
      { id: 'labels',          label: 'Labels Applied',          type: 'number', required: false },
      { id: 'units',           label: 'Units Handled',           type: 'number', required: false },
      { id: 'inspection_hours', label: 'Inspection Hours',       type: 'number', required: false },
    ],
  },
  kit: {
    id: 'kit', name: 'Kitting', color: 'teal',
    fields: [
      { id: 'special_packaging', label: 'Special Packaging',     type: 'text',   required: false },
      { id: 'kits_made',         label: 'Number of Kits',        type: 'number', required: true  },
      { id: 'labour_hours',      label: 'Labour Hours',          type: 'number', required: false },
      { id: 'units',             label: 'Units Handled',         type: 'number', required: false },
      { id: 'cartons',           label: 'Cartons Handled',       type: 'number', required: false },
      { id: 'pallets',           label: 'Pallets Handled',       type: 'number', required: false },
      { id: 'labels',            label: 'Labeling',              type: 'number', required: false },
      { id: 'skus',              label: 'Number of SKUs',        type: 'number', required: false },
    ],
  },
  cycle_count: {
    id: 'cycle_count', name: 'Cycle Count', color: 'purple',
    fields: [
      { id: 'labour_hours',         label: 'Labour Hours',              type: 'number', required: false },
      { id: 'bins',                 label: 'Number of Bins',            type: 'number', required: false },
      { id: 'pallets_shrink_wrapped', label: 'Pallets Shrink Wrapped',  type: 'number', required: false },
      { id: 'pallets_put_away',     label: 'Pallets Put Away',          type: 'number', required: false },
      { id: 'pallets_let_down',     label: 'Pallets Let Down',          type: 'number', required: false },
      { id: 'pallets_consolidated', label: 'Pallets Consolidated',      type: 'number', required: false },
      { id: 'units',                label: 'Units Handled',             type: 'number', required: false },
      { id: 'unit_labels',          label: 'Unit Labels Applied',       type: 'number', required: false },
      { id: 'carton_labels',        label: 'Carton Labels Applied',     type: 'number', required: false },
      { id: 'cartons',              label: 'Cartons Handled',           type: 'number', required: false },
    ],
  },
  disposal: {
    id: 'disposal', name: 'Disposal', color: 'red',
    fields: [
      { id: 'disposal_type',    label: 'Type of Disposal',   type: 'select', required: true,
        options: ['Damage', 'Expired', 'Customer Request', 'Returns', 'Closeout Inventory'] },
      { id: 'weight',           label: 'Weight (lbs)',        type: 'number', required: false },
      { id: 'inspection_hours', label: 'Inspection Hours',    type: 'number', required: false },
      { id: 'units',            label: 'Units Handled',       type: 'number', required: false },
      { id: 'pallets',          label: 'Number of Pallets',   type: 'number', required: false },
    ],
  },
  consolidation: {
    id: 'consolidation', name: 'Consolidation', color: 'orange',
    fields: [
      { id: 'labour_hours', label: 'Labour Hours',      type: 'number', required: false },
      { id: 'units',        label: 'Units Handled',     type: 'number', required: false },
      { id: 'pallets',      label: 'Number of Pallets', type: 'number', required: false },
      { id: 'cartons',      label: 'Cartons Handled',   type: 'number', required: false },
    ],
  },
  closeout: {
    id: 'closeout', name: 'Closeout', color: 'yellow',
    fields: [
      { id: 'pallets',      label: 'Number of Pallets', type: 'number', required: false },
      { id: 'labour_hours', label: 'Labour Hours',      type: 'number', required: false },
      { id: 'units',        label: 'Units Handled',     type: 'number', required: false },
      { id: 'cartons',      label: 'Cartons Handled',   type: 'number', required: false },
    ],
  },
  image_request: {
    id: 'image_request', name: 'Image Request', color: 'pink',
    fields: [
      { id: 'labour_hours', label: 'Labour Hours',      type: 'number', required: false },
      { id: 'units',        label: 'Units Handled',     type: 'number', required: false },
      { id: 'cartons',      label: 'Cartons Handled',   type: 'number', required: false },
    ],
  },
  capture_item_details: {
    id: 'capture_item_details', name: 'Capture Item Details', color: 'gray',
    fields: [
      { id: 'units',        label: 'Units Handled',     type: 'number', required: false },
      { id: 'labour_hours', label: 'Labour Hours',      type: 'number', required: false },
      { id: 'cartons',      label: 'Cartons Handled',   type: 'number', required: false },
    ],
  },
  miscellaneous: {
    id: 'miscellaneous', name: 'Miscellaneous', color: 'gray',
    fields: [
      { id: 'units',        label: 'Units Handled',     type: 'number', required: false },
      { id: 'pallets',      label: 'Number of Pallets', type: 'number', required: false },
      { id: 'cartons',      label: 'Cartons Handled',   type: 'number', required: false },
      { id: 'labour_hours', label: 'Labour Hours',      type: 'number', required: false },
    ],
  },
  returns_inspection: {
    id: 'returns_inspection', name: 'Returns Inspection', color: 'orange',
    fields: [
      { id: 'condition',        label: 'Item Condition',     type: 'select', required: true,
        options: ['Sellable', 'Damaged', 'Expired', 'Defective', 'Unknown'] },
      { id: 'disposition',      label: 'Disposition',        type: 'select', required: false,
        options: ['Return to Vendor', 'Salvage', 'Destroy', 'Donate', 'Restock'],
        showWhen: { field: 'condition', values: ['Damaged', 'Expired', 'Defective'] } },
      { id: 'inspection_hours', label: 'Inspection Hours',   type: 'number', required: false },
      { id: 'units',            label: 'Units Handled',      type: 'number', required: false },
      { id: 'cartons',          label: 'Cartons Handled',    type: 'number', required: false },
      { id: 'pallets',          label: 'Pallets Handled',    type: 'number', required: false },
      { id: 'notes',            label: 'Notes / Comments',   type: 'textarea', required: false },
    ],
  },
  relabelling_repack: {
    id: 'relabelling_repack', name: 'Relabelling & Repack', color: 'blue',
    fields: [
      { id: 'special_packaging', label: 'Special Packaging', type: 'text',   required: false },
      { id: 'labour_hours',      label: 'Labour Hours',      type: 'number', required: false },
      { id: 'units',             label: 'Units Handled',     type: 'number', required: false },
      { id: 'pallets',           label: 'Pallets Handled',   type: 'number', required: false },
    ],
  },
  cross_dock: {
    id: 'cross_dock', name: 'Cross-Dock', color: 'teal',
    fields: [
      { id: 'cartons',         label: 'Cartons Handled',              type: 'number', required: false },
      { id: 'units',           label: 'Units Handled',                type: 'number', required: false },
      { id: 'days',            label: 'Number of Days',               type: 'number', required: false },
      { id: 'labour_hours',    label: 'Labour Hours',                 type: 'number', required: false },
      { id: 'pallets',         label: 'Pallets Handled',              type: 'number', required: false },
      { id: 'labels',          label: 'Labels Applied',               type: 'number', required: false },
      { id: 'labels_supplied', label: 'Labels Supplied by eShipper+', type: 'number', required: false },
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

// ─── Job Number Counter ───────────────────────────────────────────────────────
async function getNextJobNumber() {
  const counterRef = db.collection('wh_config').doc('counters');
  const snap = await counterRef.get();
  const current = snap.exists ? (snap.data().jobCounter || 0) : 0;
  const next = current + 1;
  if (snap.exists) {
    await counterRef.update({ jobCounter: next });
  } else {
    await counterRef.set({ jobCounter: next });
  }
  return `ES-${String(next).padStart(3, '0')}`;
}

// ─── Audit Helper ─────────────────────────────────────────────────────────────
function computeFieldDiff(before, after) {
  if (!before || !after) return {};
  const diff = {};
  for (const key of Object.keys(after)) {
    // Skip internal timestamps and large arrays from diff noise
    if (key === 'updatedAt') continue;
    const bVal = JSON.stringify(before[key] ?? null);
    const aVal = JSON.stringify(after[key] ?? null);
    if (bVal !== aVal) diff[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return diff;
}

async function writeAudit(jobId, action, uid, name, before, after, email) {
  const record = {
    jobId, action,
    performedBy: uid,
    performedByName: name,
    performedByEmail: email || null,
    timestamp: Timestamp.now(),
  };
  if (action === 'created') {
    // Store snapshot of new job (strip locations to keep doc small)
    const { locations, ...snap } = after || {};
    record.snapshot = snap;
    record.locationCount = (locations || []).length;
  } else if (action === 'deleted') {
    const { locations, ...snap } = before || {};
    record.snapshot = snap;
  } else {
    const diff = computeFieldDiff(before, after);
    record.changes = Object.keys(diff).length ? diff : null;
  }
  await db.collection('wh_audit').add(record);
}

// ─── Email Helper ─────────────────────────────────────────────────────────────
// Sends Firebase's built-in password-reset / invite email via the REST API.
// Requires FIREBASE_WEB_API_KEY env var (the web API key from Firebase Console).
async function sendPasswordResetEmail(email) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) {
    console.warn('[sendPasswordResetEmail] FIREBASE_WEB_API_KEY not set — skipping email send');
    return { sent: false, reason: 'no_api_key' };
  }
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[sendPasswordResetEmail] Firebase error:', data);
    return { sent: false, reason: data?.error?.message || 'firebase_error' };
  }
  return { sent: true };
}

// ─── Universal Transaction Log ────────────────────────────────────────────────
// Writes to wh_logs — covers jobs, users, config, templates, teams
async function writeLog({ action, entity, entityId, entityLabel, uid, name, email, role, changes, metadata }) {
  try {
    await db.collection('wh_logs').add({
      action,                          // e.g. 'job.created', 'user.invited', 'config.rates.updated'
      entity,                          // 'job' | 'user' | 'config' | 'template' | 'team'
      entityId:    entityId    || null,
      entityLabel: entityLabel || null, // human-readable: 'ES-001 · Acme Corp · BTS', 'user@email.com'
      performedBy:      uid,
      performedByName:  name  || null,
      performedByEmail: email || null,
      performedByRole:  role  || null,
      changes:  changes  || null,
      metadata: metadata || null,
      timestamp: Timestamp.now(),
    });
  } catch (e) {
    console.error('writeLog error:', e.message);
  }
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
    // Merge: Firestore-configured types win; built-ins fill any gaps
    const firestoreTypes = jobTypesSnap.exists ? (jobTypesSnap.data().list || []) : [];
    const firestoreIds = new Set(firestoreTypes.map(t => t.id));
    const jobTypes = [...firestoreTypes, ...Object.values(JOB_TYPE_DEFS).filter(t => !firestoreIds.has(t.id))];
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
      const ownSnap = await db.collection('wh_jobs').where('createdBy', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
      // array-contains without orderBy requires no composite index; catch any error gracefully
      let assignedDocs = [];
      try {
        const assignedSnap = await db.collection('wh_jobs').where('assignedAssocId', 'array-contains', uid).limit(200).get();
        assignedDocs = assignedSnap.docs;
      } catch (e) {
        console.warn('assignedAssocId query failed, falling back to own jobs only:', e.message);
      }
      const jobMap = new Map();
      [...ownSnap.docs, ...assignedDocs].forEach((d) => jobMap.set(d.id, { id: d.id, ...d.data() }));
      const jobs = Array.from(jobMap.values()).sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
      return res.json({ user, jobs, customers, jobTypes, rateCards, targets });
    }

    const jobs = jobsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const payload = { user, jobs, customers, jobTypes, rateCards, targets };

    // Manager + Admin: include templates
    if (user.role === 'admin' || user.role === 'manager') {
      const templatesSnap = await db.collection('wh_templates').orderBy('createdAt', 'desc').get();
      payload.templates = templatesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

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
    const { jobTypeId, customerId, fields, billable, dueDate, notes, assignedManagerId, instructions, locations, csvCaptureFields } = req.body;

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

    const jobNumber = await getNextJobNumber();
    const now = Timestamp.now();
    const job = {
      jobNumber,
      jobTypeId,
      customerId,
      status: 'created',
      billable: billable !== false,
      fields: fields || {},
      dueDate: dueDate || null,
      notes: notes || '',
      instructions: instructions || '',
      locations: (locations || []).map((l, i) => ({
        id: l.id || ('loc_' + Date.now() + '_' + i),
        name: l.name || '',
        instructions: l.instructions || '',
        referenceData: l.referenceData || {},
        assignedAssocId: null,
        assignedAssocName: '',
        status: 'pending',
        capturedData: {},
        assocNotes: '',
        completedAt: null,
      })),
      csvCaptureFields: (csvCaptureFields || []),
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
    await writeAudit(docRef.id, 'created', uid, user.displayName, null, job, user.email);
    await writeLog({ action: 'job.created', entity: 'job', entityId: docRef.id,
      entityLabel: `${jobNumber} · ${customerId} · ${jobTypeId}`,
      uid, name: user.displayName, email: user.email, role: user.role });
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
    await writeAudit(req.params.id, 'updated', uid, user.displayName, before, update, user.email);
    await writeLog({ action: 'job.updated', entity: 'job', entityId: req.params.id,
      entityLabel: `${before.jobNumber || req.params.id} · ${before.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role });
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
    await writeAudit(req.params.id, 'assigned_manager', uid, user.displayName, before, update, user.email);
    await writeLog({ action: 'job.manager_assigned', entity: 'job', entityId: req.params.id,
      entityLabel: `${before.jobNumber || req.params.id} · ${before.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role,
      metadata: { assignedManager: mgrSnap.data().displayName } });
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
    await writeAudit(req.params.id, 'assigned_associate', uid, user.displayName, before, update, user.email);
    await writeLog({ action: 'job.associates_assigned', entity: 'job', entityId: req.params.id,
      entityLabel: `${before.jobNumber || req.params.id} · ${before.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role,
      metadata: { associates: validAssocs.map(s => s.data().displayName) } });
    res.json({ id: req.params.id, ...before, ...update });
  } catch (err) {
    console.error('PUT assign-associate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manager saves location assignments
app.put('/api/jobs/:id/locations', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { user, uid } = req;
    const { locations } = req.body;
    if (!Array.isArray(locations)) return res.status(400).json({ error: 'locations array required' });
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    const job = jobSnap.data();
    // Merge assignments into existing locations (preserve status/notes)
    const existing = job.locations || [];
    const merged = locations.map(l => {
      const prev = existing.find(e => e.id === l.id) || {};
      // New locations (not in existing) get sensible defaults
      return { status: 'pending', capturedData: {}, assocNotes: '', photos: [], ...prev, ...l };
    });
    // Build full assignedAssocId list from locations
    const assocIds = [...new Set(merged.map(l => l.assignedAssocId).filter(Boolean))];
    const assocSnaps = await Promise.all(assocIds.map(id => db.collection('wh_users').doc(id).get()));
    const assocNames = {};
    assocSnaps.forEach(s => { if (s.exists) assocNames[s.id] = s.data().displayName; });
    const mergedWithNames = merged.map(l => ({
      ...l,
      assignedAssocName: l.assignedAssocId ? (assocNames[l.assignedAssocId] || l.assignedAssocName || '') : '',
    }));
    const now = Timestamp.now();
    await db.collection('wh_jobs').doc(req.params.id).update({
      locations: mergedWithNames,
      assignedAssocId: assocIds,
      assignedAssocNames: assocIds.map(id => assocNames[id] || ''),
      status: assocIds.length > 0 && job.status === 'assigned_manager' ? 'assigned_associate' : job.status,
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: now,
    });
    res.json({ locations: mergedWithNames });
  } catch (err) {
    console.error('PUT locations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Associate marks a location as done
app.put('/api/jobs/:id/locations/:locId/done', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;
    const { assocNotes, capturedData } = req.body;
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    const job = jobSnap.data();
    const locIndex = (job.locations || []).findIndex(l => l.id === req.params.locId);
    if (locIndex === -1) return res.status(404).json({ error: 'Location not found' });
    const loc = job.locations[locIndex];
    if (loc.assignedAssocId !== uid) return res.status(403).json({ error: 'Not assigned to this location' });
    const now = Timestamp.now();
    const updatedLocations = job.locations.map((l, i) =>
      i === locIndex ? { ...l, status: 'done', assocNotes: assocNotes || '', capturedData: capturedData || {}, completedAt: now } : l
    );
    const allDone = updatedLocations.every(l => l.status === 'done');
    const update = {
      locations: updatedLocations,
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: now,
    };
    if (allDone) {
      update.status = 'pending_review';
      update.submittedBy = uid;
      update.submittedByName = user.displayName;
      update.submittedAt = now;
    }
    await db.collection('wh_jobs').doc(req.params.id).update(update);
    await writeAudit(req.params.id, allDone ? 'pending_review' : 'location_done', uid, user.displayName, job, update, user.email);
    await writeLog({ action: allDone ? 'job.submitted_review' : 'job.location_done', entity: 'job',
      entityId: req.params.id, entityLabel: `${job.jobNumber || req.params.id} · ${job.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role,
      metadata: { location: loc.name } });
    res.json({ id: req.params.id, allDone, locations: updatedLocations });
  } catch (err) {
    console.error('PUT location done error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id/submit-review', requireAuth, async (req, res) => {
  try {
    const { user, uid } = req;
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    const job = jobSnap.data();

    const canSubmit = (job.assignedAssocId || []).includes(uid) || job.createdBy === uid;
    if (!canSubmit) return res.status(403).json({ error: 'Not assigned to this job' });

    const { fields, billable, associateNotes } = req.body;
    const mergedFields = { ...job.fields, ...(fields || {}) };
    const now = Timestamp.now();
    const update = {
      fields: mergedFields,
      billable: billable !== undefined ? billable : job.billable,
      associateNotes: associateNotes || '',
      status: 'pending_review',
      submittedBy: uid,
      submittedByName: user.displayName,
      submittedAt: now,
      updatedBy: uid,
      updatedByName: user.displayName,
      updatedAt: now,
    };
    await db.collection('wh_jobs').doc(req.params.id).update(update);
    await writeAudit(req.params.id, 'pending_review', uid, user.displayName, job, update, user.email);
    await writeLog({ action: 'job.submitted_review', entity: 'job', entityId: req.params.id,
      entityLabel: `${job.jobNumber || req.params.id} · ${job.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role });
    res.json({ id: req.params.id, ...job, ...update });
  } catch (err) {
    console.error('PUT submit-review error:', err);
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

    const { fields, billable, managerNotes } = req.body;
    const mergedFields = { ...job.fields, ...(fields || {}) };

    const { revenue, cost, profit, marginPct, rating } = await calculateRevenueCost(
      { ...job, assignedAssocId: job.assignedAssocId || [] },
      mergedFields
    );

    const now = Timestamp.now();
    const update = {
      fields: mergedFields,
      billable: billable !== undefined ? billable : job.billable,
      managerNotes: managerNotes !== undefined ? managerNotes : (job.managerNotes || ''),
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
    await writeAudit(req.params.id, 'completed', uid, user.displayName, job, update, user.email);
    await writeLog({ action: 'job.completed', entity: 'job', entityId: req.params.id,
      entityLabel: `${job.jobNumber || req.params.id} · ${job.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role,
      metadata: { revenue, cost, profit, rating } });
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
    await writeAudit(req.params.id, 'deleted', uid, user.displayName, before, null, user.email);
    await writeLog({ action: 'job.deleted', entity: 'job', entityId: req.params.id,
      entityLabel: `${before.jobNumber || req.params.id} · ${before.customerId}`,
      uid, name: user.displayName, email: user.email, role: user.role });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/jobs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Photo Upload ─────────────────────────────────────────────────────────────
app.post('/api/jobs/:id/locations/:locId/photos', requireAuth, async (req, res) => {
  try {
    const { uid } = req;
    const { imageData } = req.body; // base64 data URL
    if (!imageData) return res.status(400).json({ error: 'imageData required' });

    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    const ext = imageData.startsWith('data:image/png') ? 'png' : 'jpg';
    const fileName = `jobs/${req.params.id}/locations/${req.params.locId}/${Date.now()}_${uid}.${ext}`;
    const file = bucket.file(fileName);
    await file.save(buffer, {
      metadata: { contentType: ext === 'png' ? 'image/png' : 'image/jpeg' },
    });
    await file.makePublic();
    const url = `https://storage.googleapis.com/${STORAGE_BUCKET}/${fileName}`;

    // Append URL to the location's photos array
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    const job = jobSnap.data();
    const updatedLocations = (job.locations || []).map(l =>
      l.id === req.params.locId ? { ...l, photos: [...(l.photos || []), url] } : l
    );
    await db.collection('wh_jobs').doc(req.params.id).update({ locations: updatedLocations });
    res.json({ url });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Locations Excel Export ────────────────────────────────────────────────────
app.get('/api/jobs/:id/export/locations', requireAuth, async (req, res) => {
  try {
    const jobSnap = await db.collection('wh_jobs').doc(req.params.id).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'Job not found' });
    const job = { id: jobSnap.id, ...jobSnap.data() };

    const locations = job.locations || [];
    if (!locations.length) return res.status(400).json({ error: 'This job has no locations' });

    // Collect all reference data column names (union across all locations)
    const refCols = [...new Set(locations.flatMap(l => Object.keys(l.referenceData || {})))];

    // Prefer CSV-defined capture fields (e.g. Lot, Expiry from CSV upload), fall back to job type fields
    let captureFields = [];
    if (job.csvCaptureFields && job.csvCaptureFields.length) {
      captureFields = job.csvCaptureFields;
    } else {
      const jobTypesDoc = await db.collection('wh_config').doc('jobTypes').get();
      const allJobTypes = jobTypesDoc.exists ? (jobTypesDoc.data().list || []) : Object.values(JOB_TYPE_DEFS);
      const jobTypeDef = allJobTypes.find(jt => jt.id === job.jobTypeId) || JOB_TYPE_DEFS[job.jobTypeId];
      captureFields = jobTypeDef?.fields || [];
    }

    // Build rows
    const rows = locations.map(l => {
      const row = {};
      refCols.forEach(col => { row[col] = (l.referenceData || {})[col] || ''; });
      captureFields.forEach(f => { row[f.label] = (l.capturedData || {})[f.id] ?? ''; });
      row['Status'] = l.status === 'done' ? 'Done' : 'Pending';
      row['Assigned To'] = l.assignedAssocName || '';
      row['Completed At'] = l.completedAt ? new Date(l.completedAt._seconds * 1000).toLocaleString('en-CA') : '';
      row['Notes'] = l.assocNotes || '';
      row['Photos'] = (l.photos || []).join('\n');
      return row;
    });

    const wb = XLSX.utils.book_new();
    // Locations sheet
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Locations');
    // Job summary sheet
    const summary = [
      { Field: 'Customer', Value: job.customerId },
      { Field: 'Job Type', Value: job.jobTypeId },
      { Field: 'Status', Value: job.status },
      { Field: 'Created By', Value: job.createdByName || '' },
      { Field: 'Created At', Value: job.createdAt ? new Date(job.createdAt._seconds * 1000).toLocaleString('en-CA') : '' },
      { Field: 'Manager', Value: job.assignedManagerName || '' },
      { Field: 'Instructions', Value: job.instructions || '' },
      { Field: 'Total Locations', Value: locations.length },
      { Field: 'Completed', Value: locations.filter(l => l.status === 'done').length },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${job.customerId}-${job.jobTypeId}-locations.xlsx`.replace(/[^a-z0-9._-]/gi, '_');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buf);
  } catch (err) {
    console.error('Locations export error:', err);
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
    await writeLog({ action: 'config.customers_updated', entity: 'config', entityId: 'customers',
      entityLabel: `Customers list (${list.length} entries)`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
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

    await writeLog({ action: 'config.customers_renamed', entity: 'config', entityId: 'customers',
      entityLabel: `"${oldName}" → "${newName}" (${jobsSnap.size} jobs updated)`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
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
    await writeLog({ action: 'config.jobtypes_updated', entity: 'config', entityId: 'jobTypes',
      entityLabel: `Job types updated (${list.length} types)`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
    res.json({ list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed all built-in job types into Firestore (Firestore-customised ones are preserved)
app.post('/api/jobtypes/seed', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const snap = await db.collection('wh_config').doc('jobTypes').get();
    const existing = snap.exists ? (snap.data().list || []) : [];
    const existingIds = new Set(existing.map(t => t.id));
    const toAdd = Object.values(JOB_TYPE_DEFS).filter(t => !existingIds.has(t.id));
    const merged = [...existing, ...toAdd];
    await db.collection('wh_config').doc('jobTypes').set({ list: merged });
    await writeLog({ action: 'config.jobtypes_seeded', entity: 'config', entityId: 'jobTypes',
      entityLabel: `Seeded ${toAdd.length} built-in job types`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
    res.json({ added: toAdd.length, total: merged.length, types: toAdd.map(t => t.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rates', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rates = req.body; // { [customerId]: { [jobTypeId]: { [fieldId]: number } } }
    await db.collection('wh_config').doc('rateCards').set(rates);
    await writeLog({ action: 'config.rates_updated', entity: 'config', entityId: 'rateCards',
      entityLabel: `Rate cards updated for: ${Object.keys(rates).join(', ') || '(none)'}`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
    res.json(rates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/targets', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const targets = req.body; // { [jobTypeId]: { targetMarginPct, goodThresholdPct } }
    await db.collection('wh_config').doc('targets').set(targets);
    await writeLog({ action: 'config.targets_updated', entity: 'config', entityId: 'targets',
      entityLabel: `Profitability targets updated`,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
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
    const targetSnap = await db.collection('wh_users').doc(req.params.uid).get();
    const targetEmail = targetSnap.exists ? targetSnap.data().email : req.params.uid;
    await Promise.all([
      db.collection('wh_users').doc(req.params.uid).update({ role }),
      auth.setCustomUserClaims(req.params.uid, { role }),
    ]);
    await writeLog({ action: 'user.role_changed', entity: 'user', entityId: req.params.uid,
      entityLabel: targetEmail, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role,
      changes: { role: { from: targetSnap.data()?.role, to: role } } });
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
    const costUserSnap = await db.collection('wh_users').doc(req.params.uid).get();
    await db.collection('wh_users').doc(req.params.uid).update({ hourlyCost });
    await writeLog({ action: 'user.cost_updated', entity: 'user', entityId: req.params.uid,
      entityLabel: costUserSnap.exists ? costUserSnap.data().email : req.params.uid,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role,
      changes: { hourlyCost: { from: costUserSnap.data()?.hourlyCost, to: hourlyCost } } });
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
      // Send invite email + generate fallback link
      const [emailResult, resetLink] = await Promise.all([
        sendPasswordResetEmail(emailKey).catch(() => ({ sent: false })),
        auth.generatePasswordResetLink(emailKey).catch(() => null),
      ]);
      return res.json({ status: 'updated', uid: existingDoc.id, resetLink, emailSent: emailResult.sent });
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

    // Send invite email + generate fallback link in parallel
    const [emailResult, resetLink] = await Promise.all([
      sendPasswordResetEmail(emailKey).catch(() => ({ sent: false })),
      auth.generatePasswordResetLink(emailKey).catch(() => null),
    ]);

    await writeLog({ action: 'user.invited', entity: 'user', entityId: authUser.uid,
      entityLabel: emailKey, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role,
      metadata: { invitedRole: claimRole, displayName: nameToUse, emailSent: emailResult.sent } });
    res.json({ status: 'invited', email: emailKey, uid: authUser.uid, resetLink, emailSent: emailResult.sent });
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
    await writeLog({ action: 'user.password_reset', entity: 'user', entityId: req.params.uid,
      entityLabel: userRecord.email, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role });
    res.json({ resetLink, email: userRecord.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set a user's password directly (admin only)
app.put('/api/users/:uid/password', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    await auth.updateUser(req.params.uid, { password });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:uid', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const targetUid = req.params.uid;
    if (targetUid === req.uid) return res.status(400).json({ error: 'Cannot delete yourself' });

    // Find team before deleting
    const userSnap = await db.collection('wh_users').doc(targetUid).get();
    const teamId = userSnap.exists ? userSnap.data().teamId : null;

    // 1. Revoke all active sessions immediately
    await auth.revokeRefreshTokens(targetUid).catch(() => {});
    // 2. Delete Firebase Auth account — prevents future sign-in
    await auth.deleteUser(targetUid).catch(() => {});
    // 3. Remove Firestore user record
    await db.collection('wh_users').doc(targetUid).delete();
    // 4. Remove from team memberIds
    if (teamId) {
      await db.collection('wh_teams').doc(teamId).update({
        memberIds: FieldValue.arrayRemove(targetUid),
      }).catch(() => {});
    }

    const deletedEmail = userSnap.exists ? userSnap.data().email : targetUid;
    await writeLog({ action: 'user.deleted', entity: 'user', entityId: targetUid,
      entityLabel: deletedEmail, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role });
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
    await writeLog({ action: 'team.created', entity: 'team', entityId: ref.id,
      entityLabel: name, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role });
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
    const teamSnap = await db.collection('wh_teams').doc(req.params.id).get();
    await db.collection('wh_teams').doc(req.params.id).delete();
    await writeLog({ action: 'team.deleted', entity: 'team', entityId: req.params.id,
      entityLabel: teamSnap.exists ? teamSnap.data().name : req.params.id,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Templates ────────────────────────────────────────────────────────────────

app.get('/api/templates', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const snap = await db.collection('wh_templates').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { name, jobTypeId, customerId, customerIds, assignedManagerId, billable,
            dueDaysOffset, instructions, notes, locations, csvCaptureFields } = req.body;
    if (!name || !jobTypeId) return res.status(400).json({ error: 'name and jobTypeId required' });
    // Normalise to customerIds array (empty = all customers)
    let resolvedCustomerIds = Array.isArray(customerIds) ? customerIds
      : (customerId ? [customerId] : []);
    const now = Timestamp.now();
    const ref = await db.collection('wh_templates').add({
      name, jobTypeId, customerIds: resolvedCustomerIds,
      assignedManagerId: assignedManagerId || null,
      billable: billable ?? true,
      dueDaysOffset: dueDaysOffset ?? null,
      instructions: instructions || '',
      notes: notes || '',
      locations: (locations || []).map(l => ({ name: l.name, instructions: l.instructions || '', referenceData: l.referenceData || {} })),
      csvCaptureFields: csvCaptureFields || [],
      createdBy: req.uid,
      createdByName: req.user.displayName || '',
      createdAt: now,
      updatedAt: now,
    });
    await writeLog({ action: 'template.created', entity: 'template', entityId: ref.id,
      entityLabel: name, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role });
    res.status(201).json({ id: ref.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { name, jobTypeId, customerId, customerIds, assignedManagerId, billable,
            dueDaysOffset, instructions, notes, locations, csvCaptureFields } = req.body;
    // Normalise to customerIds array (empty = all customers)
    let resolvedCustomerIds = Array.isArray(customerIds) ? customerIds
      : (customerId ? [customerId] : []);
    const updates = {
      name, jobTypeId, customerIds: resolvedCustomerIds,
      assignedManagerId: assignedManagerId || null,
      billable: billable ?? true,
      dueDaysOffset: dueDaysOffset ?? null,
      instructions: instructions || '',
      notes: notes || '',
      locations: (locations || []).map(l => ({ name: l.name, instructions: l.instructions || '', referenceData: l.referenceData || {} })),
      csvCaptureFields: csvCaptureFields || [],
      updatedAt: Timestamp.now(),
    };
    await db.collection('wh_templates').doc(req.params.id).update(updates);
    await writeLog({ action: 'template.updated', entity: 'template', entityId: req.params.id,
      entityLabel: name, uid: req.uid, name: req.user.displayName,
      email: req.user.email, role: req.user.role });
    res.json({ updated: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const tplSnap = await db.collection('wh_templates').doc(req.params.id).get();
    await db.collection('wh_templates').doc(req.params.id).delete();
    await writeLog({ action: 'template.deleted', entity: 'template', entityId: req.params.id,
      entityLabel: tplSnap.exists ? tplSnap.data().name : req.params.id,
      uid: req.uid, name: req.user.displayName, email: req.user.email, role: req.user.role });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Activity Logs ────────────────────────────────────────────────────────────
app.get('/api/logs', requireAuth, requireRole('manager', 'admin'), async (req, res) => {
  try {
    const { entity, limit = 200 } = req.query;
    // Fetch ordered by timestamp only (single-field index, always exists)
    // then filter by entity in memory — avoids composite index requirement
    const snap = await db.collection('wh_logs')
      .orderBy('timestamp', 'desc')
      .limit(500)
      .get();
    let logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Apply entity filter in memory
    const entityFilter = req.user.role === 'manager' ? 'job' : (entity || null);
    if (entityFilter) logs = logs.filter(l => l.entity === entityFilter);
    res.json(logs.slice(0, parseInt(limit) || 200));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`Warehouse Billing server listening on port ${PORT}`));
}

module.exports = { app };
