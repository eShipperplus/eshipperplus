# eShipper+ Warehouse Billing

Full-stack warehouse billing prototype — Node.js/Express + Firestore + Firebase Auth, deployed on Google Cloud Run.

## Setup

### 1. GCP & Firebase

```bash
# Enable required APIs
gcloud services enable run.googleapis.com firestore.googleapis.com \
  cloudbuild.googleapis.com firebase.googleapis.com

# Create Firestore database (native mode)
gcloud firestore databases create --region=northamerica-northeast1
```

In [Firebase Console](https://console.firebase.google.com):
- Create a Firebase project linked to your GCP project
- Enable **Authentication → Google** sign-in provider
- Copy the **web app config** (apiKey, authDomain, etc.)

### 2. Configure the frontend

Edit `public/index.html` and replace the `FIREBASE_CONFIG` object near the bottom:

```js
const FIREBASE_CONFIG = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### 3. Service Account & GitHub Secrets

```bash
# Create service account
gcloud iam service-accounts create warehouse-billing-sa \
  --display-name="Warehouse Billing SA"

# Grant required roles
PROJECT_ID=$(gcloud config get-value project)
SA="warehouse-billing-sa@${PROJECT_ID}.iam.gserviceaccount.com"
for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/datastore.owner roles/storage.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=$ROLE
done

# Download key
gcloud iam service-accounts keys create sa-key.json --iam-account=$SA
```

Add to GitHub repository secrets:
- `GCP_SA_KEY` — contents of `sa-key.json`
- `GCP_PROJECT_ID` — your GCP project ID

### 4. Deploy Firestore rules & indexes

```bash
npm install -g firebase-tools
firebase login
firebase use your-project-id
firebase deploy --only firestore
```

### 5. Deploy

```bash
git push origin main
# GitHub Actions triggers Cloud Build → deploys to Cloud Run
```

After first deploy, add the Cloud Run URL to Firebase Auth → Authorized Domains.

### 6. First-time admin setup

1. Sign in with Google — you'll be created as **Associate** by default
2. In Firestore console, find `wh_users/{your-uid}` and set `role: "admin"`
3. Use the **Users & Teams** panel to manage all other users

### 7. Seed initial data (Firestore console)

Create document `/wh_config/customers`:
```json
{ "list": ["Customer A", "Customer B", "Customer C"] }
```

Create document `/wh_config/targets`:
```json
{
  "bts": { "targetMarginPct": 50, "goodThresholdPct": 10 },
  "kit": { "targetMarginPct": 45, "goodThresholdPct": 10 }
}
```

## Local Development

```bash
npm install

# Set up Application Default Credentials
gcloud auth application-default login

export GCP_PROJECT=your-project-id
npm run dev
# → http://localhost:8080
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `GCP_PROJECT` | GCP project ID (for Firestore) |
| `FIREBASE_SERVICE_ACCOUNT` | JSON string of service account (optional — uses ADC if absent) |

## Architecture

```
GitHub main branch
  → GitHub Actions
    → Cloud Build
      → Docker image → gcr.io
        → Cloud Run (northamerica-northeast1)
          ├── GET /api/init         — load all data scoped by role
          ├── POST/PUT /api/jobs/*  — job CRUD + workflow
          ├── GET /api/export/csv   — admin CSV export
          ├── PUT /api/rates        — rate card management
          ├── PUT/GET /api/users/*  — user & role management
          └── /api/teams/*          — team management

Firestore collections:
  /wh_jobs      — job documents
  /wh_config    — customers, jobTypes, rateCards, targets
  /wh_users     — user profiles & roles
  /wh_teams     — team definitions
  /wh_audit     — append-only audit log
```

## Roles

| Role | Permissions |
|---|---|
| `admin` | Full access — all data, settings, delete, CSV export |
| `manager` | View/edit all jobs, assign associates, complete jobs |
| `associate` | Log self-created jobs, complete assigned jobs, view own jobs |
| `office_support` | Create jobs and assign to manager, view own created jobs |

All role enforcement is server-side.
