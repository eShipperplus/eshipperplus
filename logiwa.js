'use strict';
/**
 * Logiwa WMS API Service
 * Handles auth, inventory sync (pull), and inventory movements (push)
 */

const https = require('https');

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

// ── Inventory fetch ───────────────────────────────────────────────────────────
const INV_PAGE_SIZE = 500;

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

// Fetch a single page — tries query param filter first, falls back to unfiltered
async function fetchInventoryPage(token, index, filterClientId) {
  // Try with clientIdentifier query param
  const path = filterClientId
    ? `/v3.1/Inventory/list/i/${index}/s/${INV_PAGE_SIZE}?clientIdentifier=${filterClientId}`
    : `/v3.1/Inventory/list/i/${index}/s/${INV_PAGE_SIZE}`;
  const r = await _request('GET', path, null, token);
  if (!r.body?.data) return { data: [], done: true, rawCount: 0 };
  const raw = r.body.data;
  return {
    data: raw.map(_mapItem),
    done: raw.length < INV_PAGE_SIZE,
    rawCount: raw.length,
  };
}

// Real-time SKU search — fetches pages in parallel batches for speed
async function searchInventoryBySku(email, password, sku, clientId) {
  const token = await getToken(email, password);
  const skuLower = sku.trim().toLowerCase();
  const matches = [];
  const MAX_PAGES = 20;   // up to 10k items
  const CONCURRENCY = 5;  // fetch 5 pages at once
  let pageIndex = 0;
  let done = false;

  while (!done && pageIndex < MAX_PAGES && matches.length < 50) {
    const indices = [];
    for (let c = 0; c < CONCURRENCY && pageIndex + c < MAX_PAGES; c++) indices.push(pageIndex + c);
    pageIndex += indices.length;

    const results = await Promise.all(indices.map(i => {
      const path = clientId
        ? `/v3.1/Inventory/list/i/${i}/s/${INV_PAGE_SIZE}?clientIdentifier=${clientId}`
        : `/v3.1/Inventory/list/i/${i}/s/${INV_PAGE_SIZE}`;
      return _request('GET', path, null, token);
    }));

    for (const r of results) {
      if (!r.body?.data || r.body.data.length === 0) { done = true; break; }
      matches.push(...r.body.data
        .filter(x => x.productSku && x.productSku.toLowerCase().includes(skuLower))
        .map(_mapItem));
      if (r.body.data.length < INV_PAGE_SIZE) { done = true; break; }
    }
  }
  return matches;
}

// Fetch all inventory pages in parallel batches of CONCURRENCY
async function fetchAllInventory(email, password, onProgress, filterClientId) {
  const token = await getToken(email, password);
  const CONCURRENCY = 3;
  const MAX_PAGES = 100; // 50k items max
  let all = [];
  let pageIndex = 0;
  let done = false;

  while (!done && pageIndex < MAX_PAGES) {
    const indices = [];
    for (let c = 0; c < CONCURRENCY && pageIndex + c < MAX_PAGES; c++) {
      indices.push(pageIndex + c);
    }
    pageIndex += indices.length;

    const results = await Promise.all(indices.map(i => fetchInventoryPage(token, i, filterClientId)));

    for (const res of results) {
      all = all.concat(res.data);
      if (res.done) { done = true; break; }
    }

    if (onProgress) onProgress(all.length);
    if (!done) await new Promise(r => setTimeout(r, 1000));
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
  searchInventoryBySku,
  addInventory,
  removeInventory,
  adjustInventory,
  transferProduct,
};
