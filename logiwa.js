'use strict';
/**
 * Logiwa WMS API Service
 * Handles auth, inventory sync (pull), and inventory movements (push)
 */

const https = require('https');

const BASE = 'https://myapi.logiwa.com';

// ── Token cache (per-credential-hash) ──────────────────────────────────────
const _cache = {};

function credKey(email) { return email.toLowerCase(); }

async function _request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'myapi.logiwa.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d || null }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function getToken(email, password) {
  const key = credKey(email);
  const cached = _cache[key];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const r = await _request('POST', '/v3.1/Authorize/token', { email, password });
  if (!r.body?.token) throw new Error(`Logiwa auth failed: ${JSON.stringify(r.body)}`);

  _cache[key] = { token: r.body.token, expiry: Date.now() + 25 * 60 * 1000 };
  return r.body.token;
}

function clearTokenCache(email) {
  delete _cache[credKey(email)];
}

// ── Clients list ─────────────────────────────────────────────────────────────
async function listClients(email, password) {
  const token = await getToken(email, password);
  const r = await _request('GET', '/v3.1/Client/list/i/0/s/200', null, token);
  if (!r.body?.data) throw new Error(`Clients fetch failed: ${JSON.stringify(r.body)}`);
  return r.body.data.map(c => ({
    identifier: c.identifier,
    name: c.displayName,
  }));
}

// ── Inventory fetch (paginated) ───────────────────────────────────────────
const PAGE_SIZE = 200; // max allowed by API
const MAX_PAGES = 200; // up to 40k items

function _mapItem(item) {
  return {
    inventoryId: item.identifier,
    sku: item.productSku,
    productName: item.productName,
    clientId: item.clientIdentifier,
    clientName: item.clientDisplayName,
    location: item.warehouseLocationCode,
    locationId: item.warehouseLocationIdentifier,
    zone: item.warehouseLocationZoneName,
    totalQty: item.totalQuantity,
    availQty: item.availableQuantity,
    lotBatch: item.lotBatchNumber,
    expiry: item.expiryDate,
    upc: item.productUpc,
    warehouseCode: item.warehouseCode,
  };
}

async function fetchInventoryPage(token, index) {
  const r = await _request('GET', `/v3.1/Inventory/list/i/${index}/s/${PAGE_SIZE}`, null, token);
  if (!r.body?.data) return { data: [], done: true };
  return {
    data: r.body.data.map(_mapItem),
    done: r.body.data.length < PAGE_SIZE,
  };
}

// Fetch inventory filtered by clientIdentifier via POST search endpoint
async function fetchInventoryByClient(token, clientIdentifier, onProgress) {
  let all = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await _request('POST', `/v3.1/Inventory/list/i/${i}/s/${PAGE_SIZE}`,
      { clientIdentifier }, token);
    if (!r.body?.data || r.body.data.length === 0) break;
    all = all.concat(r.body.data.map(_mapItem));
    if (onProgress) onProgress(all.length);
    if (r.body.data.length < PAGE_SIZE) break;
    await new Promise(r => setTimeout(r, 1100));
  }
  return all;
}

async function fetchAllInventory(email, password, onProgress, filterClientId) {
  const token = await getToken(email, password);

  // Try fast client-filtered fetch first
  if (filterClientId) {
    try {
      const items = await fetchInventoryByClient(token, filterClientId, onProgress);
      if (items.length > 0) return items;
    } catch (e) {
      console.warn('Client-filtered fetch failed, falling back to full fetch:', e.message);
    }
  }

  // Full paginated fetch (with optional client-side filter)
  let all = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, done } = await fetchInventoryPage(token, i);
    const filtered = filterClientId ? data.filter(x => String(x.clientId) === String(filterClientId)) : data;
    all = all.concat(filtered);
    if (onProgress) onProgress(all.length);
    if (done) break;
    await new Promise(r => setTimeout(r, 1100));
  }
  return all;
}

// ── Inventory movements (push) ─────────────────────────────────────────────
async function addInventory(email, password, inventoryIdentifier, quantity, note, adjustmentReasonName) {
  const token = await getToken(email, password);
  const r = await _request('PUT', '/v3.1/Inventory/add', {
    inventoryIdentifier,
    quantity,
    note: note || '',
    ...(adjustmentReasonName ? { adjustmentReasonName } : {}),
  }, token);
  return r;
}

async function removeInventory(email, password, inventoryIdentifier, quantity, note, adjustmentReasonName) {
  const token = await getToken(email, password);
  const r = await _request('PUT', '/v3.1/Inventory/remove', {
    inventoryIdentifier,
    quantity,
    note: note || '',
    ...(adjustmentReasonName ? { adjustmentReasonName } : {}),
  }, token);
  return r;
}

async function adjustInventory(email, password, inventoryIdentifier, quantity, note, adjustmentReasonName) {
  const token = await getToken(email, password);
  const r = await _request('PUT', '/v3.1/Inventory/adjust', {
    inventoryIdentifier,
    quantity,
    note: note || '',
    ...(adjustmentReasonName ? { adjustmentReasonName } : {}),
  }, token);
  return r;
}

// ── Transfer between locations ─────────────────────────────────────────────
async function transferProduct(email, password, payload) {
  const token = await getToken(email, password);
  const r = await _request('POST', '/v3.1/Inventory/transfer/product', payload, token);
  return r;
}

module.exports = {
  getToken,
  clearTokenCache,
  listClients,
  fetchAllInventory,
  fetchInventoryPage,
  addInventory,
  removeInventory,
  adjustInventory,
  transferProduct,
};
