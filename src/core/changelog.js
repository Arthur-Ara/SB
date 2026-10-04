'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Journal des versions (changelog.json à la racine du projet) : source unique de l'onglet « Changelog » du
 * panel web et de la commande /changelog. À compléter à CHAQUE mise à jour du bot (nouvelle entrée en tête).
 *
 * Format : [{ version, date (AAAA-MM-JJ), title, changes: [{ type, module, text }] }], plus récente d'abord.
 * Le fichier est relu dès qu'il change (pas besoin de redémarrer le bot pour publier une nouvelle entrée).
 */
const FILE = path.join(__dirname, '..', '..', 'changelog.json');

/** Catégories de modifications, dans l'ordre d'affichage. */
const TYPES = {
  feature: { emoji: '✨', label: 'Nouveautés' },
  security: { emoji: '🔒', label: 'Sécurité' },
  fix: { emoji: '🐛', label: 'Corrections' },
  perf: { emoji: '⚡', label: 'Performances' },
  style: { emoji: '🎨', label: 'Interface' },
  change: { emoji: '🔧', label: 'Changements' },
};

let cache = { mtimeMs: -1, entries: [] };

function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry.version === 'string')
    .map((entry) => ({
      version: entry.version.trim(),
      date: entry.date ?? null,
      title: entry.title ?? '',
      changes: (Array.isArray(entry.changes) ? entry.changes : [])
        .filter((change) => change && typeof change.text === 'string')
        .map((change) => ({ type: TYPES[change.type] ? change.type : 'change', module: change.module ?? 'core', text: change.text.trim() })),
    }));
}

/** Toutes les versions, la plus récente d'abord (tableau vide si le fichier est absent ou invalide). */
function loadChangelog() {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (mtimeMs !== cache.mtimeMs) cache = { mtimeMs, entries: normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))) };
  } catch {
    cache = { mtimeMs: -1, entries: [] };
  }
  return cache.entries;
}

/** Une version précise, ou la plus récente pour « latest » / vide. */
function findVersion(version) {
  const entries = loadChangelog();
  const wanted = String(version ?? '').trim().replace(/^v/i, '').toLowerCase();
  if (!wanted || wanted === 'latest') return entries[0] ?? null;
  return entries.find((entry) => entry.version.toLowerCase() === wanted) ?? null;
}

/** Modifications d'une version regroupées par catégorie, dans l'ordre de TYPES : [{ type, emoji, label, changes }]. */
function groupByType(entry) {
  return Object.entries(TYPES)
    .map(([type, meta]) => ({ type, ...meta, changes: entry.changes.filter((change) => change.type === type) }))
    .filter((group) => group.changes.length);
}

module.exports = { TYPES, loadChangelog, findVersion, groupByType };
