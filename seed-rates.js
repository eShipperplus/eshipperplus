'use strict';
/**
 * seed-rates.js — Apply the standard rate card to ALL customers in Firestore
 *
 * Usage:
 *   node seed-rates.js --sa path/to/service-account.json [--overwrite]
 *
 * --overwrite   Replace rates even for customers that already have them.
 *               Default: only fills in customers with NO rates set yet.
 *
 * Get your service account from:
 *   Google Cloud Console → IAM & Admin → Service Accounts
 *   → your service account → Keys → Add Key → JSON
 */

const path = require('path');
const args = process.argv.slice(2);
const saPath = args[args.indexOf('--sa') + 1];
const overwrite = args.includes('--overwrite');

if (!saPath) {
  console.error('Usage: node seed-rates.js --sa path/to/service-account.json [--overwrite]');
  process.exit(1);
}

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: cert(require(path.resolve(saPath))) });
const db = getFirestore();

// ─── Standard Rate Card (from SALT & STONE INC PDF, used as template) ─────────
//
// Structure: { jobTypeId: { fieldId: rate } }
// Rate = dollars per unit of that field.
//
// Source mapping:
//   labour_hours     → $40.00  Warehouse Labour / Returns Inspection / Cycle Count
//   inspection_hours → $40.00  Inbound Inspection Fee
//   cartons          → $0.50   Additional Pick / Sorting & Handling (up to 25 lbs)
//   units            → $0.20   Additional Pick per item (BTS/general)
//   labels           → $0.50   Labelling (item handling included)
//   pallets          → $7.50   Inbound/Outbound Standard per pallet
//   pallets_wrapped  → $7.50   Inbound/Outbound Standard per pallet
//   kits_made        → $3.00   First Item Pick per order (kit = 1 order)
//   skus             → $0.35   Additional SKU Pick
//   days             → $10.00  Cross-docking per pallet/week (≈ $10/day)

const DEFAULT_RATES = {
  bts: {
    pallets_wrapped:   7.50,
    cartons:           0.50,
    labels:            0.50,
    units:             0.20,
    inspection_hours: 40.00,
  },
  kit: {
    kits_made:        3.00,
    labour_hours:    40.00,
    units:            0.15,   // Sorting & Handling/Kitting per item/touch
    cartons:          0.50,
    labels:           0.50,
    skus:             0.35,
  },
  cycle_count: {
    labour_hours:            40.00,
    pallets_shrink_wrapped:   7.50,
    pallets_put_away:         7.50,
    pallets_let_down:         7.50,
    pallets_consolidated:     7.50,
    units:                    0.20,
    cartons:                  0.50,
    unit_labels:              0.50,
    carton_labels:            0.50,
  },
  disposal: {
    inspection_hours: 40.00,
    units:             0.20,
    pallets:           7.50,
  },
  consolidation: {
    labour_hours: 40.00,
    units:         0.15,
    pallets:       7.50,
    cartons:       0.50,
  },
  closeout: {
    pallets:      7.50,
    labour_hours: 40.00,
    units:         0.15,
    cartons:       0.50,
  },
  image_request: {
    labour_hours: 40.00,
    units:         0.20,
    cartons:       0.50,
  },
  capture_item_details: {
    units:        0.20,
    labour_hours: 40.00,
    cartons:      0.50,
  },
  miscellaneous: {
    units:        0.20,
    pallets:      7.50,
    cartons:      0.50,
    labour_hours: 40.00,
  },
  returns_inspection: {
    inspection_hours: 40.00,
    units:             0.20,
    cartons:           3.50,  // Returns $3.50 per carton
    pallets:           7.50,
  },
  relabelling_repack: {
    labour_hours: 40.00,
    units:         0.50,  // Labelling per item
    pallets:       7.50,
  },
  cross_dock: {
    cartons:      0.50,
    units:        0.20,
    days:        10.00,  // Cross-docking per pallet/week ≈ $10/day
    labour_hours: 40.00,
    pallets:      7.50,
    labels:       0.50,
  },
};

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  SEED RATES — eShipper+ Warehouse Billing');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Mode: ${overwrite ? '⚠️  OVERWRITE ALL (including existing)' : '✅  SAFE (skip customers with existing rates)'}`);
  console.log('');

  // 1. Load current customers list
  const custSnap = await db.collection('wh_config').doc('customers').get();
  if (!custSnap.exists || !custSnap.data().list?.length) {
    console.error('❌  No customers found in wh_config/customers. Add customers first.');
    process.exit(1);
  }
  const customers = custSnap.data().list;
  console.log(`  Found ${customers.length} customer(s):`);
  customers.forEach(c => console.log(`    • ${c}`));
  console.log('');

  // 2. Load existing rate cards
  const rateSnap = await db.collection('wh_config').doc('rateCards').get();
  const existing = rateSnap.exists ? rateSnap.data() : {};

  // 3. Build new rate cards object
  const updated = { ...existing };
  let seeded = 0, skipped = 0;

  for (const customer of customers) {
    if (!overwrite && existing[customer] && Object.keys(existing[customer]).length > 0) {
      console.log(`  ⏭  Skipping "${customer}" — already has rates`);
      skipped++;
      continue;
    }
    updated[customer] = DEFAULT_RATES;
    console.log(`  ✅  Applied default rates to "${customer}"`);
    seeded++;
  }

  if (seeded === 0) {
    console.log('\n  Nothing to update. Use --overwrite to replace existing rates.');
    process.exit(0);
  }

  // 4. Save back to Firestore
  await db.collection('wh_config').doc('rateCards').set(updated);

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Done! Applied to ${seeded} client(s), skipped ${skipped}.`);
  console.log('  Log in to the app → Rate Cards to review & adjust.');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
