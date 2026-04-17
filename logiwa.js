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
const INV_PAGE_SIZE = 500; // inventory endpoint supports up to 500
const MAX_PAGES = 100;     // up to 50k items

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

async function fetchInventoryPage(token, index, filterClientId) {
  const r = await _request('GET', `/v3.1/Inventory/list/i/${index}/s/${INV_PAGE_SIZE}`, null, token);
  if (!r.body?.data) return { data: [], done: true };
  const raw = r.body.data;
  const data = (filterClientId
    ? raw.filter(x => String(x.clientIdentifier) === String(filterClientId))
    : raw).map(_mapItem);
  return { data, done: raw.length < INV_PAGE_SIZE };
}

// Parallel fetch with CONCURRENCY pages at a time, then 1s pause between batches
async function fetchAllInventory(email, password, onProgress, filterClientId) {
  const token = await getToken(email, password);
  const CONCURRENCY = filterClientId ? 5 : 3; // faster for single-client test syncs
  let all = [];
  let pageIndex = 0;
  let done = false;

  while (!done && pageIndex < MAX_PAGES * CONCURRENCY) {
    // Fire CONCURRENCY pages in parallel
    const indices = [];
    for (let c = 0; c < CONCURRENCY; c++) indices.push(pageIndex + c);
    pageIndex += CONCURRENCY;

    const results = await Promise.all(indices.map(i => fetchInventoryPage(token, i, filterClientId)));

    for (const res of results) {
      all = all.concat(res.data);
      if (res.done) { done = true; break; }
    }

    if (onProgress) onProgress(all.length);
    if (!done) await new Promise(r => setTimeout(r, 1000)); // 1s between batches
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
