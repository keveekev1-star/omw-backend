# On My Way — Backend API

Secure Node.js + Express backend for On My Way.
Deployed on AWS us-west-2 (Oregon) — closest region to Seattle, WA.

## Privacy by Design

GPS coordinates are **never stored server-side** — period.

```
What stays on the user's device:
  ✓ Exact GPS coordinates
  ✓ Real-time route during trip
  ✓ Precise pickup / dropoff points

What the server receives:
  ✓ Distance in miles (number only)
  ✓ General region (e.g. "Seattle Metro")
  ✓ Contribution amount
  ✓ Trip date (day precision only)
```

This satisfies the Washington My Health MY Data Act (MHMD) geofencing requirement — we cannot track users near sensitive locations because we never receive their coordinates.

---

## Auto-Deletion Schedule

| Data | Deleted After | Method |
|---|---|---|
| Selfie photos | 24 hours | Cron job → S3 delete |
| ID documents | 30 days post-approval | Cron job → S3 delete |
| Driver abstracts | 30 days post-approval | Cron job → S3 delete |
| Trip timestamps | 90 days | Cron job → NULL fields |
| Raw ratings | 1 year | Cron job → aggregated |
| Contribution records | 7 years | Cron job → DB delete (IRS) |
| Deleted accounts | 30 days | Cron job → hard delete |
| Export files | 48 hours | Cron job → S3 delete |

---

## Setup

### 1. Prerequisites
- Node.js 20+
- PostgreSQL 15+ (AWS RDS recommended)
- AWS account with S3 bucket in us-west-2
- Auth0 M2M application (separate from the SPA app)

### 2. Auth0 M2M Application
1. Auth0 Dashboard → Applications → Create → Machine to Machine
2. Authorize it for the Auth0 Management API
3. Grant scopes: `read:users`, `update:users`, `delete:users`
4. Copy Client ID and Client Secret → paste into `.env`

### 3. AWS S3 Bucket
```bash
# Create bucket (us-west-2 for Seattle proximity)
aws s3api create-bucket \
  --bucket onmyway-documents-encrypted \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# Enable default encryption
aws s3api put-bucket-encryption \
  --bucket onmyway-documents-encrypted \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Block all public access
aws s3api put-public-access-block \
  --bucket onmyway-documents-encrypted \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### 4. Environment Variables
```bash
cp .env.example .env
# Fill in all values
```

### 5. Database
```bash
npm run migrate
```

### 6. Run locally
```bash
npm install
npm run dev
# API available at http://localhost:4000
```

---

## Deployment — AWS (us-west-2)

### Option A — AWS App Runner (easiest)
```bash
# Build and push Docker image
aws ecr create-repository --repository-name onmyway-api --region us-west-2
docker build -t onmyway-api .
docker tag onmyway-api:latest [account-id].dkr.ecr.us-west-2.amazonaws.com/onmyway-api:latest
docker push [account-id].dkr.ecr.us-west-2.amazonaws.com/onmyway-api:latest

# Create App Runner service in AWS Console
# → point to the ECR image
# → set environment variables in App Runner console
# → App Runner handles scaling, SSL, health checks automatically
```

### Option B — AWS Elastic Beanstalk
```bash
eb init on-my-way --platform node.js-20 --region us-west-2
eb create production
eb setenv $(cat .env | grep -v '#' | xargs)
eb deploy
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /health | None | Health check |
| GET | /api/users/me | JWT | Get own profile |
| PUT | /api/users/me/profile | JWT | Update account type/tier |
| GET | /api/users/me/export | JWT | Full data export (WPA/GDPR) |
| DELETE | /api/users/me | JWT | Delete account |
| GET | /api/trips | JWT | Trip history |
| POST | /api/trips | JWT + Traveler | Create trip record |
| PATCH | /api/trips/:id/complete | JWT | Complete trip |
| POST | /api/trips/:id/rate | JWT | Rate driver/passenger |
| GET | /api/verification/status | JWT | Verification status |
| POST | /api/verification/submit | JWT | Submit verification form |
| POST | /api/verification/upload/id | JWT | Upload government ID |
| POST | /api/verification/upload/selfie | JWT | Upload selfie (24hr auto-delete) |
| POST | /api/verification/upload/abstract | JWT | Upload driver's abstract |
| POST | /api/law-enforcement/log | Admin | Log LE disclosure |
| GET | /api/law-enforcement/log | Admin | View LE audit log |

---

## Compliance

| Standard | Status | Notes |
|---|---|---|
| Washington Privacy Act | ✅ | Delete + export endpoints |
| Washington MHMD | ✅ | GPS never collected server-side |
| PIPEDA | ✅ | Consent, deletion, export |
| GDPR | ✅ Ready | SCCs via AWS, delete/export |
| IRS 7-year retention | ✅ | Contribution records kept 7yr |
| ISO 27001 | ⏳ | AWS infrastructure certified |
