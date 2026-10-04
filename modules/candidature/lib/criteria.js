'use strict';

/**
 * Contrôle automatique des critères d'une catégorie, exécuté quand le candidat déclare sa candidature terminée.
 * Fonctions pures (aucun accès Discord ni base) : le texte, les compteurs et les dates sont fournis par l'appelant.
 *
 * Critères (tous facultatifs, 0 / vide = non contrôlé) :
 *  - minChars / maxChars : longueur totale du texte du candidat (réponses du formulaire + messages écrits dans son salon) ;
 *  - minMessages / minAttachments : nombre de messages / de pièces jointes (captures, CV…) envoyés dans le salon ;
 *  - requiredKeywords : mots ou expressions qui doivent apparaître (sans tenir compte des accents ni de la casse) ;
 *  - forbiddenWords : mots interdits (mot entier) ;
 *  - minAccountAgeDays / minMemberDays : ancienneté du compte Discord / sur le serveur ;
 *  - requiredRoleIds / forbiddenRoleIds : rôles que le candidat doit avoir / ne doit pas avoir ;
 *  - sections : parties attendues dans les messages (« Présentation : … »), chacune avec un nombre de caractères
 *    minimum / maximum et obligatoire ou non. Le candidat écrit le nom de la partie en début de ligne (titre Markdown,
 *    gras, puce ou simple « Nom : » acceptés) ; le texte qui suit, jusqu'à la partie suivante, lui est attribué ;
 *  - par question du formulaire : minLength / maxLength (voir form.js), contrôlés aussi ici.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIST = 50;
const MAX_SECTIONS = 20;

function count(value, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function textList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/);
  return [...new Set(list.map((item) => String(item).trim().slice(0, 100)).filter(Boolean))].slice(0, MAX_LIST);
}

function idList(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter((id) => /^\d{17,20}$/.test(id)))].slice(0, MAX_LIST) : [];
}

/** Parties attendues : [{ name, minChars, maxChars, required }] (noms uniques, sans tenir compte de la casse). */
function sectionList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const sections = [];
  for (const raw of value) {
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || seen.has(fold(name))) continue;
    seen.add(fold(name));
    const maxChars = count(raw?.maxChars, 20000);
    sections.push({ name, minChars: Math.min(count(raw?.minChars, 20000), maxChars || 20000), maxChars, required: raw?.required !== false });
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

/** Critères saisis (panel web ou base) → objet propre, bornes appliquées. */
function normalizeCriteria(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    minChars: count(source.minChars, 100000),
    maxChars: count(source.maxChars, 100000),
    minMessages: count(source.minMessages, 1000),
    minAttachments: count(source.minAttachments, 100),
    minAccountAgeDays: count(source.minAccountAgeDays, 36500),
    minMemberDays: count(source.minMemberDays, 36500),
    requiredKeywords: textList(source.requiredKeywords),
    forbiddenWords: textList(source.forbiddenWords),
    requiredRoleIds: idList(source.requiredRoleIds),
    forbiddenRoleIds: idList(source.forbiddenRoleIds),
    sections: sectionList(source.sections),
  };
}

/** Au moins un critère est-il défini ? (sinon le contrôle automatique n'a rien à vérifier) */
function hasCriteria(criteria, questions = []) {
  const c = normalizeCriteria(criteria);
  const numeric = c.minChars || c.maxChars || c.minMessages || c.minAttachments || c.minAccountAgeDays || c.minMemberDays;
  const lists = c.requiredKeywords.length || c.forbiddenWords.length || c.requiredRoleIds.length || c.forbiddenRoleIds.length || c.sections.length;
  return Boolean(numeric || lists || questions.some((q) => q.minLength || q.maxLength));
}

/** Minuscules sans accents, pour comparer des mots. */
function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function length(text) {
  return [...String(text ?? '').trim()].length;
}

function plural(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

/** Marques de début de ligne ignorées avant un nom de partie : titres, citations, puces, numéros, gras/italique. */
const LINE_PREFIX = /^[\s#>*_~`|•·\-–—]*(?:\d{1,2}[.)]\s*)?[\s*_~`]*/;

/**
 * Découpe le texte du candidat en parties : une ligne qui commence par le nom d'une partie (« **Présentation** : »,
 * « ## Motivations », « - Disponibilités - … ») ouvre cette partie ; tout ce qui suit lui revient jusqu'à la suivante.
 * @returns {Map<string, string>} nom de la partie (tel que configuré) → texte (vide si la partie n'est qu'un titre)
 */
function splitSections(text, sections) {
  const found = new Map();
  if (!sections.length) return found;
  // Les noms les plus longs d'abord : « Expérience staff » n'est pas pris pour « Expérience ».
  const names = sections.map((s) => ({ name: s.name, folded: fold(s.name) })).sort((a, b) => b.folded.length - a.folded.length);
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const prefix = LINE_PREFIX.exec(line)[0];
    const stripped = line.slice(prefix.length);
    const folded = fold(stripped);
    // Un titre : nom suivi de « : », d'un tiret ou de rien, ou ligne mise en titre (« ## », « ** ») — une phrase
    // ordinaire qui commence par le même mot (« Motivation est ce qui… ») n'ouvre pas de partie.
    const titled = /#|\*\*|__/.test(prefix);
    const header = names.find((n) => folded.startsWith(n.folded) && (titled ? !/[a-z0-9]/.test(folded.charAt(n.folded.length)) : /^\s*[*_~`]*\s*([:：\-–—=>|]|$)/.test(folded.slice(n.folded.length))));
    if (header) {
      current = header.name;
      // Texte écrit sur la même ligne que le titre (« Âge : 19 ans ») : il compte pour la partie.
      const rest = [...stripped].slice([...header.name].length).join('').replace(/^[\s*_~`:：\-–—=>|]+/, '');
      found.set(current, [found.get(current), rest].filter(Boolean).join('\n'));
    } else if (current !== null) {
      found.set(current, [found.get(current), line].filter((part) => part !== undefined && part !== '').join('\n'));
    }
  }
  return found;
}

/**
 * Rappel lisible des critères (affiché dans le message d'ouverture quand le contrôle automatique est actif), pour que
 * le candidat sache exactement ce qui sera vérifié. Les critères de profil (ancienneté, rôles) sont inclus.
 */
function criteriaSummary(criteria, questions = []) {
  const c = normalizeCriteria(criteria);
  const lines = [];
  if (c.sections.length) {
    lines.push('**Parties attendues** (écris le nom de la partie en début de ligne, ex. `Présentation : …`) :');
    for (const section of c.sections) {
      const bounds = [section.minChars ? `${section.minChars} car. min` : null, section.maxChars ? `${section.maxChars} car. max` : null].filter(Boolean).join(', ');
      lines.push(`• **${section.name}**${section.required ? '' : ' (facultative)'}${bounds ? ` — ${bounds}` : ''}`);
    }
  }
  if (c.minChars || c.maxChars) lines.push(`• Longueur totale : ${[c.minChars ? `${c.minChars} caractères min` : null, c.maxChars ? `${c.maxChars} max` : null].filter(Boolean).join(', ')}`);
  if (c.minMessages) lines.push(`• Au moins ${plural(c.minMessages, 'message')}`);
  if (c.minAttachments) lines.push(`• Au moins ${c.minAttachments} pièce(s) jointe(s) (captures, CV…)`);
  if (c.requiredKeywords.length) lines.push(`• Doit mentionner : ${c.requiredKeywords.map((w) => `« ${w} »`).join(', ')}`);
  if (c.forbiddenWords.length) lines.push(`• Termes interdits : ${c.forbiddenWords.length}`);
  if (c.minAccountAgeDays) lines.push(`• Compte Discord de plus de ${c.minAccountAgeDays} jour(s)`);
  if (c.minMemberDays) lines.push(`• Membre du serveur depuis plus de ${c.minMemberDays} jour(s)`);
  if (c.requiredRoleIds.length) lines.push(`• Rôle(s) requis : ${c.requiredRoleIds.map((id) => `<@&${id}>`).join(', ')}`);
  for (const q of questions) {
    if (q.minLength || q.maxLength) lines.push(`• Formulaire « ${q.label} » : ${[q.minLength ? `${q.minLength} car. min` : null, q.maxLength ? `${q.maxLength} max` : null].filter(Boolean).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * @param {object} input
 * @param {object} input.criteria   critères de la catégorie
 * @param {Array}  input.questions  questions du formulaire (minLength / maxLength facultatifs)
 * @param {Array}  input.answers    [{ question, answer }] réponses au formulaire
 * @param {string[]} input.messages textes des messages du candidat dans son salon
 * @param {number} input.attachments nombre de pièces jointes envoyées par le candidat
 * @param {number} [input.accountCreatedAt] timestamp de création du compte Discord
 * @param {number} [input.joinedAt]  timestamp d'arrivée sur le serveur
 * @param {string[]} [input.roleIds] rôles actuels du candidat
 * @param {number} [input.now]
 * @returns {{ ok: boolean, failures: string[], stats: { chars: number, messages: number, attachments: number } }}
 */
function checkCriteria({ criteria, questions = [], answers = [], messages = [], attachments = 0, accountCreatedAt = null, joinedAt = null, roleIds = [], now = Date.now() }) {
  const c = normalizeCriteria(criteria);
  const failures = [];
  const texts = [...answers.map((entry) => entry.answer), ...messages];
  const chars = texts.reduce((total, text) => total + length(text), 0);
  const stats = { chars, messages: messages.length, attachments };

  if (c.minChars && chars < c.minChars) failures.push(`Candidature trop courte : ${plural(chars, 'caractère')} au lieu de ${c.minChars} minimum.`);
  if (c.maxChars && chars > c.maxChars) failures.push(`Candidature trop longue : ${plural(chars, 'caractère')} pour ${c.maxChars} maximum.`);
  if (c.minMessages && messages.length < c.minMessages) failures.push(`Pas assez de messages : ${messages.length} au lieu de ${c.minMessages} minimum.`);
  if (c.minAttachments && attachments < c.minAttachments) failures.push(`Pièces jointes manquantes : ${attachments} envoyée(s) sur ${c.minAttachments} demandée(s).`);

  questions.forEach((question) => {
    const entry = answers.find((a) => a.question === question.label);
    const size = length(entry?.answer);
    if (question.minLength && size < question.minLength) failures.push(`« ${question.label} » : ${plural(size, 'caractère')} au lieu de ${question.minLength} minimum.`);
    if (question.maxLength && size > question.maxLength) failures.push(`« ${question.label} » : ${plural(size, 'caractère')} pour ${question.maxLength} maximum.`);
  });

  const haystack = fold(texts.join('\n'));
  const missing = c.requiredKeywords.filter((word) => !haystack.includes(fold(word)));
  if (missing.length) failures.push(`Éléments attendus absents : ${missing.map((w) => `« ${w} »`).join(', ')}.`);
  const forbidden = c.forbiddenWords.filter((word) => new RegExp(`(^|[^a-z0-9])${escapeRegex(fold(word))}($|[^a-z0-9])`).test(haystack));
  if (forbidden.length) failures.push(`Termes interdits utilisés : ${forbidden.map((w) => `« ${w} »`).join(', ')}.`);

  const parts = splitSections(messages.join('\n'), c.sections);
  for (const section of c.sections) {
    if (!parts.has(section.name)) {
      if (section.required) failures.push(`Partie « ${section.name} » absente (écris « ${section.name} : » en début de ligne).`);
      continue;
    }
    const size = length(parts.get(section.name));
    if (section.minChars && size < section.minChars) failures.push(`Partie « ${section.name} » trop courte : ${plural(size, 'caractère')} au lieu de ${section.minChars} minimum.`);
    if (section.maxChars && size > section.maxChars) failures.push(`Partie « ${section.name} » trop longue : ${plural(size, 'caractère')} pour ${section.maxChars} maximum.`);
  }

  if (c.minAccountAgeDays && accountCreatedAt && now - accountCreatedAt < c.minAccountAgeDays * DAY_MS) {
    failures.push(`Compte Discord trop récent : ${c.minAccountAgeDays} jour(s) d’ancienneté minimum.`);
  }
  if (c.minMemberDays && joinedAt && now - joinedAt < c.minMemberDays * DAY_MS) {
    failures.push(`Ancienneté sur le serveur insuffisante : ${c.minMemberDays} jour(s) minimum.`);
  }
  const owned = new Set(roleIds.map(String));
  if (c.requiredRoleIds.some((id) => !owned.has(id))) failures.push('Rôle(s) requis manquant(s) : ' + c.requiredRoleIds.filter((id) => !owned.has(id)).map((id) => `<@&${id}>`).join(', ') + '.');
  if (c.forbiddenRoleIds.some((id) => owned.has(id))) failures.push('Rôle(s) incompatible(s) avec cette candidature : ' + c.forbiddenRoleIds.filter((id) => owned.has(id)).map((id) => `<@&${id}>`).join(', ') + '.');

  return { ok: failures.length === 0, failures, stats };
}

module.exports = { normalizeCriteria, hasCriteria, checkCriteria, splitSections, criteriaSummary };
