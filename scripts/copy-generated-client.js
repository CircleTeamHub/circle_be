const fs = require('fs');
const path = require('path');

const root = process.cwd();
const source = path.join(root, 'src', 'generated');
const target = path.join(root, 'dist', 'src', 'generated');

if (!fs.existsSync(source)) {
  throw new Error(`Generated Prisma client not found at ${source}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

console.log(`Copied generated client to ${target}`);
