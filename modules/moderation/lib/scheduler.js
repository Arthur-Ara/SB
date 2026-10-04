'use strict';

const { isChannelLocked, unlockChannel } = require('./channelLock');

const SWEEP_MS = 60_000;

/**
 * Levées automatiques à l'échéance : mutes vocaux temporaires (/tempvocmute), bans temporaires
 * (/tempban, sanctions au cumul) et verrouillages avec durée (/lock duree). Une simple vérification
 * périodique en base (plutôt qu'un setTimeout par sanction) : ça survit à un redémarrage du bot et
 * évite la limite de setTimeout (~24,8 jours) pour les longues durées.
 */
class ModerationScheduler {
  constructor({ client, service, logs, logger }) {
    this.client = client;
    this.service = service;
    this.logs = logs;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const run = () => this.sweep().catch((err) => this.logger.error('Balayage des sanctions temporaires impossible', err));
    run();
    this.timer = setInterval(run, SWEEP_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep() {
    // Pas de chevauchement entre deux balayages (levée et log en double).
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const row of await this.service.dueTempVocMutes()) await this.liftVocMute(row);
      for (const row of await this.service.dueTempBans()) await this.liftTempBan(row);
      for (const row of await this.service.dueUnlocks()) await this.unlock(row);
    } finally {
      this.sweeping = false;
    }
  }

  async liftVocMute(row) {
    try {
      const guild = this.client.guilds.cache.get(row.guild_id);
      const member = guild ? await guild.members.fetch(row.target_id).catch(() => null) : null;
      if (member?.voice?.serverMute) await member.voice.setMute(false, 'Fin du mute vocal temporaire').catch(() => {});
      await this.service.resolve(row.id, null);
      if (guild) {
        await this.logs.action({
          guildId: guild.id,
          action: 'untempvocmute',
          targetId: row.target_id,
          executorId: this.client.user.id,
          reason: 'Levée automatique à l’échéance',
        });
      }
    } catch (err) {
      this.logger.warn(`Levée automatique du mute vocal de ${row.target_id} impossible`, err.message);
      // On marque quand même comme résolu pour ne pas retenter en boucle indéfiniment.
      await this.service.resolve(row.id, null).catch(() => {});
    }
  }

  async liftTempBan(row) {
    try {
      const guild = this.client.guilds.cache.get(row.guild_id);
      // Blacklisté entre-temps : le bannissement définitif prend le relais, on ne débannit pas.
      const blacklisted = await this.service.blacklistEntry(row.target_id);
      if (guild && !blacklisted) {
        const ban = await guild.bans.fetch({ user: row.target_id, force: true }).catch(() => null);
        if (ban) await guild.members.unban(row.target_id, 'Fin du bannissement temporaire');
      }
      await this.service.resolve(row.id, null);
      if (guild && !blacklisted) {
        await this.service.record({ guildId: guild.id, action: 'untempban', targetId: row.target_id, executorId: this.client.user.id, reason: `Fin du ban temporaire #${row.id}` });
        await this.logs.action({ guildId: guild.id, action: 'untempban', targetId: row.target_id, executorId: this.client.user.id, reason: 'Levée automatique à l’échéance' });
      }
    } catch (err) {
      this.logger.warn(`Levée automatique du ban temporaire de ${row.target_id} impossible`, err.message);
      await this.service.resolve(row.id, null).catch(() => {});
    }
  }

  async unlock(row) {
    try {
      const guild = this.client.guilds.cache.get(row.guild_id);
      const channel = guild?.channels.cache.get(row.channel_id);
      if (!channel || !isChannelLocked(channel)) {
        await this.service.clearLockState(row.guild_id, row.channel_id);
        return;
      }
      const reason = 'Fin du verrouillage temporaire';
      await unlockChannel(this.service, channel, this.client.user.id, reason);
      await this.service.record({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: this.client.user.id, reason });
      await this.logs.action({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: this.client.user.id, reason });
    } catch (err) {
      this.logger.warn(`Déverrouillage automatique du salon ${row.channel_id} impossible`, err.message);
      await this.service.setUnlockAt(row.guild_id, row.channel_id, null).catch(() => {});
    }
  }
}

module.exports = { ModerationScheduler };
