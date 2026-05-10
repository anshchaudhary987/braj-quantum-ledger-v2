// Build size analyzer script
const fs = require('fs');
const path = require('path');

const ANALYZE_PATHS = [
  '.next/static/chunks',
  '.next/static/media',
  '.next/server',
];

function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function analyzeDirectory(dirPath) {
  let totalSize = 0;
  const files = [];

  try {
    const items = fs.readdirSync(dirPath);
    items.forEach(item => {
      const fullPath = path.join(dirPath, item);
      const stats = fs.statSync(fullPath);
      
      if (stats.isFile()) {
        const size = stats.size;
        totalSize += size;
        files.push({
          name: item,
          size,
          formattedSize: formatSize(size),
        });
      }
    });
  } catch (error) {
    console.log(`Directory not found: ${dirPath}`);
    return { totalSize: 0, files: [] };
  }

  return { totalSize, files };
}

function analyzeBuild() {
  console.log('=' * 60);
  console.log('GLM LEDGER BUILD ANALYSIS');
  console.log('=' * 60);
  console.log();

  let grandTotal = 0;

  ANALYZE_PATHS.forEach(dir => {
    const fullPath = path.join(process.cwd(), dir);
    const { totalSize, files } = analyzeDirectory(fullPath);
    
    if (totalSize > 0) {
      console.log(`\n📁 ${dir}`);
      console.log(`   Total: ${formatSize(totalSize)}`);
      console.log('   Files:');
      
      files.sort((a, b) => b.size - a.size).forEach(file => {
        const bar = '█'.repeat(Math.ceil(file.size / totalSize * 30));
        console.log(`      ${file.name.padEnd(50)} ${file.formattedSize.padStart(10)} ${bar}`);
      });
      
      grandTotal += totalSize;
    }
  });

  console.log(`\n${'=' * 60}`);
  console.log(`GRAND TOTAL: ${formatSize(grandTotal)}`);
  console.log('=' * 60);

  // Recommendations
  console.log('\n📊 PERFORMANCE RECOMMENDATIONS:');
  console.log('1. Use next/image for all images (configured)');
  console.log('2. Lazy load heavy componentsThree.js, charts (configured)');
  console.log('3. Code splitting with dynamic imports (configured)');
  console.log('4. CSS optimization enabled (configured)');
  console.log('5. Console logs removed in production (configured)');
  console.log('6. Cache headers for static assets (configured)');
}

// Run analysis
analyzeBuild();
