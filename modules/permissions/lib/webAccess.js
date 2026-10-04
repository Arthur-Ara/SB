'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { HttpError, isSnowflake } = require('../../../src/web/helpers');

async function memberOf(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

/** Service du module Permissions, quel que soit le module appelant (son propre ctx ou celui d'un autre). */
function permissionsService(ctx) {
  return ctx.services?.permissions ?? ctx.modules?.services('permissions')?.permissions ?? null;
}

/**
 * L'utilisateur connecté au dashboard a-t-il ce droit précis, pour cette catégorie, sur ce serveur ?
 * `right` omis = « au moins un droit quelconque de la catégorie » (pour gater une page d'ensemble).
 *
 * - Propriétaires du bot : toujours autorisés, sur tous les serveurs.
 * - Tous les autres comptes doivent être **membres du serveur** : un compte autorisé du dashboard
 *   n'a aucun accès aux serveurs dont il ne fait pas partie.
 * - Propriétaire du serveur et administrateurs Discord : toujours autorisés.
 * - Sans grant configuré pour la catégorie (`web_permission_grants` vide pour elle), un membre garde
 *   un accès complet ; dès qu'un grant existe, seuls les rôles concernés ont accès.
 */
async function hasWebRight(ctx, guild, userId, category, right) {
  if (ctx.config.owners.has(userId)) return true;
  const member = await memberOf(guild, userId);
  if (!member) return false;
  if (userId === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const permissions = permissionsService(ctx);
  if (!permissions) return true;
  const grants = await permissions.webGrants(guild.id, category);
  if (!grants.length) return true;
  return grants.some((g) => member.roles.cache.has(String(g.role_id)) && (!right || g.right_key === '' || g.right_key === right));
}

/**
 * Contrôle d'accès commun aux routes web d'un module : serveur visé (`?guild=` ou `guildId` du corps),
 * module activé sur ce serveur, appartenance du compte au serveur et droit du panel (/permission grant-panel).
 * @param {object} ctx  contexte du module
 * @param {{ module: string, category: string, label: string }} options
 */
function guildAccess(ctx, { module, category, label }) {
  const denied = 'Accès refusé : il faut être membre de ce serveur et avoir ce droit sur le panel web (voir /permission grant-panel).';

  /** Vérifie le droit sur un serveur déjà résolu (ex. transcript ouvert par lien direct). */
  async function check(req, guild, right = null) {
    if (!(await hasWebRight(ctx, guild, req.session.user.id, category, right))) throw new HttpError(403, denied);
  }

  /** Serveur ciblé par la requête, après tous les contrôles. */
  async function guild(req, right = null) {
    const guildId = String(req.query.guild ?? req.body?.guildId ?? '');
    if (!isSnowflake(guildId)) throw new HttpError(400, 'Serveur invalide');
    const found = ctx.client.guilds.cache.get(guildId);
    if (!found) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    if (!ctx.modules.isEnabledFor(module, guildId)) {
      throw new HttpError(409, `Le module ${label} est désactivé sur ce serveur (voir /modules sur Discord).`);
    }
    await check(req, found, right);
    return found;
  }

  /** Serveurs (module activé) que ce compte peut ouvrir, triés par nom, pour le sélecteur du panel. */
  async function guilds(req) {
    const candidates = [...ctx.client.guilds.cache.values()].filter((g) => ctx.modules.isEnabledFor(module, g.id));
    const allowed = await Promise.all(candidates.map((g) => hasWebRight(ctx, g, req.session.user.id, category, null).catch(() => false)));
    return candidates
      .filter((g, index) => allowed[index])
      .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { guild, check, guilds };
}

module.exports = { hasWebRight, guildAccess, memberOf };
