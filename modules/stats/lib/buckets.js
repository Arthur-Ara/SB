'use strict';

/**
 * Découpage temporel des graphiques.
 *
 * Les dates sont stockées en UTC ; l'affichage se fait dans le fuseau du navigateur,
 * transmis sous forme de décalage en minutes (ex : +120 pour UTC+2). MySQL et le code
 * JS calculent les mêmes clés de regroupement (« 2026-09-28 », « 2026-09-28 14:00 »…),
 * ce qui permet de compléter les intervalles vides par des zéros.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ORDER = ['minute', 'hour', 'day', 'week', 'month'];
const APPROX_MS = { minute: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY };
const MAX_BUCKETS = 1000;

function sanitizeOffset(offset) {
  const value = Number.parseInt(offset, 10);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-840, Math.min(840, value));
}

function autoInterval(from, to) {
  const span = to.getTime() - from.getTime();
  if (span <= 6 * HOUR) return 'minute';
  if (span <= 3 * DAY) return 'hour';
  if (span <= 120 * DAY) return 'day';
  if (span <= 2 * 365 * DAY) return 'week';
  return 'month';
}

/** Intervalle effectif : celui demandé, élargi si le nombre de points devient déraisonnable. */
function resolveInterval(requested, from, to) {
  let interval = ORDER.includes(requested) ? requested : autoInterval(from, to);
  const span = to.getTime() - from.getTime();
  while (interval !== 'month' && span / APPROX_MS[interval] > MAX_BUCKETS) {
    interval = ORDER[ORDER.indexOf(interval) + 1];
  }
  return interval;
}

/** Expression SQL de la clé de regroupement (la colonne est une constante interne, jamais une saisie). */
function bucketSql(column, interval, offset) {
  const local = `DATE_ADD(${column}, INTERVAL ${sanitizeOffset(offset)} MINUTE)`;
  switch (interval) {
    case 'minute':
      return `DATE_FORMAT(${local}, '%Y-%m-%d %H:%i')`;
    case 'hour':
      return `DATE_FORMAT(${local}, '%Y-%m-%d %H:00')`;
    case 'day':
      return `DATE_FORMAT(${local}, '%Y-%m-%d')`;
    case 'week':
      return `DATE_FORMAT(DATE_SUB(DATE(${local}), INTERVAL WEEKDAY(${local}) DAY), '%Y-%m-%d')`;
    case 'month':
      return `DATE_FORMAT(${local}, '%Y-%m')`;
    default:
      throw new Error(`Intervalle inconnu : ${interval}`);
  }
}

const pad = (value) => String(value).padStart(2, '0');

function formatKey(date, interval) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  if (interval === 'minute') return `${y}-${m}-${d} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (interval === 'hour') return `${y}-${m}-${d} ${pad(date.getUTCHours())}:00`;
  if (interval === 'month') return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

function floorLocal(date, interval) {
  const d = new Date(date.getTime());
  if (interval === 'minute') {
    d.setUTCSeconds(0, 0);
    return d;
  }
  if (interval === 'hour') {
    d.setUTCMinutes(0, 0, 0);
    return d;
  }
  d.setUTCHours(0, 0, 0, 0);
  if (interval === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (interval === 'month') d.setUTCDate(1);
  return d;
}

function advance(date, interval) {
  const d = new Date(date.getTime());
  if (interval === 'minute') d.setUTCMinutes(d.getUTCMinutes() + 1);
  else if (interval === 'hour') d.setUTCHours(d.getUTCHours() + 1);
  else if (interval === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * Liste des intervalles couvrant [from, to[ :
 * keys (clés SQL), starts/ends (instants UTC en ms), index (clé → position).
 */
function buildBuckets(from, to, interval, offset) {
  const shift = sanitizeOffset(offset) * 60_000;
  const endLocal = to.getTime() + shift;
  let cursor = floorLocal(new Date(from.getTime() + shift), interval);
  const keys = [];
  const starts = [];
  const ends = [];
  while (cursor.getTime() < endLocal) {
    const next = advance(cursor, interval);
    keys.push(formatKey(cursor, interval));
    starts.push(cursor.getTime() - shift);
    ends.push(next.getTime() - shift);
    cursor = next;
  }
  return { interval, keys, starts, ends, index: new Map(keys.map((key, i) => [key, i])) };
}

/** Position de l'intervalle contenant l'instant t (recherche dichotomique). */
function bucketIndexAt(buckets, t) {
  let lo = 0;
  let hi = buckets.starts.length - 1;
  if (hi < 0 || t < buckets.starts[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets.starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Série complète (une valeur par intervalle) à partir de lignes SQL { k, <champ> }. */
function fill(buckets, rows, field, { empty = 0, transform = Number } = {}) {
  const values = new Array(buckets.keys.length).fill(empty);
  for (const row of rows) {
    const i = buckets.index.get(row.k);
    if (i === undefined) continue;
    const raw = typeof field === 'function' ? field(row) : row[field];
    values[i] = raw === null || raw === undefined ? empty : transform(raw);
  }
  return values;
}

module.exports = { sanitizeOffset, resolveInterval, bucketSql, buildBuckets, bucketIndexAt, fill, MAX_BUCKETS };
