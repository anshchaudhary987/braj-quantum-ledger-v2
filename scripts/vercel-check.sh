#!/bin/bash
# =============================================================================
# Vercel Deployment Check Script
# Run this before pushing to GitHub/deploying to Vercel
# Usage: bash vercel-check.sh
# =============================================================================

echo "=========================================="
echo "GLM LEDGER - VERCEL DEPLOYMENT CHECK"
echo "=========================================="
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "❌ node_modules not found. Run: npm install"
  exit 1
fi

# Check TypeScript compilation
echo "Checking TypeScript compilation..."
npx tsc --noEmit 2>&1
if [ $? -eq 0 ]; then
  echo "✅ TypeScript compiles successfully"
else
  echo "❌ TypeScript compilation failed! Fix errors above."
  exit 1
fi

# Check for required env vars
echo ""
echo "Checking required environment variables..."

REQUIRED_VARS=("DATABASE_URL" "JWT_SECRET")
MISSING=0

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "⚠️  $var is not set (required for production)"
    MISSING=$((MISSING + 1))
  else
    echo "✅ $var is set"
  fi
done

# Optional vars
OPTIONAL_VARS=("REDIS_URL" "CORS_ORIGIN" "API_VERSION")
for var in "${OPTIONAL_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "ℹ️  $var is not set (optional, but recommended)"
  else
    echo "✅ $var is set"
  fi
done

# Summary
echo ""
echo "=========================================="
if [ $MISSING -gt 0 ]; then
  echo "⚠️  $MISSING required environment variables missing!"
  echo "Set them in Vercel dashboard before deploying."
else
  echo "🎉 All checks passed! Ready to deploy."
fi
echo "=========================================="
