'use strict';

/** Unités acceptées (« min » avant « m » : l'ordre de l'expression régulière compte). */
const UNITS = { sem: 604_800, w: 604_800, j: 86_400, d: 86_400, h: 3_600, min: 60, m: 60 };

/**
 * « 30m », « 2h », « 1d12h », « 1sem », « 90 » (minutes) → secondes. Renvoie null si le texte n'est pas une durée
 * valide. Partagé par toutes les commandes à durée (ban temporaire, /lock, accès temporaires, rollback…).
 */
function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60;
  const pattern = /(\d+)(sem|min|w|j|d|h|m)/g;
  let total = 0;
  let consumed = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    total += Number(match[1]) * UNITS[match[2]];
    consumed += match[0].length;
  }
  return consumed === text.length && total > 0 ? total : null;
}

/** « 1 j 4 h », « 45 min »… */
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  const hours = Math.floor(s / 3600);
  if (hours < 48) {
    const minutes = Math.floor((s % 3600) / 60);
    return minutes ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} j ${hours % 24} h` : `${days} j`;
}

module.exports = { parseDuration, formatDuration };
