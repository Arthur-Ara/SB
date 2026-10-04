'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Liste (triée) des fichiers .js directement contenus dans un dossier. */
function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Charge un fichier en ignorant le cache de require (rechargement à chaud). */
function freshRequire(file) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return require(resolved);
}

function forget(file) {
  try {
    delete require.cache[require.resolve(file)];
  } catch {
    // fichier supprimé entre-temps : rien à oublier
  }
}

module.exports = { listJsFiles, freshRequire, forget };
