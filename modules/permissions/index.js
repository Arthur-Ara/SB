'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { PermissionService } = require('./lib/service');
const registerWeb = require('./web/routes');

const DENIAL_REASONS = {
  user: (name) => `Vous avez été explicitement exclu de **/${name}** sur ce serveur.`,
  role: (name) => `Vos rôles ne permettent pas d’utiliser **/${name}** sur ce serveur.`,
  default: (name) =>
    `**/${name}** est réservée aux administrateurs du serveur et aux rôles ou membres autorisés via \`/permission\`.`,
};

/**
 * Module Permissions : contrôle d'accès granulaire aux slash commands (par serveur, rôle ou utilisateur),
 * appliqué par un middleware du Command Handler avant chaque exécution. Accords temporaires, modèles
 * réutilisables, copie des règles d'un rôle vers un autre et diagnostic (/permission check).
 * Spécifications : permissions.md (+ demande utilisateur du 2026-10-02)
 */
module.exports = {
  name: 'permissions',
  label: 'Permissions',
  emoji: '🛡️',
  description: 'Autorisations des commandes par serveur, par rôle ou par utilisateur.',
  required: true, // le contrôle d'accès ne peut pas être désactivé sur un serveur
  intents: [],

  async init(ctx) {
    const service = new PermissionService({ db: ctx.db, logger: ctx.logger });
    ctx.services.permissions = service;

    ctx.commands.use(async (interaction, command) => {
      if (!ctx.modules.isLoaded('permissions') || !interaction.inGuild()) return null;
      const name = command.data.name;
      const { guildId } = interaction;
      const userId = interaction.user.id;

      // Garde-fou : le propriétaire du serveur ne peut jamais perdre l'accès à /permission.
      if (name === 'permission' && interaction.guild?.ownerId === userId) return null;

      const member = interaction.member;
      const roleIds = member ? (Array.isArray(member.roles) ? [...member.roles] : [...member.roles.cache.keys()]) : [];
      if (!roleIds.includes(guildId)) roleIds.push(guildId); // rôle @everyone

      const verdict = await service.decide({
        guildId,
        userId,
        roleIds,
        isAdmin: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
        command: name,
        module: command.module ?? null,
        defaultAccess: command.permission?.default ?? 'admin',
      });
      return verdict.allowed ? null : { allowed: false, reason: DENIAL_REASONS[verdict.source](name) };
    });
  },

  // Accords temporaires : déjà ignorés à l'échéance (cache périmé à la première date d'expiration), les lignes
  // échues sont en plus supprimées chaque minute pour que les listes restent propres.
  async ready(ctx) {
    const sweep = () => ctx.services.permissions.sweepExpired().catch((err) => ctx.logger.warn('Nettoyage des accords temporaires impossible', err.message));
    sweep();
    ctx.services.expirySweeper = setInterval(sweep, 60_000);
    ctx.services.expirySweeper.unref();
  },

  async shutdown(ctx) {
    clearInterval(ctx.services.expirySweeper);
  },

  // Édition des règles depuis le panel web, réservée aux administrateurs (voir web/routes.js).
  web: { label: 'Permissions', register: registerWeb },
};
