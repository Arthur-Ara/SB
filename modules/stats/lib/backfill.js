'use strict';

const { PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const { isTrackableMessage } = require('./discordUtils');
const { AUDIT_TYPES, parseAuditEntry } = require('./audit');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Rétroactivité : à l'arrivée sur un serveur (ou au premier démarrage), récupère
 * les N derniers jours via l'API Discord (messages, membres, journal d'audit) et
 * reconstitue la courbe du nombre de membres. Les serveurs sont traités un par un.
 */
class BackfillService {
  constructor({ client, store, members, snapshots, logger, settings, enabledFor = () => true }) {
    this.client = client;
    this.enabledFor = enabledFor;
    this.store = store;
    this.members = members;
    this.snapshots = snapshots;
    this.logger = logger;
    this.settings = settings;
    this.queue = [];
    this.current = null;
    this.running = false;
    this.stopped = false;
  }

  async enqueuePending() {
    const states = await this.store.guildStates();
    for (const guild of this.client.guilds.cache.values()) {
      if (states.get(guild.id)?.backfill_status !== 'done') this.enqueue(guild.id);
    }
  }

  enqueue(guildId) {
    if (!this.enabledFor(guildId)) return; // reprise automatique au prochain démarrage une fois réactivé
    if (this.current === guildId || this.queue.includes(guildId)) return;
    this.queue.push(guildId);
    this.process();
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const guildId = this.queue.shift();
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) continue;
        this.current = guildId;
        await this.run(guild);
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  async run(guild) {
    const days = this.settings.backfillDays;
    const since = new Date(Date.now() - days * DAY_MS);
    const started = Date.now();
    this.logger.info(`Rétroactivité de ${days} jour(s) pour « ${guild.name} »…`);
    await this.store.setBackfillStatus(guild.id, 'running', { trackingSince: since });

    try {
      await this.members.syncStructure(guild);
      await this.members.syncGuild(guild, { joinsSince: since, eventSource: 'backfill' });
      const messages = days > 0 ? await this.backfillMessages(guild, since) : 0;
      const audit = days > 0 ? await this.backfillAuditLog(guild, since) : 0;
      if (days > 0) await this.backfillMemberCurve(guild, since);
      await this.snapshots.take(guild);
      await this.store.setBackfillStatus(guild.id, 'done');
      const seconds = Math.round((Date.now() - started) / 1000);
      this.logger.info(
        `Rétroactivité terminée pour « ${guild.name} » : ${messages} messages, ${audit} entrées d'audit (${seconds} s)`,
      );
    } catch (err) {
      this.logger.error(`Rétroactivité échouée pour « ${guild.name} »`, err);
      await this.store.setBackfillStatus(guild.id, 'failed').catch(() => {});
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async backfillMessages(guild, since) {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const channels = [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread());
    let threads = [];
    try {
      const active = await guild.channels.fetchActiveThreads();
      threads = [...active.threads.values()];
    } catch (err) {
      this.logger.debug(`Fils actifs indisponibles (${guild.name})`, err.message);
    }

    let total = 0;
    for (const channel of [...channels, ...threads]) {
      if (this.stopped) break;
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
      if (channel.lastMessageId && SnowflakeUtil.timestampFrom(channel.lastMessageId) < since.getTime()) continue;
      try {
        total += await this.backfillChannel(channel, since);
        await this.members.ensureChannel(channel);
      } catch (err) {
        this.logger.warn(`Salon #${channel.name} ignoré (${guild.name}) : ${err.message}`);
      }
    }
    await this.store.flush();
    return total;
  }

  async backfillChannel(channel, since) {
    const sinceMs = since.getTime();
    let before;
    let count = 0;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
      if (!batch.size) break;
      let oldest = null;
      let reachedLimit = false;
      for (const message of batch.values()) {
        if (!oldest || message.createdTimestamp < oldest.createdTimestamp) oldest = message;
        if (message.createdTimestamp < sinceMs) {
          reachedLimit = true;
          continue;
        }
        if (!isTrackableMessage(message)) continue;
        this.store.recordMessage(message, 'backfill');
        count += 1;
      }
      if (reachedLimit || batch.size < 100 || this.stopped) break;
      before = oldest.id;
    }
    return count;
  }

  // ── Journal d'audit (sanctions, rôles, surnoms) ───────────────────────────

  async backfillAuditLog(guild, since) {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      this.logger.warn(`« ${guild.name} » : permission « Voir les logs du serveur » manquante, sanctions et rôles non récupérés`);
      return 0;
    }
    const sinceMs = since.getTime();
    let count = 0;
    for (const type of AUDIT_TYPES) {
      let before;
      for (;;) {
        const logs = await guild.fetchAuditLogs({ type, limit: 100, before });
        if (!logs.entries.size) break;
        let oldest = null;
        let reachedLimit = false;
        for (const entry of logs.entries.values()) {
          if (!oldest || entry.createdTimestamp < oldest.createdTimestamp) oldest = entry;
          if (entry.createdTimestamp < sinceMs) {
            reachedLimit = true;
            continue;
          }
          const parsed = parseAuditEntry(entry, guild.id, 'backfill');
          for (const record of parsed.moderation) await this.store.recordModeration(record);
          await this.store.recordRoleChanges(parsed.roles);
          await this.store.recordNameChanges(parsed.names);
          count += 1;
        }
        if (reachedLimit || logs.entries.size < 100 || this.stopped) break;
        before = oldest.id;
      }
    }
    return count;
  }

  // ── Courbe du nombre de membres ───────────────────────────────────────────

  /**
   * Reconstitue un point par heure : membres actuels − membres arrivés depuis.
   * Les départs antérieurs à l'arrivée du bot étant inconnus, ces points sont une estimation.
   */
  async backfillMemberCurve(guild, since) {
    const joinTimes = [...guild.members.cache.values()]
      .map((member) => member.joinedTimestamp)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const now = Date.now();
    const rows = [];
    let index = 0;
    for (let t = Math.ceil(since.getTime() / HOUR_MS) * HOUR_MS; t < now; t += HOUR_MS) {
      while (index < joinTimes.length && joinTimes[index] <= t) index += 1;
      const joinedAfter = joinTimes.length - index;
      rows.push([guild.id, new Date(t), Math.max(0, guild.memberCount - joinedAfter), null, null, null, 'backfill']);
    }
    await this.store.insertSnapshots(rows);
  }
}

module.exports = { BackfillService };
