# 🚀 Vercel Account Setup & Link

## Step 1: Install Vercel CLI (Optional but Recommended)

### On Mac/Linux:
```bash
npm i -g vercel
```

### On Windows:
```bash
npm install -g vercel
```

## Step 2: Login to Vercel

```bash
vercel login
```

This opens your browser. Login with your GitHub account (recommended).

## Step 3: Link Your Project

Navigate to your project folder:

```bash
cd "C:\Users\aansh\OneDrive\Documents\glm 5.11"
```

Link to Vercel:
```bash
vercel link
```

When it asks:
- "Set up project?" → **Y** (Yes)
- "What's your project name?" → `glm-ledger` (or whatever you want)

## Step 4: Set Environment Variables

```bash
# Replace these with YOUR actual values!

vercel env add DATABASE_URL
# Enter: postgresql://your-user:your-password@your-host.neon.tech/glm_ledger?sslmode=require

vercel env add JWT_SECRET
# Enter: your-64-char-jwt-secret-from-step-3

vercel env add REDIS_URL
# Enter: rediss://default:your-password@your-host.upstash.io:6379 (or leave empty)

vercel env add CORS_ORIGIN
# Enter: * (for testing, or your frontend URL for production)

vercel env add NODE_ENV
# Enter: production
```

## Step 5: Deploy

```bash
vercel --prod
```

Wait for the build to complete (2-3 minutes).

## Step 6: Check Deployment

```bash
# Get your deployment URL
vercel --version

# Open your deployed app
vercel --open
```

---

## 🎥 Video Tutorial Links

If you're confused, watch these:

1. **Vercel + GitHub Basics:** https://www.youtube.com/watch?v=2I5512P1Ki8
2. **Deploying Node.js to Vercel:** https://www.youtube.com/vercel
3. **Neon + Vercel Setup:** https://neon.tech/docs/guides/vercel

---

## 🐛 Common CLI Errors

### "vercel: command not found"
```bash
# Windows (PowerShell - Run as Admin)
npm install -g vercel

# Mac/Linux
sudo npm install -g vercel
```

### "Authentication failed"
```bash
vercel logout
vercel login
```

### "Project not linked"
```bash
vercel link
```

### "Build failed"
```bash
# Check TypeScript first
npx tsc --noEmit

# Check for missing env vars
vercel env ls
```

---

## 📱 Alternative: Deploy from GitHub (No CLI needed!)

1. Go to https://github.com/YOUR-USERNAME/glm-ledger
2. GitHub se Vercel ki taraf jaao:
   - Ya Vercel website pe jaake "Import Git Repository" karo
   - Ya git push karke Vercel auto-detect karega

3. Bas "Deploy" button click karo

Ye CLI ke bina bhi kaam kar sakte ho, sirf website pe jake!
