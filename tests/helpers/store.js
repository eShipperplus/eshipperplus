'use strict';

/**
 * Shared in-memory Firebase store singleton.
 * Imported by both __mocks__ files and test helpers so all layers share the same state.
 */

let _store = {};      // Firestore: { collection: { docId: data } }
let _auth = {};       // Auth users: { uid: { uid, email, displayName, customClaims } }
let _tokens = {};     // ID tokens: { tokenString: decodedPayload }

// ── Timestamp / FieldValue ────────────────────────────────────────────────────

function makeTimestamp(date) {
  const d = date || new Date();
  return {
    toDate: () => d,
    _seconds: Math.floor(d.getTime() / 1000),
    _nanoseconds: 0,
    toMillis: () => d.getTime(),
  };
}

const Timestamp = {
  now: () => makeTimestamp(),
  fromDate: (d) => makeTimestamp(d),
};

function applyFieldValue(existing, update) {
  const result = { ...existing };
  for (const [key, val] of Object.entries(update)) {
    if (val && typeof val === 'object' && val.__fv === 'arrayUnion') {
      const arr = Array.isArray(result[key]) ? result[key] : [];
      const next = [...arr];
      for (const item of val.items) { if (!next.includes(item)) next.push(item); }
      result[key] = next;
    } else if (val && typeof val === 'object' && val.__fv === 'arrayRemove') {
      const arr = Array.isArray(result[key]) ? result[key] : [];
      result[key] = arr.filter(i => !val.items.includes(i));
    } else if (val && typeof val === 'object' && val.__fv === 'delete') {
      delete result[key];
    } else {
      result[key] = val;
    }
  }
  return result;
}

const FieldValue = {
  arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }),
  arrayRemove: (...items) => ({ __fv: 'arrayRemove', items }),
  delete: () => ({ __fv: 'delete' }),
  serverTimestamp: () => makeTimestamp(),
};

// ── Firestore Mock ────────────────────────────────────────────────────────────

class DocumentSnapshot {
  constructor(id, data, collName) {
    this.id = id;
    this._data = data !== undefined ? data : undefined;
    this.exists = data !== undefined;
    this.ref = new DocumentReference(collName || null, id);
  }
  data() { return this._data ? { ...this._data } : undefined; }
}

class DocumentReference {
  constructor(collName, id) {
    this._coll = collName;
    this.id = id;
  }
  async get() {
    const data = _store[this._coll]?.[this.id];
    return new DocumentSnapshot(this.id, data !== undefined ? { ...data } : undefined, this._coll);
  }
  async set(data) {
    if (!_store[this._coll]) _store[this._coll] = {};
    _store[this._coll][this.id] = { ...data };
  }
  async update(updates) {
    if (!_store[this._coll]) _store[this._coll] = {};
    const existing = _store[this._coll][this.id] || {};
    _store[this._coll][this.id] = applyFieldValue(existing, updates);
  }
  async delete() {
    if (_store[this._coll]) delete _store[this._coll][this.id];
  }
  // For use in inviteSnap.ref.delete()
  get ref() { return this; }
}

class Query {
  constructor(collName, filters = [], orders = [], lim = null) {
    this._coll = collName;
    this._filters = filters;
    this._orders = orders;
    this._lim = lim;
  }
  where(field, op, value) {
    return new Query(this._coll, [...this._filters, { field, op, value }], this._orders, this._lim);
  }
  orderBy(field, dir = 'asc') {
    return new Query(this._coll, this._filters, [...this._orders, { field, dir }], this._lim);
  }
  limit(n) { return new Query(this._coll, this._filters, this._orders, n); }
  async get() {
    let docs = Object.entries(_store[this._coll] || {}).map(([id, d]) => new DocumentSnapshot(id, { ...d }, this._coll));
    for (const { field, op, value } of this._filters) {
      docs = docs.filter(d => {
        const v = d._data?.[field];
        if (op === '==') return v === value;
        if (op === '!=') return v !== value;
        if (op === '>') return v > value;
        if (op === '<') return v < value;
        if (op === '>=') return v >= value;
        if (op === '<=') return v <= value;
        if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
        if (op === 'in') return Array.isArray(value) && value.includes(v);
        return true;
      });
    }
    for (const { field, dir } of this._orders) {
      docs.sort((a, b) => {
        const av = a._data?.[field]?._seconds ?? a._data?.[field] ?? 0;
        const bv = b._data?.[field]?._seconds ?? b._data?.[field] ?? 0;
        return dir === 'asc' ? (av > bv ? 1 : -1) : (bv > av ? 1 : -1);
      });
    }
    if (this._lim) docs = docs.slice(0, this._lim);
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class CollectionReference extends Query {
  constructor(name) { super(name); }
  doc(id) {
    const resolvedId = id || `auto_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return new DocumentReference(this._coll, resolvedId);
  }
  async add(data) {
    const id = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    if (!_store[this._coll]) _store[this._coll] = {};
    _store[this._coll][id] = { ...data };
    return { id };
  }
}

const db = {
  collection: (name) => new CollectionReference(name),
  batch() {
    const ops = [];
    return {
      update: (ref, data) => { ops.push({ type: 'update', ref, data }); },
      set:    (ref, data) => { ops.push({ type: 'set',    ref, data }); },
      delete: (ref)       => { ops.push({ type: 'delete', ref });       },
      commit: async () => {
        for (const op of ops) {
          if (op.type === 'update') await op.ref.update(op.data);
          else if (op.type === 'set') await op.ref.set(op.data);
          else if (op.type === 'delete') await op.ref.delete();
        }
      },
    };
  },
};

// ── Auth Mock ─────────────────────────────────────────────────────────────────

const auth = {
  async verifyIdToken(token) {
    const decoded = _tokens[token];
    if (!decoded) throw Object.assign(new Error('Firebase ID token has been revoked or is invalid'), { code: 'auth/id-token-revoked' });
    return { ...decoded };
  },
  async createUser(props) {
    const uid = props.uid || `uid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    _auth[uid] = { uid, customClaims: {}, ...props };
    return { uid, ...props };
  },
  async getUser(uid) {
    if (!_auth[uid]) throw Object.assign(new Error('There is no user record corresponding to the provided identifier.'), { code: 'auth/user-not-found' });
    return { ..._auth[uid] };
  },
  async getUserByEmail(email) {
    const u = Object.values(_auth).find(u => u.email === email);
    if (!u) throw Object.assign(new Error('There is no user record corresponding to the provided identifier.'), { code: 'auth/user-not-found' });
    return { ...u };
  },
  async setCustomUserClaims(uid, claims) {
    if (!_auth[uid]) _auth[uid] = { uid, customClaims: {} };
    _auth[uid].customClaims = { ...(_auth[uid].customClaims || {}), ...claims };
    // Update tokens
    for (const tok of Object.values(_tokens)) {
      if (tok.uid === uid) Object.assign(tok, claims);
    }
  },
  async updateUser(uid, updates) {
    if (!_auth[uid]) throw Object.assign(new Error('user not found'), { code: 'auth/user-not-found' });
    Object.assign(_auth[uid], updates);
    return { ..._auth[uid] };
  },
  async revokeRefreshTokens(uid) {
    for (const [tok, data] of Object.entries(_tokens)) {
      if (data.uid === uid) delete _tokens[tok];
    }
  },
  async deleteUser(uid) {
    if (!_auth[uid]) throw Object.assign(new Error('user not found'), { code: 'auth/user-not-found' });
    delete _auth[uid];
  },
  async generatePasswordResetLink(email) {
    return `https://test.example.com/reset?email=${encodeURIComponent(email)}&oobCode=testcode`;
  },
};

// ── Storage Mock ──────────────────────────────────────────────────────────────

const bucket = {
  file: (path) => ({
    save: jest.fn().mockResolvedValue(undefined),
    makePublic: jest.fn().mockResolvedValue(undefined),
    publicUrl: () => `https://storage.example.com/${path}`,
    metadata: { mediaLink: `https://storage.example.com/${path}` },
  }),
};

// ── Test Helpers ──────────────────────────────────────────────────────────────

let _tokenCounter = 0;

function createToken(uid, role, extra = {}) {
  const email = extra.email || `${uid}@test.example.com`;
  const displayName = extra.displayName || `User ${uid}`;
  const token = `tok_${uid}_${role}_${++_tokenCounter}`;
  _tokens[token] = { uid, role, email, name: displayName, ...extra };
  if (!_auth[uid]) {
    _auth[uid] = { uid, email, displayName, customClaims: { role } };
  }
  return token;
}

function seedStore(data) {
  for (const [coll, docs] of Object.entries(data)) {
    _store[coll] = {};
    for (const [id, doc] of Object.entries(docs)) {
      _store[coll][id] = { ...doc };
    }
  }
}

function getDoc(coll, id) {
  if (id) return _store[coll]?.[id] ? { ..._store[coll][id] } : undefined;
  return Object.fromEntries(Object.entries(_store[coll] || {}).map(([k, v]) => [k, { ...v }]));
}

function getAllDocs(coll) {
  return Object.entries(_store[coll] || {}).map(([id, data]) => ({ id, ...data }));
}

function reset() {
  _store = {};
  _auth = {};
  _tokens = {};
  _tokenCounter = 0;
}

module.exports = { db, auth, bucket, Timestamp, FieldValue, createToken, seedStore, getDoc, getAllDocs, reset };
