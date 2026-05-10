const { execSync } = require('child_process');

const envs = {
  NEXT_PUBLIC_API_URL: 'https://braj-quantum-ledger-v2.vercel.app/api/v1',
  NEXT_PUBLIC_APP_NAME: 'Braj Quantum Ledger',
  NEXT_PUBLIC_APP_URL: 'https://braj-quantum-ledger-v2-ui.vercel.app'
};

try {
  execSync('npx vercel link --project braj-quantum-ledger-v2-ui --yes', { stdio: 'inherit' });
} catch (e) {
  console.error("Link failed:", e.message);
}

for (const [key, value] of Object.entries(envs)) {
  console.log(`Setting ${key}...`);
  try {
    execSync(`npx vercel env rm ${key} production -y`, { stdio: 'ignore' });
  } catch (e) {} 
  try {
    execSync(`npx vercel env add ${key} production`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (e) {
    console.error(`Failed to set ${key}:`, e.message);
  }
}
