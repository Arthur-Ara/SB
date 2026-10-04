'use strict';

/** Nom de salon Discord valide : minuscules sans accents, chiffres, tirets (partagé par Tickets, modmail, prison). */
function slugifyChannelName(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'membre';
}

module.exports = { slugifyChannelName };
