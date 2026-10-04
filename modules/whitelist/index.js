'use strict';

const { GatewayIntentBits } = require('discord.js');
const { WhitelistService } = require('./lib/service');
const { WhitelistLogs } = require('./lib/logs');
const { WhitelistEnforcer } = require('./lib/enforcer');
const registerWeb = require('./web/routes');

/**
 * Module Whitelist Vocal : restreint l'accès de certains salons vocaux à une liste de membres
 * et de rôles, et/ou limite leur nombre de places — les personnes non autorisées ou en trop
 * sont déconnectées automatiquement. Configuration propre à chaque salon, via un embed interactif
 * (/whitelist channel) ou le panel web : plage horaire d'application, accès temporaires (/whitelist invite)
 * et admins limités à certains salons. Désactivé par défaut : à activer serveur par serveur avec /modules.
 */
module.exports = {
  name: 'whitelist',
  label: 'Whitelist Vocal',
  emoji: '🚪',
  description: 'Accès restreint et limite de places par salon vocal, avec expulsion automatique.',
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],

  async init(ctx) {
    const service = new WhitelistService({ db: ctx.db, logger: ctx.logger });
    const logs = new WhitelistLogs({ client: ctx.client, service, logger: ctx.logger });
    const enforcer = new WhitelistEnforcer({ ctx, service, logs, logger: ctx.logger });
    Object.assign(ctx.services, { whitelist: service, logs, enforcer });

    /** Salon recréé (/purge) : le journal du module suit le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel, actor) => {
      if ((await service.state(guild.id)).settings.logChannelId !== oldId) return [];
      await service.setLogChannel(guild.id, newChannel.id, actor.id);
      return ['Journal de la whitelist vocale'];
    };
  },

  async ready(ctx) {
    ctx.services.enforcer.start();
  },

  async shutdown(ctx) {
    ctx.services.enforcer?.stop();
  },

  web: {
    label: 'Whitelist Vocal',
    register: registerWeb,
  },
};
