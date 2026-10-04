'use strict';

const SNOWFLAKE = /^\d{17,20}$/;

/** Messages pris en compte : messages de serveur écrits par un humain (ni bot, ni webhook, ni système). */
function isTrackableMessage(message) {
  return Boolean(message.inGuild?.() && message.author && !message.author.bot && !message.webhookId && !message.system);
}

/**
 * Estimation du statut Nitro.
 *
 * L'API Discord n'expose pas l'abonnement Nitro aux bots : on s'appuie sur des
 * fonctionnalités réservées aux abonnés (boost du serveur, avatar animé,
 * avatar ou bannière de profil spécifique au serveur, bannière de profil global).
 * Le résultat est donc un minimum : un abonné sans aucun de ces signes n'est pas détecté.
 */
function detectNitro(member) {
  if (!member || member.user?.bot) return false;
  if (member.premiumSince) return true;
  if (member.avatar) return true;
  if (member.banner) return true;
  if (member.user?.avatar?.startsWith('a_')) return true;
  if (member.user?.banner) return true;
  return false;
}

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

function guildIconUrl(guildId, hash, size = 64) {
  if (!hash) return null;
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${ext}?size=${size}`;
}

/** Convertit un agrégat MySQL (souvent renvoyé en chaîne) en nombre. */
function num(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

module.exports = { isTrackableMessage, detectNitro, avatarUrl, guildIconUrl, num, isSnowflake };
