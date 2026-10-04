'use strict';

const { PermissionFlagsBits: P } = require('discord.js');

/** Permissions « de gestion » : un rôle qui en porte une ne doit pas être auto-attribuable par erreur. */
const SENSITIVE = [
  [P.Administrator, 'Administrateur'],
  [P.ManageGuild, 'Gérer le serveur'],
  [P.ManageRoles, 'Gérer les rôles'],
  [P.ManageChannels, 'Gérer les salons'],
  [P.ManageWebhooks, 'Gérer les webhooks'],
  [P.ManageMessages, 'Gérer les messages'],
  [P.ManageNicknames, 'Gérer les pseudos'],
  [P.ModerateMembers, 'Exclure temporairement des membres'],
  [P.KickMembers, 'Expulser des membres'],
  [P.BanMembers, 'Bannir des membres'],
  [P.ViewAuditLog, 'Voir les logs du serveur'],
  [P.MentionEveryone, 'Mentionner @everyone'],
];

/** Libellés des permissions sensibles portées par ce rôle. */
function sensitivePermissions(role) {
  return SENSITIVE.filter(([flag]) => role.permissions.has(flag, false)).map(([, label]) => label);
}

/**
 * Raison pour laquelle le bot ne doit pas (ou ne peut pas) attribuer ce rôle, ou null s'il peut le faire.
 * Le rôle *Administrateur* est toujours refusé ; les autres permissions sensibles le sont aussi, sauf si
 * `allowSensitive` (ROLEMENU_ALLOW_SENSITIVE_ROLES=true).
 */
function roleProblem(guild, roleId, { allowSensitive = false } = {}) {
  const role = guild.roles.cache.get(String(roleId));
  if (!role) return 'rôle introuvable (supprimé ?)';
  if (role.id === guild.id) return '@everyone ne peut pas être attribué';
  if (role.managed) return 'rôle géré par une intégration (bot, boost…)';
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) return 'rôle au-dessus (ou au niveau) du rôle le plus haut du bot : replace le rôle du bot plus haut';
  if (role.permissions.has(P.Administrator, false)) return 'rôle Administrateur : jamais attribuable automatiquement';
  if (!allowSensitive) {
    const sensitive = sensitivePermissions(role);
    if (sensitive.length) return `permissions sensibles (${sensitive.join(', ')}) : refusé par sécurité`;
  }
  return null;
}

// ── Émojis ────────────────────────────────────────────────────────────────────

const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)/u;

/**
 * Analyse un émoji saisi : Unicode (😀) ou personnalisé (<:nom:id>, <a:nom:id>).
 * @returns {null | { kind, key, raw, button }} `key` sert à comparer avec celui d'une réaction ; `button` à l'afficher sur un bouton.
 */
function parseEmoji(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const custom = CUSTOM_EMOJI.exec(text);
  if (custom) {
    return {
      kind: 'custom',
      key: custom[3],
      raw: text,
      button: { id: custom[3], name: custom[2], animated: Boolean(custom[1]) },
    };
  }
  if (text.length <= 16 && UNICODE_EMOJI.test(text)) {
    return { kind: 'unicode', key: text.replace(/️/g, ''), raw: text, button: text };
  }
  return null;
}

/** Clé comparable d'un émoji de réaction reçu de Discord. */
function reactionKey(emoji) {
  return emoji.id ?? String(emoji.name ?? '').replace(/️/g, '');
}

module.exports = { roleProblem, sensitivePermissions, parseEmoji, reactionKey };
