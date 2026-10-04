'use strict';

const { GatewayIntentBits } = require('discord.js');
const { ModerationService } = require('./lib/service');
const { ModerationLogs } = require('./lib/logs');
const { ModerationScheduler } = require('./lib/scheduler');
const registerWeb = require('./web/routes');
const { hasWebRight } = require('../permissions/lib/webAccess');

/**
 * Module Modération : sanctions (ban, ban temporaire, kick, exclusions temporaires, avertissements avec
 * sanctions automatiques au cumul, shadow-ban), automod (mots interdits), notes internes, contestations,
 * gestion des salons (verrouillage, mode lent, purge) et historique. Contrairement à Laisse et
 * Whitelist, ce module n'a pas de concept d'admin propre côté Discord : l'accès à chaque commande
 * est géré entièrement par le module Permissions (une commande Discord distincte par action, pour
 * que /permission puisse les autoriser indépendamment les unes des autres). Le panel web reste
 * protégé par sa propre porte (droit `moderation` du panel), indépendante de /permission.
 * Spécifications : demandes utilisateur du 2026-09-29 et du 2026-10-02 (pas de fichier .md dédié).
 */
module.exports = {
  name: 'moderation',
  label: 'Modération',
  emoji: '🛡️',
  description: 'Sanctions, automod, verrouillages de salons, avertissements et historique de modération.',
  // Fonctionnalités présentées sur la page « Fonctionnalités » du panel web.
  features: [
    'Sanctions : ban, tempban, kick, mute, mute vocal, avertissements, notes, shadow-ban',
    'Identifiant et preuves pour chaque sanction, historique par membre, contestation',
    'Verrouillage de salons ou du serveur, mode lent, nettoyage de messages, /purge d’un salon',
    'Automod configurable et blacklist globale (tous les serveurs, propriétaires du bot)',
    'Journal de modération détaillé et panel web (bannis, avertissements, salons verrouillés…)',
  ],
  defaultEnabled: false,
  intents: [
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilégié : automod (mots interdits)
  ],

  async init(ctx) {
    const service = new ModerationService({ db: ctx.db, logger: ctx.logger });
    const logs = new ModerationLogs({ client: ctx.client, service, logger: ctx.logger });
    const scheduler = new ModerationScheduler({ client: ctx.client, service, logs, logger: ctx.logger });
    Object.assign(ctx.services, { moderation: service, logs, scheduler });

    /** Salon recréé (/purge) : le journal du module suit le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      if ((await service.settings(guild.id)).logChannelId !== oldId) return [];
      await service.setLogChannel(guild.id, newChannel.id);
      return ['Journal de modération'];
    };

    /** Notifications du panel web : messages bloqués par l'automod ces dernières 24 h. */
    ctx.services.webNotifications = async (userId) => {
      const rows = await ctx.db.query(
        `SELECT guild_id, COUNT(*) AS n, MAX(created_at) AS at FROM moderation_automod_hits
          WHERE created_at >= ? AND false_positive = 0 GROUP BY guild_id`,
        [new Date(Date.now() - 86_400_000)],
      );
      const items = [];
      for (const row of rows) {
        const guild = ctx.client.guilds.cache.get(String(row.guild_id));
        if (!guild || !ctx.modules.isEnabledFor('moderation', guild.id)) continue;
        if (!(await hasWebRight(ctx, guild, userId, 'moderation', 'view'))) continue;
        const n = Number(row.n);
        items.push({ module: 'moderation', emoji: '🤖', guildName: guild.name, text: `${n} message${n > 1 ? 's' : ''} bloqué${n > 1 ? 's' : ''} par l’automod (24 h)`, href: '/m/moderation/', at: row.at });
      }
      return items;
    };
  },

  async ready(ctx) {
    ctx.services.scheduler.start();
  },

  async shutdown(ctx) {
    ctx.services.scheduler?.stop();
  },

  web: {
    label: 'Modération',
    register: registerWeb,
  },
};
