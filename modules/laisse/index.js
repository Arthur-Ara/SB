'use strict';

const { GatewayIntentBits } = require('discord.js');
const { LeashService } = require('./lib/service');
const { LeashLogs } = require('./lib/logs');
const { LeashMover } = require('./lib/mover');
const registerWeb = require('./web/routes');

/**
 * Module Laisse : un membre « en laisse » suit automatiquement son maître de salon vocal en salon vocal.
 * Désactivé par défaut : à activer serveur par serveur avec /modules.
 */
module.exports = {
  name: 'laisse',
  label: 'Laisse',
  emoji: '🔗',
  description: 'Un membre en laisse suit automatiquement son maître en vocal.',
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],

  async init(ctx) {
    const service = new LeashService({ db: ctx.db, logger: ctx.logger });
    const logs = new LeashLogs({ client: ctx.client, service, logger: ctx.logger });
    const mover = new LeashMover({ service, logs, logger: ctx.logger });
    Object.assign(ctx.services, { leash: service, logs, mover });

    /** Salon recréé (/purge) : le journal du module suit le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      if ((await service.state(guild.id)).settings.logChannelId !== oldId) return [];
      await service.updateSettings(guild.id, { logChannelId: newChannel.id });
      return ['Journal de la laisse'];
    };
  },

  web: {
    label: 'Laisse',
    register: registerWeb,
  },
};
