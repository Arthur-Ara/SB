'use strict';

const { GatewayIntentBits, Partials } = require('discord.js');
const { TicketService } = require('./lib/service');
const { TicketLogs } = require('./lib/logs');
const { TicketScheduler } = require('./lib/scheduler');
const { publishPanel } = require('./lib/lifecycle');
const { ticketNotifications } = require('./lib/notifications');
const { AutolistService } = require('./lib/autolist');
const registerWeb = require('./web/routes');

/**
 * Module Tickets : panels multi-types (chaque bouton/option d'un panel a sa propre catégorie,
 * ses propres rôles modérateur/notifié/helper, sa propre limite, ses propres embeds et ses
 * propres réglages de transcript), cycle de vie complet (ouverture, claim, ajout/retrait de
 * membres, fermeture, clôture automatique sur inactivité, reping du staff) et transcripts
 * consultables sur le panel web (simulation de l'interface Discord, avec réponse possible depuis
 * le panel si le transcript live est activé pour le type). Concept d'admin propre au module
 * (/ticket admin), comme Laisse et Whitelist.
 */
module.exports = {
  name: 'tickets',
  label: 'Tickets',
  emoji: '🎫',
  description: 'Panels de tickets multi-types, cycle de vie complet et transcripts.',
  defaultEnabled: false,
  // DirectMessages + partiels Channel/Message : le modmail repose sur les messages privés adressés au bot.
  intents: [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],

  async init(ctx) {
    const service = new TicketService({ db: ctx.db, logger: ctx.logger });
    await service.warmup();
    const logs = new TicketLogs({ client: ctx.client, service, logger: ctx.logger, config: ctx.config });
    const scheduler = new TicketScheduler({ client: ctx.client, service, logger: ctx.logger, ctx });
    // Messages « liste des tickets » (/ticket autolist), tenus à jour à chaque changement.
    const autolist = new AutolistService({ client: ctx.client, tickets: service, logger: ctx.logger });
    Object.assign(ctx.services, { tickets: service, logs, ticketScheduler: scheduler, autolist });

    /** Salon recréé (/purge) : journal et panels publiés suivent le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      const done = [];
      if ((await service.settings(guild.id)).logChannelId === oldId) {
        await service.setLogChannel(guild.id, newChannel.id);
        done.push('Journal des tickets');
      }
      for (const panel of await service.listPanels(guild.id)) {
        if (String(panel.channel_id) !== oldId) continue;
        const result = await publishPanel(ctx, panel, newChannel).catch((err) => ({ error: err.message }));
        if (!result.error) done.push(`Panel de tickets #${panel.id} republié`);
      }
      return done;
    };

    /** Notifications du panel web (cloche de la barre du haut). */
    ctx.services.webNotifications = (userId) => ticketNotifications(ctx, userId);
  },

  async ready(ctx) {
    ctx.services.ticketScheduler.start();
    // Indicateur « attente du staff / du membre » des listes /ticket autolist : recalculé périodiquement (0 = jamais).
    const minutes = Math.max(0, ctx.config.env.int('TICKETS_AUTOLIST_REFRESH_MINUTES', 5));
    ctx.services.autolist.start(minutes * 60 * 1000);
  },

  async shutdown(ctx) {
    ctx.services.ticketScheduler?.stop();
    ctx.services.autolist?.stop();
  },

  web: {
    label: 'Tickets',
    register: registerWeb,
  },
};
