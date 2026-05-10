import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';

function walk(dir) {
  let results = [];
  if (!existsSync(dir)) return [];
  const list = readdirSync(dir);
  list.forEach(file => {
    file = join(dir, file);
    const stat = statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else if (extname(file) === '.ts' || extname(file) === '.js') {
      results.push(file);
    }
  });
  return results;
}

const files = [...walk('src'), ...walk('api')];

const importRegex = /(import|export)\s+([\s\S]*?)\s+from\s+['"](\..*?)['"]/g;

files.forEach(file => {
  let content = readFileSync(file, 'utf8');
  let changed = false;
  const fileDir = dirname(file);
  
  const newContent = content.replace(importRegex, (match, type, members, importPath) => {
    // If it ends with .js, maybe it should be /index.js
    let cleanPath = importPath;
    if (importPath.endsWith('.js')) {
        cleanPath = importPath.slice(0, -3);
    }

    // Known non-JS files
    if (importPath.endsWith('.json') || importPath.endsWith('.css') || importPath.endsWith('.yaml')) {
      return match;
    }
    
    // Check if cleanPath is a directory
    const fullPath = join(fileDir, cleanPath);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      changed = true;
      return `${type} ${members} from "${cleanPath}/index.js"`;
    }

    // Otherwise, ensure it ends with .js
    if (!importPath.endsWith('.js')) {
        changed = true;
        return `${type} ${members} from "${importPath}.js"`;
    }

    return match;
  });
  
  if (changed) {
    writeFileSync(file, newContent);
    console.log(`Updated ${file}`);
  }
});
