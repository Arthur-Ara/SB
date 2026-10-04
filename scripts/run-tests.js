'use strict';

// Lance les tests automatiques (test/*.test.js) avec le lanceur intégré de Node (node:test), sans dépendance.
// Les fichiers sont passés explicitement : même comportement de Node 18 à Node 22.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(dir, name));

if (!files.length) {
  console.log('Aucun test trouvé.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
