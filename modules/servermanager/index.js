'use strict';

const { GatewayIntentBits } = require('discord.js');
const { SmStore } = require('./lib/store');
const { Journal } = require('./lib/journal');
const { RollbackEngine } = require('./lib/engine');
const { BackupService } = require('./lib/backupService');
const registerWeb = require('./web/routes');

const PURGE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Module Server Manager : journal des modifications du serveur (salons, rôles, rôles des membres) et
 * /rollback pour les annuler sur une période, par type et par auteur, avec un jeu de garde-fous
 * (aperçu obligatoire, confirmation renforcée, hiérarchie, plafonds, coupe-circuit…) ; sauvegardes de la
 * structure du serveur (manuelles ou automatiques) et restauration non destructive ; interface sur le panel web.
 * Spécifications : servermanager.md
 */
module.exports = {
  name: 'servermanager',
  label: 'Server Manager',
  emoji: '🗂️',
  description: 'Journal des modifications du serveur et rollback (rôles, salons, modération) sur une période.',
  // Fonctionnalités présentées sur la page « Fonctionnalités » du panel web.
  features: [
    'Journal des modifications du serveur (rôles, salons, modération) avec leur auteur',
    'Rollback sur une période, par type et par auteur, avec aperçu et garde-fous',
    'Sauvegardes manuelles et automatiques, restauration non destructive',
    'Panel web : rollback suivi en direct, journal filtrable, sauvegardes',
  ],
  defaultEnabled: false,
  intents: [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],

  async init(ctx) {
    const { env } = ctx.config;
    const limits = {
      maxWindowS: Math.max(1, env.int('SERVERMANAGER_MAX_WINDOW_HOURS', 168)) * 3600,
      maxActions: Math.max(1, env.int('SERVERMANAGER_MAX_ACTIONS', 60)),
      retentionDays: Math.max(1, env.int('SERVERMANAGER_RETENTION_DAYS', 30)),
      cooldownS: Math.max(0, env.int('SERVERMANAGER_COOLDOWN_SECONDS', 120)),
    };
    const store = new SmStore(ctx.db);
    const journal = new Journal({ db: ctx.db, logger: ctx.logger.child('journal'), store });
    const engine = new RollbackEngine({
      db: ctx.db,
      client: ctx.client,
      logger: ctx.logger.child('rollback'),
      journal,
      store,
      modules: ctx.modules,
      limits,
    });
    const backups = new BackupService({
      client: ctx.client,
      store,
      journal,
      engine,
      logger: ctx.logger.child('sauvegardes'),
      enabledFor: (guildId) => ctx.modules.isEnabledFor('servermanager', guildId),
    });
    engine.isRestoring = (guildId) => backups.restoring.has(guildId);
    // Salons de tickets / modmail : gérés par le module Tickets, ni journalisés ni concernés par un rollback.
    ctx.services.isTicketChannel = (channelId) => {
      const tickets = ctx.modules.services('tickets')?.tickets;
      return Boolean(tickets && (tickets.isTicketChannel(channelId) || tickets.isModmailChannel(channelId)));
    };
    Object.assign(ctx.services, { store, journal, engine, limits, backups });

    /** Salon recréé (/purge) : le journal du module suit le nouveau salon. */
    ctx.services.onChannelReplaced = async (guild, oldId, newChannel) => {
      if ((await store.settings(guild.id)).logChannelId !== oldId) return [];
      await store.setLogChannel(guild.id, newChannel.id);
      return ['Journal du Server Manager'];
    };
  },

  async ready(ctx) {
    const { store, journal, limits } = ctx.services;
    for (const guild of ctx.client.guilds.cache.values()) {
      if (!ctx.modules.isEnabledFor('servermanager', guild.id)) continue;
      await store.ensureTrackingSince(guild.id).catch((err) => ctx.logger.warn(`Début du journal de « ${guild.name} » non enregistré`, err.message));
    }
    const purge = () =>
      journal
        .purge(limits.retentionDays)
        .catch((err) => ctx.logger.warn('Purge du journal impossible', err.message));
    purge();
    ctx.services.purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
    ctx.services.purgeTimer.unref();
    ctx.services.backups.start();
  },

  async shutdown(ctx) {
    if (ctx.services.purgeTimer) clearInterval(ctx.services.purgeTimer);
    ctx.services.backups?.stop();
  },

  web: {
    label: 'Server Manager',
    register: registerWeb,
  },
};
