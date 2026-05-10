@echo off
REM ============================================================================
REM Vercel Deployment Check Script (Windows)
REM Run this before pushing to GitHub/deploying to Vercel
REM Usage: .\scripts\vercel-check.bat
REM ============================================================================

echo ==========================================
echo GLM LEDGER - VERCEL DEPLOYMENT CHECK
echo Windows Version
echo ==========================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
  echo ❌ node_modules not found. Run: npm install
  exit /b 1
)

REM Check TypeScript compilation
echo Checking TypeScript compilation...
npx tsc --noEmit 2>&1
if %errorlevel% neq 0 (
  echo ❌ TypeScript compilation failed! Fix errors above.
  exit /b 1
)
echo ✅ TypeScript compiles successfully

REM Check for package.json
echo.
echo Checking package.json...
if not exist "package.json" (
  echo ❌ package.json not found!
  exit /b 1
)
echo ✅ package.json exists

echo.
echo ==========================================
echo 🎉 Basic checks passed!
echo.
echo IMPORTANT: Before deploying to Vercel, make sure you have set these environment variables:
echo.
echo Required:
echo - DATABASE_URL      (Your NeonDB connection string)
echo - JWT_SECRET        (64 character random string)
echo.
echo Recommended:
echo - REDIS_URL         (Optional, falls back to in-memory)
echo - CORS_ORIGIN       (Your frontend URL, or * for any)
echo - API_VERSION       (1.0.0)
echo.
echo To add these:
echo 1. Go to vercel.com and open your project
echo 2. Go to Settings ^> Environment Variables
echo 3. Add each variable
echo 4. Re-deploy the project
echo ==========================================
