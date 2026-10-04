'use strict';

const { slugifyChannelName } = require('../../../src/bot/text');

const DEFAULT_PATTERN = 'ticket-{number}-{username}';

/**
 * Nom de salon à partir du format choisi pour le type (`{number}` `{username}` `{type}`, `{user}`
 * accepté comme alias de `{username}` — dans un nom de salon il ne peut de toute façon pas s'agir
 * d'une mention cliquable comme dans les embeds), toujours passé au crible de `slugifyChannelName`
 * pour rester un nom de salon valide (et unique grâce au numéro du ticket, sauf format personnalisé
 * qui l'omettrait — à la charge de l'admin qui le choisit).
 */
function ticketChannelName(pattern, { ticketId, username, typeLabel, claimer }) {
  const filled = (pattern || DEFAULT_PATTERN)
    .replace(/\{number\}/g, String(ticketId).padStart(4, '0'))
    .replace(/\{user(?:name)?\}/g, username)
    .replace(/\{type\}/g, typeLabel ?? '')
    .replace(/\{claimer\}/g, claimer ?? '');
  return slugifyChannelName(filled).slice(0, 100);
}

/** Un préfixe d'étiquette nettoyé pour un nom de salon : minuscules, tirets, émojis conservés (ex. « 🔴urgent »). */
function cleanPrefix(prefix) {
  return String(prefix ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\u200d\ufe0f-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
}

/** Préfixes des étiquettes d'un ticket (déjà triées par priorité), à placer devant le nom du salon : « urgent-bug ». */
function tagPrefix(tags) {
  return (tags ?? []).map((tag) => cleanPrefix(tag.channel_prefix)).filter(Boolean).join('-');
}

module.exports = { slugifyChannelName, ticketChannelName, tagPrefix, cleanPrefix, DEFAULT_PATTERN };
