'use strict';

/**
 * Réponse prédéfinie → texte final. Placeholders : {user} (mention de l'ouvreur), {staff} (mention du membre du
 * staff qui répond), {ticket} (#42), {number} (0042), {type} (libellé du type).
 * Pour le modmail, `ticket` est absent : {user} vise le membre du fil, {ticket}/{number}/{type} restent vides.
 */
function fillSnippet(content, { ticket = null, type = null, staffId = null, userId = null } = {}) {
  const values = {
    user: ticket ? `<@${ticket.opener_id}>` : userId ? `<@${userId}>` : '',
    staff: staffId ? `<@${staffId}>` : '',
    ticket: ticket ? `#${ticket.id}` : '',
    number: ticket ? String(ticket.id).padStart(4, '0') : '',
    type: type?.label ?? '',
  };
  return String(content ?? '').replace(/\{(user|staff|ticket|number|type)\}/g, (match, key) => values[key]);
}

module.exports = { fillSnippet };
