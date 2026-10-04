'use strict';

// Vérifie la syntaxe de tous les fichiers JavaScript du projet (node --check).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targets = ['src', 'modules', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

for (const target of targets) {
  const dir = path.join(root, target);
  if (fs.existsSync(dir)) walk(dir);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✗ ${path.relative(root, file)}\n${err.stderr?.toString() ?? err.message}`);
  }
}

console.log(`${files.length - failed}/${files.length} fichier(s) valides.`);
process.exit(failed ? 1 : 0);
