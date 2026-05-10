import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function walk(dir) {
  let results = [];
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
  
  const newContent = content.replace(importRegex, (match, type, members, path) => {
    // If it already has an extension or is a known non-JS file, skip
    if (path.endsWith('.js') || path.endsWith('.json') || path.endsWith('.css') || path.endsWith('.yaml')) {
      return match;
    }
    changed = true;
    return `${type} ${members} from "${path}.js"`;
  });
  
  if (changed) {
    writeFileSync(file, newContent);
    console.log(`Updated ${file}`);
  }
});
