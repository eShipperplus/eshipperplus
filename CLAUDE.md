# eShipper+ Warehouse Billing App — Project Reference

## Overview
Internal warehouse operations management app for eShipper+. Manages warehouse jobs (BTS, Kitting, Cycle Count, etc.), assigns workers, tracks progress, calculates billing, and integrates with Logiwa WMS for inventory movements.

---

## Stack
- **Backend**: Node.js + Express → Google Cloud Run (auto-deploy via GitHub Actions)
- **Frontend**: Single-page app — vanilla JS, role-based rendering in `public/index.html`
- **Database**: Firebase Firestore (`eshipper-f56c3`)
- **Auth**: Firebase Auth (email/password + invite flow)
- **Storage**: Firebase Storage (`eshipper-f56c3.appspot.com`) — job photos + attachments
- **WMS**: Logiwa API v3.1 (`https://myapi.logiwa.com`)
- **Email**: nodemailer + Gmail SMTP

---

## Key Files
| File | Purpose |
|------|---------|
| `server.js` | Express backend — all API routes, Firebase Admin SDK, auth middleware |
| `public/index.html` | Entire frontend SPA — all views, modals, JS functions |
| `logiwa.js` | Logiwa WMS API service — auth, inventory fetch, movements |
| `package.json` | `npm start` → `node server.js`, `npm run dev` → `node --watch server.js` |

---

## Local Dev
```bash
cd eshipper-warehouse-billing
node server.js          # or: node --watch server.js
# open http://localhost:8080
```
Requires `FIREBASE_SERVICE_ACCOUNT` env var set in terminal (JSON string).
Without it, Firebase Admin falls back to Application Default Credentials.

---

## Deploy
```bash
git add <files>
git commit -m "message"
git push origin main    # triggers GitHub Action → Cloud Run deploy (~3 min)
```
**GitHub repo**: `https://github.com/eShipperplus/eshipperplus.git` (branch: `main`)
**DO NOT commit**: `node_modules/`, `dev_setup.js`, `seed-test-data.js`, `wipe-jobs.js`, `migrate-job-numbers.js`
**When remote is ahead**: `git stash && git pull --rebase origin main && git stash pop && git push origin main`

---

## Environment Variables (Cloud Run + local)
| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Admin SDK credentials (JSON string) |
| `SMTP_USER` | Gmail address for sending emails |
| `SMTP_PASS` | Gmail app password |
| `ALLOWED_ORIGIN` | CORS origin lock in production (optional) |
| `PORT` | Server port (Cloud Run sets automatically; defaults to 8080) |

---

## Roles & Permissions
| Role | Access |
|------|--------|
| `admin` | Full access — all routes, delete jobs, Integrations, billing, rate cards, user management |
| `manager` | Jobs, team management, analytics — no billing/rate cards |
| `office_support` | Jobs view only, assign managers/techs, no prices, no associates panel |
| `tech` | My Jobs only — pending_tech_review jobs, Logiwa attribute updates, complete tech review |
| `associate` | My Jobs only — mark tasks done, submit work, Transfer-only Logiwa movements |

---

## Job Status Flow
```
created
  → assigned_manager       (manager self-assigns)
  → assigned_associate     (manager assigns associate)
  → in_progress
  → pending_review         (associate submits work)
  → pending_tech_review    (manager completes, but job type has techReviewRequired=true)
  → completed              (manager reviews OR tech completes tech review)
  → cancelled              (admin/manager/office_support)
```
**Tech review gate**: if `jobType.techReviewRequired === true` and a non-tech/admin completes the job,
it moves to `pending_tech_review` instead of `completed`. Office support is emailed. OS assigns a tech.
Tech can update Logiwa attributes, then calls `completeTechReview()` to mark done.

---

## Built-in Job Types
| ID | Name | Color |
|----|------|-------|
| `bts` | Back to Stock | blue |
| `kit` | Kitting | teal |
| `cycle_count` | Cycle Count | purple |
| `disposal` | Disposal | red |
| `consolidation` | Consolidation | orange |
| `closeout` | Closeout | yellow |
| `image_request` | Image Request | pink |
| `capture_item_details` | Capture Item Details | gray |
| `miscellaneous` | Miscellaneous | gray |
| `returns_inspection` | Returns Inspection | orange |
| `relabelling_repack` | Relabelling & Repack | blue |
| `cross_dock` | Cross-Dock | teal |

Custom job types stored in Firestore `wh_config/jobTypes` (list array).
`techReviewRequired` flag on job type triggers the tech review workflow.

---

## Firestore Collections
| Collection | Contents |
|-----------|---------|
| `wh_jobs` | All warehouse jobs |
| `wh_config/jobTypes` | Job type definitions (list array) |
| `wh_config/customers` | Customer list (list array) |
| `wh_config/logiwa` | Logiwa credentials + client mappings + sync status |
| `wh_config/counters` | Job number counter (`jobCounter`) — used in Firestore transaction |
| `wh_config/rates` | Billing rate cards |
| `wh_config/targets` | KPI targets |
| `wh_logiwa_inventory` | Cached Logiwa inventory (synced via `/api/logiwa/sync`) |
| `wh_logs` | Activity log (all actions) |
| `wh_audit` | Audit trail per job |
| `wh_templates` | Job templates |
| `users` | User profiles with `role`, `displayName`, `email`, `hourlyRate`, `teamId` |
| `teams` | Team definitions with `managerId`, `memberIds` |

---

## All API Routes

### Jobs
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/init` | any auth | Bootstrap data load (jobs, config, users) |
| POST | `/api/jobs` | any auth | Create job |
| PUT | `/api/jobs/:id` | any auth | Edit job fields |
| PUT | `/api/jobs/:id/assign-manager` | manager, admin | Self-assign as manager |
| PUT | `/api/jobs/:id/assign-tech` | admin, office_support | Assign tech user |
| PUT | `/api/jobs/:id/assign-associate` | manager, admin | Assign associates |
| PUT | `/api/jobs/:id/locations` | any auth | Save task/location list |
| PUT | `/api/jobs/:id/locations/:locId/done` | any auth | Mark task done (with captured data) |
| PUT | `/api/jobs/:id/locations/:locId/reopen` | manager, admin | Reopen a done task |
| PUT | `/api/jobs/:id/submit-review` | any auth | Associate submits for review |
| PUT | `/api/jobs/:id/associate-submit` | any auth | Associate logs hours |
| PUT | `/api/jobs/:id/complete` | manager, admin, tech (pending_tech_review) | Complete job |
| PUT | `/api/jobs/:id/cancel` | admin, manager, office_support | Cancel job |
| DELETE | `/api/jobs/:id` | admin | Delete job |
| POST | `/api/jobs/:id/clone` | admin, manager, office_support | Clone job |
| POST | `/api/jobs/:id/locations/:locId/photos` | any auth | Upload task photo (base64) |
| POST | `/api/jobs/:id/attachments` | admin, manager, office_support, tech | Upload attachment (base64, max 15MB) |
| DELETE | `/api/jobs/:id/attachments/:attachmentId` | admin, manager, office_support, tech | Delete attachment |
| GET | `/api/jobs/:id/export/locations` | any auth | Export job locations as XLSX |

### Config & Admin
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/export/csv` | admin | Export all jobs as CSV |
| PUT | `/api/customers` | admin | Save customer list |
| PUT | `/api/customers/rename` | admin | Rename a customer |
| PUT | `/api/users/:uid/profile` | admin | Update user display name |
| PUT | `/api/jobtypes` | admin | Save job types |
| POST | `/api/jobtypes/seed` | admin | Seed built-in job types |
| PUT | `/api/rates` | admin | Save rate cards |
| POST | `/api/rates/seed-defaults` | admin | Seed default rates |
| PUT | `/api/targets` | admin | Save KPI targets |
| GET | `/api/users` | admin | List all users |
| PUT | `/api/users/:uid/role` | admin | Change user role |
| PUT | `/api/users/:uid/cost` | admin | Set hourly cost |
| POST | `/api/users/invite` | admin | Invite new user (creates Firebase Auth + Firestore) |
| POST | `/api/users/:uid/reset-password-link` | admin | Generate password reset link |
| PUT | `/api/users/:uid/password` | admin | Set user password |
| DELETE | `/api/users/:uid` | admin | Delete user |
| GET/POST/PUT/DELETE | `/api/teams` | admin | Team management |
| GET/POST/PUT/DELETE | `/api/templates` | manager, admin | Job templates |
| GET | `/api/logs` | manager, admin | Activity log |

### Logiwa WMS
| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/logiwa/active` | any auth | Check if Logiwa is configured (for associates) |
| GET | `/api/logiwa/status` | admin, manager, office_support, tech | Full Logiwa status + sync info |
| PUT | `/api/logiwa/config` | admin | Save Logiwa credentials + client mappings |
| GET | `/api/logiwa/clients` | admin | List Logiwa clients |
| POST | `/api/logiwa/sync` | admin | Background full inventory sync to Firestore |
| POST | `/api/logiwa/sync/reset` | admin | Clear stuck sync status |
| GET | `/api/logiwa/search` | any auth | Real-time SKU search (hits Logiwa API directly) |
| GET | `/api/logiwa/inventory` | any auth | Query cached inventory from Firestore |
| POST | `/api/logiwa/movement` | any auth | Post add/remove/adjust/transfer movement |
| PUT | `/api/logiwa/change-attributes` | admin, manager, tech | Update lot/expiry/production date |
| PUT | `/api/logiwa/product-update` | admin, manager, tech | Update product dims/weights/barcodes |

---

## Logiwa WMS Integration
- **Credentials**: stored in Firestore `wh_config/logiwa` (`email`, `password`)
- **Logiwa API creds**: `logiwa_api_user1@eshipperplus.com` / `eShipper+123`
- **Token cache**: 25-minute in-memory cache per email. Auto-retries on 401 (clears stale token).
- **Inventory sync**: Full sync fetches all pages (500 items/page, parallel batches), deletes old records in Firestore using do/while loop (handles >500 docs), writes new data in 500-item batches.
- **Inventory search**: Real-time via `/api/logiwa/search` (hits Logiwa directly). Falls back to Firestore cache via `/api/logiwa/inventory`.
- **Client mapping**: Admin maps customer names → Logiwa clientIdentifiers in Settings → Integrations. Stored in `wh_config/logiwa.clientMappings`. Used to filter inventory by client.
- **Associates**: Transfer-only (server enforces). Cannot add/remove/adjust.
- **Transfer payload fields**: `clientIdentifier`, `sourceWarehouseIdentifier`, `productIdentifier`, `packTypeIdentifier`, `sourceWarehouseLocationIdentifier`, `targetWarehouseLocationCode`, `quantity`. Do NOT include `sourceWarehouseLocationCode` (Logiwa rejects if both provided).
- **Movement note**: Always includes `[By:UserName]` for audit trail since Logiwa logs it as the API user.

---

## File Attachments
- Uploaded as base64 JSON body (`name`, `mimeType`, `data`, `size`)
- Server decodes, validates `buffer.length` (not user-supplied size), stores in Firebase Storage
- Path: `jobs/{jobId}/attachments/{timestamp}_{filename}`
- Signed URL: 10-year expiry (intentional — for handheld device access without re-auth)
- Allowed types: PDF, JPEG, PNG, WebP, GIF, DOC, DOCX, XLS, XLSX, MP4, MOV
- Max size: 15MB
- Visible to all workers in My Jobs card on handheld devices (read-only, tap to open)
- Admin/manager/office_support/tech can upload/delete

---

## CSV Task Import
Upload CSV to create job tasks/locations. Columns:
- Any column with values = **reference data** (shown to worker, read-only)
- Any column with all blank values = **capture field** (worker fills in on Mark Done)
- `Location` column (case-insensitive) = task name
- Template headers: `Location, SKU, Qty, Lot, Expiry, Notes, Count`

---

## Job Number Generation
Auto-incremented in a Firestore transaction (`wh_config/counters.jobCounter`).
Format: `ES-001`, `ES-002`, etc. Transaction ensures no duplicates under concurrent load.

---

## Frontend Architecture (`public/index.html`)
Single HTML file, ~5600 lines. Key sections:
- **State**: `state.user`, `state.data` (jobs, users, teams, etc.), `state.view`
- **Views**: `renderDashboard`, `renderMyJobs`, `renderManagerQueue`, `renderAllJobsTable`, `renderAnalytics`, `renderSettings`, `renderIntegrations`
- **Auth flow**: Firebase Auth SDK → `onAuthStateChanged` → `/api/init` → `renderView()`
- **Global functions**: All onclick handlers registered via `Object.assign(window, {...})` at bottom
- **Role-based nav**: `NAV_ITEMS` object keyed by role
- **Logiwa modal**: `openLogiwaMovementModal` → search SKU → select inventory record → choose movement type → submit. Transfer stores full item data in `data-item` attribute on option elements.
- **Tech complete**: `completeTechReview(jobId)` — calls PUT `/api/jobs/:id/complete` directly (no form needed). Do NOT use `submitReviewComplete` for tech buttons (it requires the review modal form).

---

## Known Gotchas & Patterns
- **Push rejected**: Always `git stash && git pull --rebase origin main && git stash pop && git push origin main`
- **Local Firebase**: `FIREBASE_SERVICE_ACCOUNT` env var must be set in Windows terminal (not WSL)
- **Kill stuck Node (WSL)**: `wmic process where "ProcessId=XXXX" delete`
- **Logiwa inventory**: 33,000+ items; no SKU filter on this API plan → sync ALL to Firestore, query from cache
- **Logiwa page size**: max 500 for inventory, max 200 for client list
- **Body limit**: 25MB (for base64 file uploads). Set in `express.json({ limit: '25mb' })`.
- **`job.customerId`**: Always use `job.customerId` (not `job.customer`) for Logiwa client mapping lookups
- **`completeTechReview` vs `submitReviewComplete`**: Tech buttons must use `completeTechReview()`. `submitReviewComplete()` is for managers only (requires `review-complete-form` DOM element).
- **Sync deletion**: Uses `do/while` loop with `.limit(500)` to drain all old inventory docs. Never use a simple for-loop over a `.limit(500)` result for deletion.
