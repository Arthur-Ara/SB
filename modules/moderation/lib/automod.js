'use strict';

/**
 * Automod « mots interdits » : détection tolérante aux contournements faciles (accents, majuscules,
 * leet speak « c0nn@rd », lettres répétées « connnnard », lettres espacées « c o n », séparateurs
 * « co.nn-ard ») grâce à une normalisation commune puis à une similarité de Levenshtein.
 * Le score (en %) est comparé au seuil réglé sur le panel ; les mots marqués comme faux positifs
 * (table moderation_automod_allow) ne déclenchent jamais rien.
 */

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '€': 'e' };
const MAX_TOKENS = 200;
const MIN_FUZZY_LENGTH = 4; // en dessous, seule la correspondance exacte compte (trop de faux positifs sinon)
const MIN_CONTAINED_LENGTH = 5; // « xxconnardxx » : mot interdit contenu dans un mot plus long
const CONTAINED_SCORE = 95;

/** Minuscules, sans accents ni caractères invisibles, leet speak converti, lettres répétées réduites. */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[0134578@$€]/g, (c) => LEET[c])
    .replace(/(?<=\p{L})[!|](?=\p{L})/gu, 'i')
    .replace(/(\p{L})\1+/gu, '$1');
}

/** Un mot de la liste, tel qu'il est comparé : normalisé, lettres uniquement. */
function normalizeWord(word) {
  return normalize(word).replace(/[^\p{L}]/gu, '');
}

/**
 * Mots candidats d'un message : chaque mot (séparateurs internes retirés : « co.nn-ard » → « connard »)
 * et chaque suite de lettres isolées recollées (« c o n n a r d » → « connard »).
 */
function tokenize(content) {
  const tokens = new Set();
  let run = '';
  for (const raw of normalize(content).split(/\s+/)) {
    const token = raw.replace(/[^\p{L}]/gu, '');
    if (token.length === 1) {
      run += token;
      continue;
    }
    if (run.length > 1) tokens.add(run.replace(/(\p{L})\1+/gu, '$1'));
    run = '';
    if (token) tokens.add(token.replace(/(\p{L})\1+/gu, '$1'));
    if (tokens.size >= MAX_TOKENS) break;
  }
  if (run.length > 1) tokens.add(run.replace(/(\p{L})\1+/gu, '$1'));
  return [...tokens];
}

/** Distance d'édition (insertion, suppression, substitution), sur deux lignes seulement. */
function levenshtein(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Similarité (0-100) entre un mot du message et un mot interdit, tous deux normalisés. */
function similarity(token, word) {
  if (token === word) return 100;
  if (word.length >= MIN_CONTAINED_LENGTH && token.includes(word)) return CONTAINED_SCORE;
  if (word.length < MIN_FUZZY_LENGTH || Math.abs(token.length - word.length) > 2) return 0;
  return Math.round((1 - levenshtein(token, word) / Math.max(token.length, word.length)) * 100);
}

// Mots normalisés, recalculés uniquement quand la liste du serveur change (le service renvoie
// le même objet tant que son cache n'est pas invalidé).
const prepared = new WeakMap();

function preparedWords(lists) {
  let words = prepared.get(lists);
  if (!words) {
    words = lists.words.map((row) => ({ word: row.word, normalized: normalizeWord(row.word) })).filter((w) => w.normalized);
    prepared.set(lists, words);
  }
  return words;
}

/**
 * Meilleure correspondance d'un message avec la liste du serveur, ou null sous le seuil.
 * @param {{ words: Array<{ word: string }>, allowSet: Set<string> }} lists  voir ModerationService#automodLists
 * @returns {{ word: string, token: string, score: number } | null}
 */
function scan(content, lists, threshold) {
  const words = preparedWords(lists);
  if (!words.length || !content) return null;
  let best = null;
  for (const token of tokenize(content)) {
    if (lists.allowSet.has(token)) continue;
    for (const { word, normalized } of words) {
      const score = similarity(token, normalized);
      if (score >= threshold && (!best || score > best.score)) {
        best = { word, token, score };
        if (score === 100) return best;
      }
    }
  }
  return best;
}

module.exports = { normalize, normalizeWord, tokenize, levenshtein, similarity, scan };
