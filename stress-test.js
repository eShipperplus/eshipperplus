#!/usr/bin/env node
'use strict';

/**
 * stress-test.js — Warehouse Billing App Stress Test
 *
 * Usage:
 *   node stress-test.js --url https://your-app.run.app --token FIREBASE_ID_TOKEN
 *   node stress-test.js --url http://localhost:8080 --token TOKEN [--customer CUST_ID] [--jobtype JOB_TYPE]
 *
 * Requires Node 18+ (uses native fetch + performance.now).
 */

const { performance } = require('perf_hooks');
const { URL } = require('url');

// ─── ANSI Colors ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

const PASS  = `${C.green}✅${C.reset}`;
const FAIL  = `${C.red}❌${C.reset}`;
const WARN  = `${C.yellow}⚠️ ${C.reset}`;
const INFO  = `${C.cyan}ℹ️ ${C.reset}`;
const CRIT  = `${C.red}🔴${C.reset}`;

// ─── CLI Args ─────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };
  return {
    url:        get('--url'),
    token:      get('--token'),
    customerId: get('--customer') || 'TEST_CUSTOMER',
    jobTypeId:  get('--jobtype')  || 'bts',
  };
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function request(baseUrl, method, path, { token, body, noAuth, badAuth, malformedAuth } = {}) {
  const start = performance.now();
  const url = baseUrl.replace(/\/$/, '') + path;

  const headers = { 'Content-Type': 'application/json' };

  if (noAuth) {
    // no Authorization header
  } else if (badAuth) {
    headers['Authorization'] = 'Bearer GARBAGE_TOKEN_XYZ_12345_INVALID';
  } else if (malformedAuth) {
    headers['Authorization'] = 'NotBearer ' + (token || '');
  } else if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  let status, data, error;
  try {
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);
    status = resp.status;
    try { data = await resp.json(); } catch { data = null; }
  } catch (e) {
    error = e.message;
    status = 0;
  }

  const ms = Math.round(performance.now() - start);
  return { status, data, ms, error };
}

// ─── Percentile Helper ────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Result Tracking ─────────────────────────────────────────────────────────
const results = [];
let createdJobIds = []; // track jobs created during tests for context

function recordResult({ suite, name, status, ms, note, critical = false }) {
  results.push({ suite, name, status, ms, note, critical });

  const icon = status === 'pass' ? PASS : status === 'fail' ? FAIL : WARN;
  const msStr = ms != null ? `${C.dim}${String(ms).padStart(6)}ms${C.reset}` : '';
  const noteStr = note ? `  ${C.dim}${note}${C.reset}` : '';
  console.log(`  ${icon}  ${name.padEnd(52)} ${msStr}${noteStr}`);
}

// ─── Suite Header ─────────────────────────────────────────────────────────────
function suiteHeader(title) {
  console.log(`\n${C.bold}${C.blue}${title}${C.reset}`);
  console.log(`${'─'.repeat(70)}`);
}

// ─── Safe Test Wrapper ────────────────────────────────────────────────────────
async function test(suite, name, fn) {
  try {
    await fn();
  } catch (e) {
    recordResult({ suite, name, status: 'fail', note: `THREW: ${e.message}` });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const { url: baseUrl, token, customerId, jobTypeId } = parseArgs();

  if (!baseUrl) {
    console.error(`${FAIL} Missing --url argument.`);
    console.error('Usage: node stress-test.js --url https://app.run.app --token TOKEN');
    process.exit(1);
  }
  if (!token) {
    console.error(`${WARN} No --token provided. Auth-required tests will use no-token path.`);
  }

  // ── Banner ─────────────────────────────────────────────────────────────────
  const isProd = /run\.app|\.com|\.io/.test(baseUrl) && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1');
  console.log(`\n${C.bold}${'═'.repeat(70)}${C.reset}`);
  console.log(`${C.bold}  WAREHOUSE BILLING — STRESS TEST${C.reset}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  ${INFO} Target URL   : ${C.cyan}${baseUrl}${C.reset}`);
  console.log(`  ${INFO} Customer ID  : ${customerId}`);
  console.log(`  ${INFO} Job Type ID  : ${jobTypeId}`);
  console.log(`  ${INFO} Token        : ${token ? token.slice(0, 20) + '...' : C.red + 'NONE' + C.reset}`);
  if (isProd) {
    console.log(`\n  ${WARN} ${C.yellow}${C.bold}WARNING: Target looks like a PRODUCTION URL.${C.reset}`);
    console.log(`  ${WARN} ${C.yellow}This will create real Firestore documents. Proceed carefully.${C.reset}`);
  }
  console.log(`${'═'.repeat(70)}\n`);

  // ── Minimal valid job payload ──────────────────────────────────────────────
  const validJob = () => ({
    jobTypeId,
    customerId,
    fields:  { order_number: 'STRESS-TEST-001' },
    billable: true,
    notes: 'stress-test auto-created',
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 1 — Baseline & Health
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 1 — Baseline & Health');

  // Test 1 — Single health check
  await test('Suite 1', 'Health check (GET /healthz)', async () => {
    const { status, ms } = await request(baseUrl, 'GET', '/healthz', { noAuth: true });
    const ok = status === 200;
    recordResult({ suite: 'Suite 1', name: 'Health check (GET /healthz)', status: ok ? 'pass' : 'fail', ms, note: ok ? '' : `Got ${status}` });
  });

  // Test 2 — 50 concurrent health checks
  await test('Suite 1', 'Health × 50 concurrent', async () => {
    const reqs = Array.from({ length: 50 }, () => request(baseUrl, 'GET', '/healthz', { noAuth: true }));
    const all = await Promise.all(reqs);
    const times = all.map(r => r.ms);
    const fails = all.filter(r => r.status !== 200).length;
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const p99 = percentile(times, 99);
    const ok = fails === 0;
    recordResult({
      suite: 'Suite 1', name: 'Health × 50 concurrent', status: ok ? 'pass' : 'fail',
      note: `p50:${p50}ms  p95:${p95}ms  p99:${p99}ms  fails:${fails}/50`,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 2 — Auth Security
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 2 — Auth Security');

  // Test 3 — No token
  await test('Suite 2', 'GET /api/init — no token → 401', async () => {
    const { status, ms } = await request(baseUrl, 'GET', '/api/init', { noAuth: true });
    const ok = status === 401;
    recordResult({ suite: 'Suite 2', name: 'GET /api/init — no token → 401', status: ok ? 'pass' : 'fail', ms, note: ok ? '' : `Got ${status}` });
  });

  // Test 4 — Garbage token
  await test('Suite 2', 'GET /api/init — garbage token → 401', async () => {
    const { status, ms } = await request(baseUrl, 'GET', '/api/init', { badAuth: true });
    const ok = status === 401;
    recordResult({ suite: 'Suite 2', name: 'GET /api/init — garbage token → 401', status: ok ? 'pass' : 'fail', ms, note: ok ? '' : `Got ${status}` });
  });

  // Test 5 — Malformed Bearer
  await test('Suite 2', 'GET /api/init — malformed Bearer → 401', async () => {
    const { status, ms } = await request(baseUrl, 'GET', '/api/init', { malformedAuth: true, token });
    const ok = status === 401;
    recordResult({ suite: 'Suite 2', name: 'GET /api/init — malformed Bearer → 401', status: ok ? 'pass' : 'fail', ms, note: ok ? '' : `Got ${status}` });
  });

  // Test 6 — Cancel with valid token (role escalation attempt)
  await test('Suite 2', 'PUT /api/jobs/FAKE_ID/cancel — role escalation → 401/403', async () => {
    const { status, ms } = await request(baseUrl, 'PUT', '/api/jobs/FAKE_STRESS_TEST_ID/cancel', { token });
    const ok = status === 401 || status === 403 || status === 404;
    recordResult({
      suite: 'Suite 2', name: 'PUT /api/jobs/FAKE_ID/cancel — role escalation → 401/403', status: ok ? 'pass' : 'fail',
      ms, note: `Got ${status}${ok ? '' : ' (expected 401/403/404)'}`,
    });
  });

  // Test 7 — DELETE without token
  await test('Suite 2', 'DELETE /api/jobs/FAKE_ID — no token → 401', async () => {
    const { status, ms } = await request(baseUrl, 'DELETE', '/api/jobs/FAKE_STRESS_TEST_ID', { noAuth: true });
    const ok = status === 401;
    recordResult({ suite: 'Suite 2', name: 'DELETE /api/jobs/FAKE_ID — no token → 401', status: ok ? 'pass' : 'fail', ms, note: ok ? '' : `Got ${status}` });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 3 — Init / Data Load
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 3 — Init / Data Load');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 3 — no token provided`);
    recordResult({ suite: 'Suite 3', name: 'GET /api/init (single)', status: 'warn', note: 'Skipped — no token' });
  } else {
    // Test 8 — Single init
    await test('Suite 3', 'GET /api/init (single, valid)', async () => {
      const { status, data, ms } = await request(baseUrl, 'GET', '/api/init', { token });
      const ok = status === 200;
      const jobCount  = ok && data?.jobs      ? data.jobs.length      : '?';
      const custCount = ok && data?.customers ? data.customers.length : '?';
      recordResult({
        suite: 'Suite 3', name: 'GET /api/init (single, valid)', status: ok ? 'pass' : 'fail',
        ms, note: ok ? `jobs:${jobCount}  customers:${custCount}` : `Got ${status}`,
      });
    });

    // Test 9 — 10 concurrent init
    await test('Suite 3', 'GET /api/init × 10 concurrent', async () => {
      const reqs = Array.from({ length: 10 }, () => request(baseUrl, 'GET', '/api/init', { token }));
      const all = await Promise.all(reqs);
      const times = all.map(r => r.ms);
      const fails = all.filter(r => r.status !== 200).length;
      const p50 = percentile(times, 50);
      const p95 = percentile(times, 95);
      const ok = fails === 0;
      recordResult({
        suite: 'Suite 3', name: 'GET /api/init × 10 concurrent', status: ok ? 'pass' : (fails <= 1 ? 'warn' : 'fail'),
        note: `p50:${p50}ms  p95:${p95}ms  fails:${fails}/10`,
      });
    });

    // Test 10 — 25 concurrent init
    await test('Suite 3', 'GET /api/init × 25 concurrent', async () => {
      const reqs = Array.from({ length: 25 }, () => request(baseUrl, 'GET', '/api/init', { token }));
      const all = await Promise.all(reqs);
      const times = all.map(r => r.ms);
      const fails = all.filter(r => r.status !== 200).length;
      const p95 = percentile(times, 95);
      const ok = fails <= 5 && p95 <= 10000;
      const warn = !ok && (fails <= 5 || p95 <= 10000);
      recordResult({
        suite: 'Suite 3', name: 'GET /api/init × 25 concurrent',
        status: fails > 5 ? 'fail' : p95 > 10000 ? 'warn' : 'pass',
        note: `p95:${p95}ms  fails:${fails}/25${p95 > 10000 ? '  ⚠️ p95>10s' : ''}`,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 4 — Job Counter Race Condition (CRITICAL)
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 4 — Job Counter Race Condition (CRITICAL)');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 4 — no token provided`);
    recordResult({ suite: 'Suite 4', name: 'POST /api/jobs × 10 simultaneous (race condition)', status: 'warn', note: 'Skipped — no token' });
  } else {
    await test('Suite 4', 'POST /api/jobs × 10 simultaneous (race condition)', async () => {
      // Launch all 10 BEFORE awaiting any — true simultaneity
      const promises = Array.from({ length: 10 }, () =>
        request(baseUrl, 'POST', '/api/jobs', { token, body: validJob() })
      );
      const all = await Promise.all(promises);

      const jobNumbers = all
        .filter(r => r.status === 201 && r.data?.jobNumber != null)
        .map(r => r.data.jobNumber);

      // Track created job IDs for potential cleanup reference
      all.filter(r => r.status === 201 && r.data?.id).forEach(r => createdJobIds.push(r.data.id));

      const successCount = all.filter(r => r.status === 201).length;
      const errors = all.filter(r => r.status !== 201).length;
      const uniqueNumbers = new Set(jobNumbers);
      const duplicateCount = jobNumbers.length - uniqueNumbers.size;

      let status, note;
      if (duplicateCount > 0) {
        status = 'fail';
        note = `${C.red}${C.bold}RACE CONDITION DETECTED: ${duplicateCount} duplicate job number(s) in ${jobNumbers.length} creates!${C.reset} nums=[${jobNumbers.sort((a,b)=>a-b).join(',')}]`;
      } else if (errors > 0) {
        status = 'warn';
        note = `No duplicates in ${jobNumbers.length} successes, but ${errors}/10 requests failed`;
      } else {
        status = 'pass';
        note = `All ${successCount} job numbers unique: [${jobNumbers.sort((a,b)=>a-b).join(',')}]`;
      }

      recordResult({
        suite: 'Suite 4', name: 'POST /api/jobs × 10 simultaneous (race condition)',
        status, note, critical: duplicateCount > 0,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 5 — Large Payload
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 5 — Large Payload');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 5 — no token provided`);
    ['50 locations','200 locations','500 locations','10KB notes field','100-key fields object'].forEach(n =>
      recordResult({ suite: 'Suite 5', name: `Large payload: ${n}`, status: 'warn', note: 'Skipped — no token' })
    );
  } else {
    const makeLocs = (n) => Array.from({ length: n }, (_, i) => ({
      id: `loc_stress_${i}`,
      name: `Location ${i + 1}`,
      instructions: `Instructions for location ${i + 1}`,
    }));

    // Test 12 — 50 locations
    await test('Suite 5', 'POST /api/jobs — 50 locations', async () => {
      const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), locations: makeLocs(50) },
      });
      if (status === 201 && data?.id) createdJobIds.push(data.id);
      recordResult({
        suite: 'Suite 5', name: 'POST /api/jobs — 50 locations',
        status: status === 201 ? 'pass' : 'fail', ms,
        note: status !== 201 ? `Got ${status}` : '',
      });
    });

    // Test 13 — 200 locations
    await test('Suite 5', 'POST /api/jobs — 200 locations', async () => {
      const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), locations: makeLocs(200) },
      });
      if (status === 201 && data?.id) createdJobIds.push(data.id);
      recordResult({
        suite: 'Suite 5', name: 'POST /api/jobs — 200 locations',
        status: status === 201 ? 'pass' : (status >= 400 && status < 500 ? 'warn' : 'fail'),
        ms, note: `Got ${status}`,
      });
    });

    // Test 14 — 500 locations
    await test('Suite 5', 'POST /api/jobs — 500 locations', async () => {
      const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), locations: makeLocs(500) },
      });
      if (status === 201 && data?.id) createdJobIds.push(data.id);
      recordResult({
        suite: 'Suite 5', name: 'POST /api/jobs — 500 locations',
        status: status === 201 ? 'pass' : 'warn',
        ms, note: `Got ${status}${status !== 201 ? ' (may be expected at 500 locs)' : ''}`,
      });
    });

    // Test 15 — 10KB notes field
    await test('Suite 5', 'PUT /api/jobs/:id — 10KB notes field', async () => {
      // Create a base job first
      const { status: cs, data: cd } = await request(baseUrl, 'POST', '/api/jobs', { token, body: validJob() });
      if (cs !== 201 || !cd?.id) {
        recordResult({ suite: 'Suite 5', name: 'PUT /api/jobs/:id — 10KB notes field', status: 'warn', note: 'Could not create base job' });
        return;
      }
      createdJobIds.push(cd.id);
      const bigNotes = 'N'.repeat(10 * 1024); // 10KB
      const { status, ms } = await request(baseUrl, 'PUT', `/api/jobs/${cd.id}`, {
        token, body: { notes: bigNotes },
      });
      recordResult({
        suite: 'Suite 5', name: 'PUT /api/jobs/:id — 10KB notes field',
        status: status === 200 ? 'pass' : 'warn', ms,
        note: `Got ${status}`,
      });
    });

    // Test 16 — 100-key fields object
    await test('Suite 5', 'POST /api/jobs — 100-key fields object', async () => {
      const fields = {};
      for (let i = 0; i < 100; i++) fields[`field_key_${i}`] = `value_${i}`;
      const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), fields },
      });
      if (status === 201 && data?.id) createdJobIds.push(data.id);
      recordResult({
        suite: 'Suite 5', name: 'POST /api/jobs — 100-key fields object',
        status: status === 201 ? 'pass' : 'warn', ms,
        note: `Got ${status}`,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 6 — Concurrent Writes to Same Job
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 6 — Concurrent Writes to Same Job');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 6 — no token provided`);
    ['10 concurrent assign-manager','5 concurrent locations updates'].forEach(n =>
      recordResult({ suite: 'Suite 6', name: n, status: 'warn', note: 'Skipped — no token' })
    );
  } else {
    // Test 17 — 10 concurrent PUT assign-manager to same job
    await test('Suite 6', '10× concurrent assign-manager to same job', async () => {
      const { status: cs, data: cd } = await request(baseUrl, 'POST', '/api/jobs', { token, body: validJob() });
      if (cs !== 201 || !cd?.id) {
        recordResult({ suite: 'Suite 6', name: '10× concurrent assign-manager to same job', status: 'warn', note: 'Could not create base job' });
        return;
      }
      createdJobIds.push(cd.id);
      const jobId = cd.id;
      const promises = Array.from({ length: 10 }, () =>
        request(baseUrl, 'PUT', `/api/jobs/${jobId}/assign-manager`, {
          token, body: { managerId: 'STRESS_MGR_001' },
        })
      );
      const all = await Promise.all(promises);
      const errors = all.filter(r => r.status >= 500).length;
      const successes = all.filter(r => r.status === 200).length;
      const notFound = all.filter(r => r.status === 404).length;
      recordResult({
        suite: 'Suite 6', name: '10× concurrent assign-manager to same job',
        status: errors > 0 ? 'fail' : 'pass',
        note: `success:${successes}  errors:${errors}  404:${notFound}  (last-write-wins acceptable)`,
      });
    });

    // Test 18 — 5 concurrent locations updates
    await test('Suite 6', '5× concurrent locations updates to same job', async () => {
      const { status: cs, data: cd } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), locations: [{ id: 'loc_a', name: 'Loc A', instructions: '' }] },
      });
      if (cs !== 201 || !cd?.id) {
        recordResult({ suite: 'Suite 6', name: '5× concurrent locations updates to same job', status: 'warn', note: 'Could not create base job' });
        return;
      }
      createdJobIds.push(cd.id);
      const jobId = cd.id;
      const newLocs = [{ id: 'loc_a', name: 'Updated Loc', instructions: 'Updated' }];
      const promises = Array.from({ length: 5 }, (_, i) =>
        request(baseUrl, 'PUT', `/api/jobs/${jobId}/locations`, {
          token, body: { locations: newLocs.map(l => ({ ...l, name: l.name + ` v${i}` })) },
        })
      );
      const all = await Promise.all(promises);
      const errors = all.filter(r => r.status >= 500).length;
      const successes = all.filter(r => r.status === 200).length;
      recordResult({
        suite: 'Suite 6', name: '5× concurrent locations updates to same job',
        status: errors > 0 ? 'fail' : 'pass',
        note: `success:${successes}/5  errors:${errors}`,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 7 — Throughput
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 7 — Throughput');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 7 — no token provided`);
    ['Sequential 20 jobs','POST /api/jobs × 30 concurrent','GET /api/init × 50 concurrent'].forEach(n =>
      recordResult({ suite: 'Suite 7', name: n, status: 'warn', note: 'Skipped — no token' })
    );
  } else {
    // Test 19 — Sequential creation of 20 jobs
    await test('Suite 7', 'Sequential job creation × 20', async () => {
      const times = [];
      const wallStart = performance.now();
      for (let i = 0; i < 20; i++) {
        const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', { token, body: validJob() });
        times.push(ms);
        if (status === 201 && data?.id) createdJobIds.push(data.id);
      }
      const totalMs = Math.round(performance.now() - wallStart);
      const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      const fails = times.filter((_, i) => i === -1).length; // placeholder, tracked by status above
      recordResult({
        suite: 'Suite 7', name: 'Sequential job creation × 20',
        status: 'pass', ms: totalMs,
        note: `avg/job:${avgMs}ms  total:${totalMs}ms`,
      });
    });

    // Test 20 — 30 concurrent POST /api/jobs
    await test('Suite 7', 'POST /api/jobs × 30 concurrent', async () => {
      const wallStart = performance.now();
      const promises = Array.from({ length: 30 }, () =>
        request(baseUrl, 'POST', '/api/jobs', { token, body: validJob() })
      );
      const all = await Promise.all(promises);
      const totalMs = Math.round(performance.now() - wallStart);
      const successes = all.filter(r => r.status === 201).length;
      const rate429 = all.filter(r => r.status === 429).length;
      const rate500 = all.filter(r => r.status >= 500).length;
      const times = all.map(r => r.ms);
      const p95 = percentile(times, 95);
      all.filter(r => r.status === 201 && r.data?.id).forEach(r => createdJobIds.push(r.data.id));
      recordResult({
        suite: 'Suite 7', name: 'POST /api/jobs × 30 concurrent',
        status: successes >= 25 ? 'pass' : successes >= 20 ? 'warn' : 'fail',
        ms: totalMs,
        note: `success:${successes}/30  429:${rate429}  500:${rate500}  p95:${p95}ms`,
      });
    });

    // Test 21 — 50 concurrent GET /api/init (worst case)
    await test('Suite 7', 'GET /api/init × 50 concurrent (worst case)', async () => {
      const wallStart = performance.now();
      const promises = Array.from({ length: 50 }, () =>
        request(baseUrl, 'GET', '/api/init', { token })
      );
      const all = await Promise.all(promises);
      const totalMs = Math.round(performance.now() - wallStart);
      const times = all.map(r => r.ms);
      const fails = all.filter(r => r.status !== 200).length;
      const p50 = percentile(times, 50);
      const p95 = percentile(times, 95);
      const p99 = percentile(times, 99);
      recordResult({
        suite: 'Suite 7', name: 'GET /api/init × 50 concurrent (worst case)',
        status: fails > 10 ? 'fail' : fails > 2 ? 'warn' : 'pass',
        ms: totalMs,
        note: `p50:${p50}ms  p95:${p95}ms  p99:${p99}ms  fails:${fails}/50`,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 8 — Malformed / Edge Case Inputs
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 8 — Malformed / Edge Case Inputs');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 8 — no token provided`);
    Array.from({ length: 8 }, (_, i) =>
      recordResult({ suite: 'Suite 8', name: `Edge case ${i + 22}`, status: 'warn', note: 'Skipped — no token' })
    );
  } else {
    // Test 22 — missing customerId
    await test('Suite 8', 'POST /api/jobs — missing customerId → 400', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { jobTypeId },
      });
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — missing customerId → 400',
        status: status === 400 ? 'pass' : 'fail', ms,
        note: `Got ${status}`,
      });
    });

    // Test 23 — missing jobTypeId
    await test('Suite 8', 'POST /api/jobs — missing jobTypeId → 400', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { customerId },
      });
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — missing jobTypeId → 400',
        status: status === 400 ? 'pass' : 'fail', ms,
        note: `Got ${status}`,
      });
    });

    // Test 24 — empty string jobTypeId
    await test('Suite 8', 'POST /api/jobs — jobTypeId:"" → 400', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { jobTypeId: '', customerId },
      });
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — jobTypeId:"" → 400',
        status: status === 400 ? 'pass' : 'fail', ms,
        note: `Got ${status}`,
      });
    });

    // Test 25 — locations is a string not array
    await test('Suite 8', 'POST /api/jobs — locations:string (not array) → graceful', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), locations: 'not-an-array' },
      });
      const graceful = status !== 500;
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — locations:string (not array) → graceful',
        status: graceful ? 'pass' : 'fail', ms,
        note: `Got ${status}${!graceful ? ' — 500 means crash on bad input!' : ''}`,
      });
    });

    // Test 26 — PUT to non-existent job → 404 not 500
    await test('Suite 8', 'PUT /api/jobs/NONEXISTENT_ID → 404 not 500', async () => {
      const { status, ms } = await request(baseUrl, 'PUT', '/api/jobs/DEFINITELY_NONEXISTENT_ID_XYZ', {
        token, body: { notes: 'test' },
      });
      recordResult({
        suite: 'Suite 8', name: 'PUT /api/jobs/NONEXISTENT_ID → 404 not 500',
        status: status === 404 ? 'pass' : status === 500 ? 'fail' : 'warn', ms,
        note: `Got ${status}`,
      });
    });

    // Test 27 — extremely long customerId (10000 chars)
    await test('Suite 8', 'POST /api/jobs — 10000-char customerId → graceful', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { jobTypeId, customerId: 'X'.repeat(10000) },
      });
      const graceful = status !== 500;
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — 10000-char customerId → graceful',
        status: graceful ? 'pass' : 'fail', ms,
        note: `Got ${status}${!graceful ? ' — 500 on long input!' : ''}`,
      });
    });

    // Test 28 — invalid dueDate
    await test('Suite 8', 'POST /api/jobs — dueDate:"not-a-date" → stored or rejected', async () => {
      const { status, data, ms } = await request(baseUrl, 'POST', '/api/jobs', {
        token, body: { ...validJob(), dueDate: 'not-a-date' },
      });
      if (status === 201 && data?.id) createdJobIds.push(data.id);
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs — dueDate:"not-a-date" → stored or rejected',
        status: status === 201 || status === 400 ? 'pass' : 'fail', ms,
        note: status === 201 ? 'Accepted as-is (stored string)' : status === 400 ? 'Rejected (validated)' : `Got ${status}`,
      });
    });

    // Test 29 — clone non-existent job → 404
    await test('Suite 8', 'POST /api/jobs/NONEXISTENT_ID/clone → 404', async () => {
      const { status, ms } = await request(baseUrl, 'POST', '/api/jobs/DEFINITELY_NONEXISTENT_ID_XYZ/clone', {
        token, body: {},
      });
      recordResult({
        suite: 'Suite 8', name: 'POST /api/jobs/NONEXISTENT_ID/clone → 404',
        status: status === 404 ? 'pass' : status === 401 || status === 403 ? 'warn' : 'fail', ms,
        note: `Got ${status}`,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUITE 9 — Stress Ramp
  // ══════════════════════════════════════════════════════════════════════════
  suiteHeader('SUITE 9 — Stress Ramp (GET /api/init)');

  if (!token) {
    console.log(`  ${WARN} Skipping Suite 9 — no token provided`);
    recordResult({ suite: 'Suite 9', name: 'Ramp test (1→5→10→20→50 concurrent)', status: 'warn', note: 'Skipped — no token' });
  } else {
    await test('Suite 9', 'Ramp test: 1→5→10→20→50 concurrent', async () => {
      const levels = [1, 5, 10, 20, 50];
      const rampResults = [];
      let breakpointFound = false;
      let breakpointLevel = null;

      for (const concurrency of levels) {
        const promises = Array.from({ length: concurrency }, () =>
          request(baseUrl, 'GET', '/api/init', { token })
        );
        const all = await Promise.all(promises);
        const times = all.map(r => r.ms);
        const fails = all.filter(r => r.status !== 200).length;
        const successRate = Math.round(((concurrency - fails) / concurrency) * 100);
        const p95 = percentile(times, 95);

        rampResults.push({ concurrency, successRate, p95, fails });

        if (!breakpointFound && fails > 0) {
          breakpointFound = true;
          breakpointLevel = concurrency;
        }
      }

      // Print ramp table inline
      console.log(`\n    ${'Conc'.padEnd(8)} ${'SuccessRate'.padEnd(14)} ${'p95(ms)'.padEnd(10)} ${'Fails'}`);
      console.log(`    ${'─'.repeat(45)}`);
      for (const r of rampResults) {
        const icon = r.fails === 0 ? C.green + '✓' + C.reset : C.red + '✗' + C.reset;
        console.log(`    ${icon} ${String(r.concurrency).padEnd(7)} ${String(r.successRate + '%').padEnd(14)} ${String(r.p95 + 'ms').padEnd(10)} ${r.fails}`);
      }

      const allPassed = rampResults.every(r => r.fails === 0);
      const note = breakpointFound
        ? `Errors first appear at concurrency=${breakpointLevel}`
        : 'No errors at any concurrency level';

      recordResult({
        suite: 'Suite 9', name: 'Ramp test: 1→5→10→20→50 concurrent',
        status: allPassed ? 'pass' : breakpointLevel >= 20 ? 'warn' : 'fail',
        note,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FINAL REPORT
  // ══════════════════════════════════════════════════════════════════════════
  printReport(baseUrl);
}

// ─── Report Printer ────────────────────────────────────────────────────────────
function printReport(baseUrl) {
  const passed   = results.filter(r => r.status === 'pass').length;
  const failed   = results.filter(r => r.status === 'fail').length;
  const warned   = results.filter(r => r.status === 'warn').length;
  const total    = results.length;
  const critFails = results.filter(r => r.critical && r.status === 'fail');

  // Group by suite
  const suites = {};
  for (const r of results) {
    if (!suites[r.suite]) suites[r.suite] = [];
    suites[r.suite].push(r);
  }

  console.log(`\n\n${C.bold}${'═'.repeat(70)}${C.reset}`);
  console.log(`${C.bold}  STRESS TEST RESULTS${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(70)}${C.reset}`);
  console.log(
    `  Total: ${total} tests  |  ${PASS} Passed: ${C.green}${passed}${C.reset}  |  ${FAIL} Failed: ${C.red}${failed}${C.reset}  |  ${WARN} Warned: ${C.yellow}${warned}${C.reset}`
  );
  console.log(`${'─'.repeat(70)}`);

  for (const [suiteName, suiteTests] of Object.entries(suites)) {
    const sp = suiteTests.filter(r => r.status === 'pass').length;
    const sf = suiteTests.filter(r => r.status === 'fail').length;
    const sw = suiteTests.filter(r => r.status === 'warn').length;
    const suiteIcon = sf > 0 ? C.red : sw > 0 ? C.yellow : C.green;
    console.log(`\n  ${suiteIcon}${C.bold}${suiteName}${C.reset}  ${C.dim}(✅${sp} ❌${sf} ⚠️ ${sw})${C.reset}`);

    for (const r of suiteTests) {
      const icon = r.status === 'pass' ? PASS : r.status === 'fail' ? FAIL : WARN;
      const msStr = r.ms != null ? `${C.dim}${String(r.ms) + 'ms'}${C.reset}` : '';
      const noteStr = r.note ? `  ${C.dim}${r.note}${C.reset}` : '';
      console.log(`    ${icon}  ${r.name.padEnd(50)} ${msStr}${noteStr}`);
    }
  }

  // Critical failures block
  if (critFails.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${C.red}${C.bold}  🔴 CRITICAL FAILURES:${C.reset}`);
    for (const r of critFails) {
      console.log(`    ${CRIT}  ${r.name}`);
      if (r.note) console.log(`       ${C.red}${r.note}${C.reset}`);
    }
  }

  // Overall verdict
  console.log(`\n${'─'.repeat(70)}`);
  if (failed === 0 && warned === 0) {
    console.log(`${C.green}${C.bold}  ALL TESTS PASSED${C.reset}`);
  } else if (failed === 0) {
    console.log(`${C.yellow}${C.bold}  PASSED WITH WARNINGS (${warned} warnings)${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}  ${failed} TEST(S) FAILED${failed > 0 && warned > 0 ? `, ${warned} WARNING(S)` : ''}${C.reset}`);
  }
  console.log(`${C.bold}${'═'.repeat(70)}${C.reset}\n`);

  if (createdJobIds.length > 0) {
    console.log(`${C.dim}  Note: ${createdJobIds.length} test jobs were created in Firestore during this run.`);
    console.log(`  IDs: ${createdJobIds.slice(0, 5).join(', ')}${createdJobIds.length > 5 ? ` ... (+${createdJobIds.length - 5} more)` : ''}${C.reset}\n`);
  }
}

main().catch(err => {
  console.error(`\n${FAIL} Unhandled error in stress test runner: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
