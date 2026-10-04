'use strict';

const { GatewayIntentBits, Partials } = require('discord.js');
const { loadSettings } = require('./lib/settings');
const { StatsStore } = require('./lib/store');
const { MemberSync } = require('./lib/members');
const { VoiceTracker } = require('./lib/voice');
const { SnapshotService } = require('./lib/snapshots');
const { BackfillService } = require('./lib/backfill');
const { StatsQueries } = require('./lib/queries');
const { GuildConfigService } = require('./lib/guildConfig');
const { InviteTracker } = require('./lib/invites');
const { ReportService } = require('./lib/reports');
const registerWeb = require('./web/routes');
const { hasWebRight } = require('../permissions/lib/webAccess');

/**
 * Module Statistiques : collecte de l'activité de chaque serveur (messages, vocal,
 * membres, modération, boosts), rétroactivité de 7 jours et dashboard analytique ; rapport hebdomadaire,
 * comparaison avec la période précédente, export CSV et suivi des invitations (réglables par serveur).
 * Spécifications : stats.md (+ demande utilisateur du 2026-10-02)
 */
module.exports = {
  name: 'stats',
  label: 'Statistiques',
  emoji: '📊',
  description: 'Collecte d’activité par serveur, rétroactivité et dashboard analytique.',

  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privilégié : arrivées/départs, rôles, pseudos
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilégié : longueur des messages, @everyone/@here
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration, // journal d'audit (bans, kicks, timeouts)
    GatewayIntentBits.GuildInvites, // suivi des invitations (création / suppression)
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],

  async init(ctx) {
    const settings = loadSettings(ctx.config.env);
    const { db, client, logger } = ctx;
    const store = new StatsStore(db, logger.child('store'), settings);
    const members = new MemberSync({ store, logger: logger.child('membres') });
    const voice = new VoiceTracker({ db, store, logger: logger.child('vocal'), settings, client });
    // Serveurs où le module est désactivé (/modules) : aucune collecte de fond.
    const enabledFor = (guildId) => ctx.modules.isEnabledFor('stats', guildId);
    const snapshots = new SnapshotService({ client, store, members, logger: logger.child('instantanés'), settings, enabledFor });
    const backfill = new BackfillService({
      client,
      store,
      members,
      snapshots,
      logger: logger.child('rétroactivité'),
      settings,
      enabledFor,
    });
    const queries = new StatsQueries({ db, client });
    const guildConfig = new GuildConfigService({ db });
    const invites = new InviteTracker({ db, client, config: guildConfig, logger: logger.child('invitations'), enabledFor });
    const reports = new ReportService({ db, client, queries, config: guildConfig, invites, logger: logger.child('rapports'), enabledFor });

    Object.assign(ctx.services, { settings, store, members, voice, snapshots, backfill, queries, guildConfig, invites, reports });

    /** Notifications du panel web : rapports hebdomadaires générés ces 7 derniers jours. */
    ctx.services.webNotifications = async (userId) => {
      const rows = await db.query('SELECT id, guild_id, created_at FROM stats_reports WHERE created_at >= ? ORDER BY created_at DESC', [new Date(Date.now() - 7 * 86_400_000)]);
      const items = [];
      const seen = new Set();
      for (const row of rows) {
        const guildId = String(row.guild_id);
        if (seen.has(guildId)) continue; // un seul rappel par serveur : le plus récent
        seen.add(guildId);
        const guild = client.guilds.cache.get(guildId);
        if (!guild || !enabledFor(guildId)) continue;
        if (!(await hasWebRight(ctx, guild, userId, 'stats', 'view'))) continue;
        items.push({ module: 'stats', emoji: '📊', guildName: guild.name, text: 'Nouveau rapport hebdomadaire disponible', href: `/m/stats/rapports?guild=${guildId}`, at: row.created_at });
      }
      return items;
    };

    // Referme les sessions vocales laissées ouvertes par un arrêt brutal, puis démarre le heartbeat.
    await voice.recoverOrphans();
    voice.startHeartbeat();

    if (settings.storeMessageContent) {
      logger.info(
        `Le contenu des messages est enregistré (STATS_STORE_MESSAGE_CONTENT=true), ${
          settings.contentRetentionDays ? `effacé après ${settings.contentRetentionDays} jours (STATS_CONTENT_RETENTION_DAYS)` : 'sans limite de durée'
        }.`,
      );
    }
    // Durée de conservation du contenu : purge au démarrage puis toutes les 6 h (même si l'enregistrement a été coupé depuis).
    const purgeContent = () =>
      store
        .purgeOldContent(settings.contentRetentionDays)
        .then((n) => n && logger.info(`${n} contenu(s) de message effacé(s) (conservation : ${settings.contentRetentionDays} j)`))
        .catch((err) => logger.warn('Purge du contenu des messages impossible', err.message));
    purgeContent();
    ctx.services.retentionTimer = setInterval(purgeContent, 6 * 60 * 60_000);
    ctx.services.retentionTimer.unref();
  },

  async ready(ctx) {
    const { store, voice, members, snapshots, backfill } = ctx.services;
    const guilds = [...ctx.client.guilds.cache.values()];

    for (const guild of guilds) await store.upsertGuild(guild);
    await store.markAbsentGuilds(guilds.map((guild) => guild.id));
    await voice.scanActive(guilds);

    // La synchronisation peut être longue sur de gros serveurs : elle tourne en arrière-plan.
    ctx.services.startup = (async () => {
      const states = await store.guildStates();
      for (const guild of guilds) {
        const state = states.get(guild.id);
        if (state?.backfill_status !== 'done') continue; // la rétroactivité s'en chargera
        if (!ctx.modules.isEnabledFor('stats', guild.id)) continue;
        try {
          await members.syncStructure(guild);
          await members.syncGuild(guild, { joinsSince: state.tracking_since, eventSource: 'sync' });
        } catch (err) {
          ctx.logger.error(`Synchronisation de « ${guild.name} » impossible`, err);
        }
      }
      snapshots.start();
      await backfill.enqueuePending();
    })().catch((err) => ctx.logger.error('Échec de la synchronisation initiale', err));

    ctx.services.reports.start();
    ctx.services.invites.warmup(guilds).catch((err) => ctx.logger.warn('Lecture initiale des invitations impossible', err.message));
  },

  async shutdown(ctx) {
    const { snapshots, backfill, voice, store, retentionTimer, reports } = ctx.services;
    if (retentionTimer) clearInterval(retentionTimer);
    reports?.stop();
    snapshots?.stop();
    backfill?.stop();
    await voice?.shutdown().catch((err) => ctx.logger.warn('Fermeture des sessions vocales', err.message));
    await store?.close();
  },

  web: {
    label: 'Statistiques',
    register: registerWeb,
  },
};
