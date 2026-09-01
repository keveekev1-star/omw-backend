# On My Way — Free Tier Setup Guide
## Vercel + Render + Supabase + Cloudflare R2 + Auth0

Everything here is free. No credit card required for any step marked FREE.
Estimated time: 45–60 minutes.

---

## What You're Setting Up

```
Auth0          → Login / identity          FREE (7,500 users)
Supabase       → PostgreSQL database       FREE (500MB, forever)
Cloudflare R2  → File storage              FREE (10GB, no egress fees)
Render         → Backend API server        FREE (sleeps when idle)
Vercel         → Frontend SPA              FREE (forever)
```

---

## STEP 1 — Auth0 (15 min)

### 1a. Create your SPA Application
1. Go to [manage.auth0.com](https://manage.auth0.com) → sign up free
2. **Applications → Create Application**
3. Name: `On My Way SPA` → choose **Single Page Application** → Create
4. Go to **Settings** tab and fill in:

| Field | Value |
|---|---|
| Allowed Callback URLs | `http://localhost:3000, https://on-my-way.vercel.app` |
| Allowed Logout URLs | `http://localhost:3000, https://on-my-way.vercel.app` |
| Allowed Web Origins | `http://localhost:3000, https://on-my-way.vercel.app` |

5. Click **Save Changes**
6. Copy the **Client ID** — you'll need this in Step 5

### 1b. Create your M2M Application (server-side)
1. **Applications → Create Application**
2. Name: `On My Way API (M2M)` → choose **Machine to Machine** → Create
3. Select **Auth0 Management API** → expand and enable these scopes:
   - `read:users`
   - `update:users`
   - `delete:users`
4. Click **Authorize**
5. Go to **Settings** → copy **Client ID** and **Client Secret**
   (This secret stays on your server — never in the frontend)

### 1c. Create an API audience
1. **APIs → Create API**
2. Name: `On My Way API`
3. Identifier (audience): `https://api.on-my-way.com`
4. Click **Create**

---

## STEP 2 — Supabase Database (5 min)

1. Go to [supabase.com](https://supabase.com) → sign up free
2. **New Project** → fill in:
   - Name: `on-my-way`
   - Database password: generate a strong one and **save it**
   - Region: **West US (North California)** — closest to Seattle
3. Wait ~2 minutes for the project to spin up
4. Go to **Settings → Database → Connection string → URI**
5. Copy the full `postgresql://...` connection string
6. Replace `[YOUR-PASSWORD]` in the string with your actual password
7. Save this — it's your `DATABASE_URL`

### Run the schema
Once your backend is deployed (Step 4), run:
```bash
npm run migrate
```
This creates all tables automatically.

---

## STEP 3 — Cloudflare R2 Storage (10 min)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → sign up free
   (Free account — no domain needed, just an email)
2. In the left sidebar → **R2 Object Storage → Create bucket**
3. Bucket name: `onmyway-documents` → Create bucket
4. Note your **Account ID** from the right sidebar on the main dashboard

### Create R2 API Token
1. **R2 → Manage R2 API Tokens → Create API Token**
2. Name: `On My Way Backend`
3. Permissions: **Object Read & Write**
4. Specify bucket: `onmyway-documents`
5. Click **Create API Token**
6. Copy and save:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (shown again here)

---

## STEP 4 — Render Backend (10 min)

### 4a. Push backend to GitHub first
```bash
cd on-my-way-backend
git init
git add .
git commit -m "Initial On My Way backend"
# Create a new repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/omw-backend.git
git push -u origin main
```

### 4b. Deploy on Render
1. Go to [render.com](https://render.com) → sign up free (use GitHub)
2. **New → Web Service**
3. Connect your `omw-backend` GitHub repo
4. Configure:

| Setting | Value |
|---|---|
| Name | `on-my-way-api` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Plan | **Free** |

5. Click **Advanced → Add Environment Variable** and add each one:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(your Supabase connection string from Step 2)* |
| `AUTH0_DOMAIN` | `on-my-way.us.auth0.com` |
| `AUTH0_AUDIENCE` | `https://api.on-my-way.com` |
| `AUTH0_MGMT_CLIENT_ID` | *(M2M Client ID from Step 1b)* |
| `AUTH0_MGMT_CLIENT_SECRET` | *(M2M Client Secret from Step 1b)* |
| `R2_ACCOUNT_ID` | *(from Step 3)* |
| `R2_ACCESS_KEY_ID` | *(from Step 3)* |
| `R2_SECRET_ACCESS_KEY` | *(from Step 3)* |
| `R2_BUCKET` | `onmyway-documents` |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://on-my-way.vercel.app` |

6. Click **Create Web Service**
7. Wait for deploy (~3 min) → copy your Render URL
   It will look like: `https://on-my-way-api.onrender.com`

### 4c. Run database migration
In Render dashboard → your service → **Shell** tab:
```bash
npm run migrate
```

### 4d. Test the backend
Visit `https://on-my-way-api.onrender.com/health` in your browser.
You should see:
```json
{ "status": "ok", "service": "on-my-way-api" }
```

---

## STEP 5 — Vercel Frontend (5 min)

### 5a. Push frontend to GitHub
```bash
cd on-my-way-spa
git init
git add .
git commit -m "Initial On My Way frontend"
git remote add origin https://github.com/YOUR_USERNAME/omw-frontend.git
git push -u origin main
```

### 5b. Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → sign up free (use GitHub)
2. **Add New → Project** → import your `omw-frontend` repo
3. Framework: **Create React App** (auto-detected)
4. Click **Environment Variables** and add:

| Key | Value |
|---|---|
| `REACT_APP_AUTH0_CLIENT_ID` | *(SPA Client ID from Step 1a)* |
| `REACT_APP_API_URL` | `https://on-my-way-api.onrender.com` |

5. Click **Deploy**
6. Wait ~2 min → Vercel gives you a URL like `https://on-my-way.vercel.app`

### 5c. Update Auth0 with your real Vercel URL
Back in Auth0 → your SPA app → Settings, update all three URL fields
to include your real Vercel URL (replace the placeholder you added in Step 1a).

---

## STEP 6 — Test Everything (5 min)

1. Open `https://on-my-way.vercel.app`
2. You should see the On My Way login screen
3. Click **Sign In / Create Account**
4. Auth0 Universal Login appears
5. Create a test account
6. You land on the account-type selection screen
7. Complete the signup flow

### Quick health checks
```
Frontend:  https://on-my-way.vercel.app           → login screen
Backend:   https://on-my-way-api.onrender.com/health → {"status":"ok"}
Database:  Supabase dashboard → Table Editor → users table appears
Storage:   Cloudflare R2 dashboard → onmyway-documents bucket exists
```

---

## Free Tier Limits to Know

| Service | Free Limit | What Happens if You Hit It |
|---|---|---|
| Auth0 | 7,500 active users/mo | Login blocked — upgrade to $23/mo |
| Supabase | 500MB database, 2GB bandwidth | Pause project — upgrade to $25/mo |
| Cloudflare R2 | 10GB storage, 10M reads/mo | Charged at $0.015/GB — still cheap |
| Render | 750 hrs/mo (1 service = fine) | Service suspended — upgrade to $7/mo |
| Vercel | 100GB bandwidth/mo | Soft limit — upgrade to $20/mo |

For testing with real users this is **more than enough**. You won't hit these limits until you have hundreds of active users.

---

## When You're Ready to Upgrade

The migration path is clean — change only the environment variables:

```
Supabase   → AWS RDS us-west-2      (change DATABASE_URL)
Cloudflare → AWS S3 us-west-2       (change 3 lines in storage.js)
Render     → AWS App Runner          (deploy same Dockerfile)
Vercel     → stays on Vercel         (or Cloudflare Pages — free forever)
```

No code changes needed — just new credentials.

---

## Local Development

To run everything locally before deploying:

```bash
# Terminal 1 — Backend
cd on-my-way-backend
cp .env.example .env
# Fill in .env with your real credentials
npm install
npm run dev
# Backend runs at http://localhost:4000

# Terminal 2 — Frontend
cd on-my-way-spa
cp .env.example .env.local
# Add your Auth0 Client ID and http://localhost:4000 as API URL
npm install
npm start
# Frontend runs at http://localhost:3000
```
