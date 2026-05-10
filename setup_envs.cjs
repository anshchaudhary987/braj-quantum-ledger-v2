const { execSync } = require('child_process');

const envs = {
  NODE_ENV: 'production',
  PORT: '3000',
  API_VERSION: '1.0.0',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'glm_ledger',
  DB_USER: 'glm_app',
  DB_PASSWORD: 'your_secure_password_here',
  DB_SSL: 'true',
  DB_POOL_MAX: '20',
  DB_POOL_IDLE_MS: '30000',
  JWT_SECRET: 'af83e74b931920cd7d6f5a34e06bc781',
  ENCRYPTION_MASTER_KEY: 'c19da218b74e892ef6d35c1840e4f321',
  CORS_ORIGIN: '*',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  REDIS_URL: 'redis://localhost:6379'
};

// First link the project
try {
  execSync('npx vercel link --project braj-quantum-ledger-v2 --yes', { stdio: 'inherit' });
} catch (e) {
  console.error("Link failed:", e.message);
}

for (const [key, value] of Object.entries(envs)) {
  console.log(`Setting ${key}...`);
  try {
    execSync(`npx vercel env rm ${key} production -y`, { stdio: 'ignore' });
  } catch (e) {} // ignore if not exists
  
  try {
    execSync(`npx vercel env add ${key} production`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (e) {
    console.error(`Failed to set ${key}:`, e.message);
  }
}
