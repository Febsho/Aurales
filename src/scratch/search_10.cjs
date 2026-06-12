const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      results.push(file);
    }
  });
  return results;
}

const files = walk('c:/Users/justi/Documents/Dev/Orynt/orynt-app/src');
files.forEach(file => {
  if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.css')) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('/10') && !line.includes('bg-') && !line.includes('border-') && !line.includes('text-') && !line.includes('hover:')) {
        console.log(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
});
