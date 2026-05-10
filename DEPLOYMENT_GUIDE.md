# 🚀 GLM Ledger - Vercel Deployment Guide (Step-by-Step)

## 🎯 Goal
Deploy your GLM Ledger backend API to Vercel with everything working.

---

## 📋 Prerequisites
- GitHub account
- Vercel account (free - vercel.com)
- Upstash account (free - upstash.com) for Redis
- Neon account (free - neon.tech) for PostgreSQL

---

## STEP 1: Database Setup (Neon)

### 1.1 Create Neon Account
1. Go to https://neon.tech
2. Sign up with GitHub
3. Create a new project named `glm-ledger`

### 1.2 Get Database URL
1. In Neon dashboard, click on your project
2. Click "Connect"
3. Copy the connection string (starts with `postgresql://...`)
4. It looks like: `postgresql://user:password@host.neon.tech/glm_ledger?sslmode=require`

### 1.3 Run Migrations (IMPORTANT!)
1. In Neon dashboard, go to "SQL Editor"
2. Copy-paste ALL content from these SQL files (in order):
   - `core_tables.sql`
   - `schema.sql`
   - `001_initial_schema.sql`
   - `002_user_registration_core.sql`
   - `000_security.sql`
   - And any other .sql files you have
3. Click "Run" for each one

**OR use local command:**
```bash
# Set the DATABASE_URL first, then run:
npm run db:migrate
```

---

## STEP 2: Redis Setup (Upstash)

### 2.1 Create Upstash Account
1. Go to https://upstash.com
2. Sign up with GitHub
3. Create a new Redis database

### 2.2 Get Redis URL
1. In Upstash dashboard, click your database
2. Go to "Details" tab
3. Copy the "REDIS_URL" (starts with `rediss://...`)

---

## STEP 3: Generate JWT Secret

Run this command in your terminal (PowerShell/Git Bash):
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copy the long string that appears. This is your **JWT_SECRET**.

---

## STEP 4: Push Code to GitHub

If you haven't already:
```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit (IMPORTANT - this saves your fixes)
git commit -m "Fix Vercel serverless deployment issues"

# Add remote (replace with your actual GitHub repo URL)
git remote add origin https://github.com/YOUR_USERNAME/glm-ledger.git

# Push to GitHub
git push -u origin main
```

---

## STEP 5: Connect to Vercel

### 5.1 Import Project
1. Go to https://vercel.com
2. Click "Add New Project"
3. Select "Import Git Repository"
4. Choose your `glm-ledger` repo
5. Click "Import"

### 5.2 Project Settings (CRITICAL!)
When the settings page opens:

- **Framework Preset:** `Other`
- **Root Directory:** `./` (leave as default - project root)
- **Build Command:** `npm run build`
- **Output Directory:** `dist`

### 5.3 Add Environment Variables
Click "Environment Variables" and add these:

```
DATABASE_URL=postgresql://user:password@host.neon.tech/glm_ledger?sslmode=require
JWT_SECRET=your-64-char-secret-from-step-3
REDIS_URL=rediss://default:password@host.upstash.io:6379
CORS_ORIGIN=*
NODE_ENV=production
API_VERSION=1.0.0
```

**IMPORTANT:**
- Replace the values with YOUR actual values
- `CORS_ORIGIN=*` allows all origins (for testing). For production, use your frontend URL like `https://your-frontend.vercel.app`

### 5.4 Deploy
1. Click "Deploy"
2. Wait 2-3 minutes for build to complete
3. Vercel will give you a URL like `https://glm-ledger-xyz.vercel.app`

---

## STEP 6: Test Your Deployment

### 6.1 Test Health Endpoint
Open in browser:
```
https://glm-ledger-xyz.vercel.app/api/v1/health
```

You should see:
```json
{
  "status": "ok",
  "timestamp": "2026-05-10T...",
  "env": {
    "DATABASE_URL": true,
    "NEON_DATABASE_URL": false,
    "JWT_SECRET": true,
    "NODE_ENV": "production"
  }
}
```

### 6.2 Test Auth (Register)
Use a tool like Postman or curl:
```bash
curl -X POST https://glm-ledger-xyz.vercel.app/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "name": "Test User",
    "company_name": "Test Company"
  }'
```

If everything works, you'll get a response with access_token and user data.

---

## STEP 7: Deploy Frontend (Separate Vercel Project)

### 7.1 Go to Vercel Again
1. Click "Add New Project"
2. Import the SAME GitHub repo
3. But this time, set:
   - **Root Directory:** `frontend`
   - **Framework Preset:** `Next.js`
   
### 7.2 Add Environment Variables
```
NEXT_PUBLIC_API_URL=https://glm-ledger-xyz.vercel.app/api/v1
```

Replace `glm-ledger-xyz` with your actual backend URL.

### 7.3 Deploy
Click "Deploy".

---

## 🐛 Common Errors & Solutions

### Error: "Function Invocations Failed" or 500 Error
**Cause:** Serverless function crashing
**Fix:** Check Vercel Function Logs (in your project dashboard → Functions tab)

### Error: "Database connection timeout"
**Cause:** DATABASE_URL not set or incorrect
**Fix:** Double-check your Neon connection string

### Error: "JWT_SECRET is required"
**Cause:** JWT_SECRET missing or < 32 chars
**Fix:** Generate a new one and update in Vercel Environment Variables

### Error: "Redis connection refused"
**Cause:** REDIS_URL wrong or missing
**Fix:** Get correct URL from Upstash

### Error: CORS blocked
**Cause:** Frontend and backend on different domains
**Fix:** Update CORS_ORIGIN to match your frontend URL, or use `*` for testing

---

## 📁 Project Structure for Vercel

```
glm-ledger/
├── api/                  # Vercel serverless functions entry
│   ├── index.ts         # Main API catch-all
│   ├── health.ts        # Health check
│   ├── auth/index.ts    # Auth routes
│   └── ...
├── src/                 # Your backend source code
│   ├── api/routes/
│   ├── db/
│   └── ...
├── frontend/            # Next.js frontend (separate deploy)
├── vercel.json          # Vercel config
├── package.json
└── tsconfig.json
```

---

## ✅ Post-Deployment Checklist

- [ ] Health endpoint returns 200
- [ ] Auth register works
- [ ] Auth login works
- [ ] Frontend loads correctly
- [ ] Frontend can call backend API
- [ ] No CORS errors in browser console

---

## 🚀 Advanced: Automatic Deployment

Every time you push to GitHub, Vercel auto-deploys!
Just make sure:
1. All env vars are set in Vercel dashboard
2. Your `vercel.json` is correct
3. No TypeScript errors (`npx tsc --noEmit` passes)

---

## 📞 Need Help?

If stuck, check these:
1. Vercel Function Logs (Dashboard → Functions → Click function name)
2. GitHub Issues tab
3. Run `npx tsc --noEmit` locally - should show no errors

### Quick Debug Commands:
```bash
# Test locally before deploying
npm run build
node dist/api/index.js

# Check for TypeScript errors
npx tsc --noEmit

# Check for lint errors
npm run lint
```

---

## 🎉 Done!

Your GLM Ledger should now be live on Vercel! 🚀
