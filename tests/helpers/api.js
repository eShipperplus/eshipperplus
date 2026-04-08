'use strict';
const request = require('supertest');
const { app } = require('../../server');
const store = require('./store');

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function get(path, token) {
  return request(app).get(path).set(authHeader(token));
}
function post(path, body, token) {
  return request(app).post(path).set(authHeader(token)).send(body);
}
function put(path, body, token) {
  return request(app).put(path).set(authHeader(token)).send(body);
}
function del(path, token) {
  return request(app).delete(path).set(authHeader(token));
}

// Seeds a baseline Firestore state and returns tokens for the four roles
function setupBaseState() {
  const adminId = 'user_admin';
  const managerId = 'user_mgr';
  const assocId = 'user_assoc';
  const supportId = 'user_support';

  const adminToken   = store.createToken(adminId,   'admin',          { email: 'admin@test.com',   displayName: 'Admin User' });
  const managerToken = store.createToken(managerId,  'manager',        { email: 'mgr@test.com',     displayName: 'Manager User' });
  const assocToken   = store.createToken(assocId,    'associate',      { email: 'assoc@test.com',   displayName: 'Associate User' });
  const supportToken = store.createToken(supportId,  'office_support', { email: 'support@test.com', displayName: 'Support User' });

  store.seedStore({
    wh_users: {
      [adminId]:   { uid: adminId,   email: 'admin@test.com',   displayName: 'Admin User',     role: 'admin',          hourlyCost: 0,    teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      [managerId]: { uid: managerId, email: 'mgr@test.com',     displayName: 'Manager User',   role: 'manager',        hourlyCost: 35,   teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      [assocId]:   { uid: assocId,   email: 'assoc@test.com',   displayName: 'Associate User', role: 'associate',      hourlyCost: 20,   teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
      [supportId]: { uid: supportId, email: 'support@test.com', displayName: 'Support User',   role: 'office_support', hourlyCost: 0,    teamId: null, createdAt: store.Timestamp.now(), lastSeen: store.Timestamp.now() },
    },
    wh_config: {
      // NOTE: jobTypes doc intentionally not seeded — server falls back to JOB_TYPE_DEFS (built-ins)
      customers: { list: ['Acme Corp', 'Widget Co', 'Global Logistics'] },
      rateCards: {
        'Acme Corp': {
          bts: { cartons: 2.50, units: 0.10, labour_hours: 45.00, labels: 0.05 },
        },
      },
      targets: {
        bts: { targetMarginPct: 50, goodThresholdPct: 10 },
      },
    },
  });

  return { adminId, managerId, assocId, supportId, adminToken, managerToken, assocToken, supportToken };
}

// Creates a job directly in the store and returns its ID
function seedJob(overrides = {}) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    jobTypeId: 'bts',
    customerId: 'Acme Corp',
    status: 'created',
    fields: {},
    billable: true,
    dueDate: null,
    notes: '',
    instructions: '',
    locations: [],
    assignedAssocId: [],
    assignedAssocNames: [],
    createdBy: 'user_admin',
    createdByName: 'Admin User',
    createdByEmail: 'admin@test.com',
    createdByRole: 'admin',
    createdAt: store.Timestamp.now(),
    updatedAt: store.Timestamp.now(),
    ...overrides,
  };
  if (!store.getDoc('wh_jobs')) store.seedStore({ wh_jobs: {} });
  const current = store.getDoc('wh_jobs') || {};
  current[id] = job;
  store.seedStore({ ...Object.fromEntries(
    Object.entries({ wh_jobs: current })
  )});
  return id;
}

module.exports = { get, post, put, del, authHeader, setupBaseState, seedJob };
