'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { wildcardOf } = require('./service');

/**
 * Diagnostic d'accès d'un membre à une commande (/permission check et panel web), en suivant exactement
 * l'ordre du middleware du module : propriétaire et /permission, puis décision du service, plus l'état du
 * module de la commande sur le serveur et toutes les règles de ses rôles pour cette commande.
 * @returns {Promise<{ allowed, source, roleId, expiresAt, defaultAccess, isAdmin, ownerOverride, moduleEnabled, moduleLabel, roleRules }>}
 */
async function explainAccess(ctx, guild, member, name) {
  const command = ctx.commands.commands.get(name);
  const permissions = ctx.services.permissions;
  const defaultAccess = command.permission?.default ?? 'admin';
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  const roleIds = [...member.roles.cache.keys()];
  if (!roleIds.includes(guild.id)) roleIds.push(guild.id);

  const moduleEnabled = command.module === 'core' || ctx.modules.isEnabledFor(command.module, guild.id);
  const moduleLabel = command.module === 'core' ? 'Général' : ctx.modules.labelOf(command.module);
  const ownerOverride = name === 'permission' && guild.ownerId === member.id;
  const decision = ownerOverride
    ? { allowed: true, source: 'owner' }
    : await permissions.decide({ guildId: guild.id, userId: member.id, roleIds, isAdmin, command: name, module: command.module, defaultAccess });

  // Règles de ses rôles sur cette commande et sur le joker de son module (« moderation.* »).
  const rules = await permissions.rules(guild.id);
  const roleRules = [name, wildcardOf(command.module)].flatMap((key) =>
    [...(rules.roles.get(key) ?? new Map())]
      .filter(([roleId]) => roleIds.includes(roleId))
      .map(([roleId, rule]) => ({ roleId, allowed: rule.allowed, expiresAt: rule.expiresAt, wildcard: key !== name ? key : null })),
  );

  return {
    allowed: decision.allowed && moduleEnabled,
    source: decision.source,
    roleId: decision.roleId ?? null,
    expiresAt: decision.expiresAt ?? null,
    defaultAccess,
    isAdmin,
    ownerOverride,
    moduleEnabled,
    moduleLabel,
    roleRules,
    decisionAllowed: decision.allowed,
  };
}

/** Phrase d'explication ; `roleText(id)` met en forme un rôle (mention sur Discord, nom sur le panel), `until(date)` une échéance. */
function explanationText(result, { roleText, until }) {
  const temp = result.expiresAt ? ` (accord temporaire, ${until(result.expiresAt)})` : '';
  switch (result.source) {
    case 'owner':
      return 'Propriétaire du serveur : ne peut jamais perdre l’accès à /permission.';
    case 'user':
      return result.decisionAllowed ? `Autorisé par une règle individuelle${temp}.` : 'Bloqué par une règle individuelle (prioritaire sur les rôles).';
    case 'role':
      return result.decisionAllowed
        ? `Autorisé par le rôle ${roleText(result.roleId)}${temp}.`
        : `Bloqué par le rôle ${roleText(result.roleId)} (aucun de ses rôles n’est autorisé).`;
    case 'public':
      return 'Autorisé : la commande est publique sur ce serveur.';
    default:
      if (result.defaultAccess === 'everyone') return 'Autorisé : commande ouverte à tous par défaut.';
      return result.isAdmin
        ? 'Autorisé : administrateur du serveur (commande réservée aux administrateurs par défaut).'
        : 'Bloqué : commande réservée aux administrateurs par défaut, et aucune règle ne l’autorise pour ce membre.';
  }
}

const SOURCE_TEXT = { owner: 'propriétaire', user: 'règle individuelle', role: 'règle de rôle', public: 'commande publique', default: 'accès par défaut' };

module.exports = { explainAccess, explanationText, SOURCE_TEXT };
