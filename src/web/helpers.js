'use strict';

/**
 * Utilitaires communs aux routes web des modules (/m/<module>/api/…) : erreurs HTTP, enveloppe async,
 * validation des identifiants Discord, avatars et champs d'embed saisis depuis le panel.
 */

const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#?([0-9a-f]{6})$/i;
const HTTP_URL = /^https?:\/\/\S+$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Transmet les erreurs d'un gestionnaire async au gestionnaire d'erreurs Express. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/** Avatar Discord (ou avatar par défaut) à partir de l'ID et du hash. */
function avatarUrl(userId, hash, size = 64) {
  if (hash) {
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=${size}`;
  }
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Couleur « #RRGGBB » normalisée, null si vide ; erreur 400 si invalide. */
function hexColor(value, label = 'Couleur') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = HEX_COLOR.exec(text);
  if (!match) throw new HttpError(400, `${label} invalide (format #RRGGBB).`);
  return `#${match[1].toLowerCase()}`;
}

/** Lien d'image http(s), null si vide ; erreur 400 si invalide (Discord refuserait l'embed). */
function imageUrl(value, label = 'Image') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!HTTP_URL.test(text) || text.length > 1024) throw new HttpError(400, `${label} : lien http(s) invalide.`);
  return text;
}

/** Salon textuel du serveur (ou null si vide) ; erreur 400 s'il n'existe pas ou n'est pas textuel. */
function textChannelId(guild, value) {
  const id = value ? String(value) : null;
  if (!id) return null;
  const channel = isSnowflake(id) ? guild.channels.cache.get(id) : null;
  if (!channel?.isTextBased() || channel.isThread() || channel.isVoiceBased()) throw new HttpError(400, 'Salon introuvable sur ce serveur ou non textuel.');
  return id;
}

module.exports = { HttpError, wrap, isSnowflake, avatarUrl, hexColor, imageUrl, textChannelId };
