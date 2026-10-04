'use strict';

const { isModuleAdmin } = require('./access');
const { KeyedMutex } = require('../../../src/core/keyedMutex');

/**
 * Applique la whitelist et la limite de slots en temps réel : à chaque arrivée dans un salon
 * configuré, expulse le membre s'il n'est pas autorisé ou si le salon est plein.
 *
 * Rien n'est appliqué hors de la plage horaire du salon (s'il en a une). Au début de la plage et à la fin
 * d'un accès temporaire, les membres présents sont revérifiés (balayage minute, voir sweep()).
 *
 * Exemptions (whitelist ET limite de slots) :
 *  - les bots ;
 *  - les admins du module (voir lib/access.js) et les admins de ce salon ;
 *  - les membres actuellement en laisse dont le maître est présent dans le même salon — leur
 *    présence vient du module Laisse, pas d'une démarche volontaire (lu en direct via
 *    `ctx.modules.services('laisse')`, sans aucune dépendance obligatoire à ce module).
 *
 * Un verrou par salon (KeyedMutex) évite que deux arrivées simultanées ne soient comptées au
 * même instant et ne provoquent des expulsions en double.
 */
class WhitelistEnforcer {
  constructor({ ctx, service, logs, logger }) {
    this.ctx = ctx;
    this.service = service;
    this.logs = logs;
    this.logger = logger;
    this.mutex = new KeyedMutex();
  }

  async onVoiceStateUpdate(oldState, newState) {
    const channelId = newState.channelId;
    if (!channelId || channelId === oldState.channelId) return; // pas une arrivée/déplacement dans un nouveau salon
    const member = newState.member;
    if (!member || member.user.bot) return;

    const state = await this.service.state(newState.guild.id);
    const config = this.service.channelConfig(state, channelId);
    if (!this.service.isConfigured(config)) return; // salon non configuré : rien à faire
    if (!this.service.isActiveNow(config)) return; // hors de la plage horaire : salon ouvert

    await this.mutex.run(channelId, () => this.check(newState.guild, member, channelId, config, state));
  }

  /**
   * Revérifie tous les membres présents dans un salon (début de la plage horaire, fin d'un accès temporaire,
   * configuration modifiée) : ceux qui ne sont plus autorisés, ou en trop, sont déconnectés.
   */
  async enforceChannel(guild, channelId) {
    const state = await this.service.state(guild.id);
    const config = this.service.channelConfig(state, channelId);
    if (!this.service.isConfigured(config) || !this.service.isActiveNow(config)) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;
    // Les derniers arrivés partent en premier quand la limite est dépassée.
    const members = [...channel.members.values()].sort((a, b) => (a.voice?.joinedTimestamp ?? 0) - (b.voice?.joinedTimestamp ?? 0));
    for (const member of members) {
      await this.mutex.run(channelId, () => this.check(guild, member, channelId, config, state));
    }
  }

  /**
   * Balayage minute : accès temporaires échus (le membre est revérifié s'il est dans le salon) et salons
   * dont la plage horaire vient de commencer (tous les présents sont revérifiés).
   */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const invite of await this.service.takeExpiredInvites()) {
        const guild = this.ctx.client.guilds.cache.get(invite.guildId);
        if (!guild || !this.ctx.modules.isEnabledFor('whitelist', guild.id)) continue;
        await this.logs.inviteExpired(guild.id, invite.userId, invite.channelId).catch(() => {});
        const voice = guild.voiceStates.cache.get(invite.userId);
        if (voice?.channelId === invite.channelId && voice.member) {
          const state = await this.service.state(guild.id);
          const config = this.service.channelConfig(state, invite.channelId);
          if (this.service.isConfigured(config) && this.service.isActiveNow(config)) {
            await this.mutex.run(invite.channelId, () => this.check(guild, voice.member, invite.channelId, config, state));
          }
        }
      }

      if (!this.lastActive) this.lastActive = new Map();
      for (const guild of this.ctx.client.guilds.cache.values()) {
        if (!this.ctx.modules.isEnabledFor('whitelist', guild.id)) continue;
        const state = await this.service.state(guild.id);
        for (const [channelId, config] of state.channels) {
          if (!config.schedule.scheduleEnabled || !this.service.isConfigured(config)) continue;
          const key = `${guild.id}:${channelId}`;
          const active = this.service.isActiveNow(config);
          const was = this.lastActive.get(key);
          this.lastActive.set(key, active);
          if (active && was === false) await this.enforceChannel(guild, channelId);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  start() {
    if (this.timer) return;
    const run = () => this.sweep().catch((err) => this.logger.error('Balayage de la whitelist vocale impossible', err));
    run();
    this.timer = setInterval(run, 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Membres actuellement en laisse dont le maître est dans `channelId` (lecture seule, cache local à cette vérification). */
  async leashPresentSet(guild, channelId) {
    if (!this.ctx.modules.isEnabledFor('laisse', guild.id)) return null;
    const leash = this.ctx.modules.services('laisse')?.leash;
    if (!leash) return null;
    const leashState = await leash.state(guild.id);
    const present = new Set();
    for (const [leashedId, link] of leashState.links) {
      if (guild.voiceStates.cache.get(link.leasherId)?.channelId === channelId) present.add(leashedId);
    }
    return present;
  }

  isExempt(state, member, leashPresent, config) {
    if (member.user.bot) return true;
    if (isModuleAdmin(this.ctx, member, state)) return true;
    if (config && this.service.isChannelAdmin(config, member.id)) return true;
    if (leashPresent?.has(member.id)) return true;
    return false;
  }

  async check(guild, member, channelId, config, state) {
    // Revérifie que le membre est toujours là (une autre tâche a pu le faire partir entre-temps).
    const voiceState = guild.voiceStates.cache.get(member.id);
    if (!voiceState || voiceState.channelId !== channelId) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    const leashPresent = await this.leashPresentSet(guild, channelId);
    if (this.isExempt(state, member, leashPresent, config)) return;

    if (config.enabled && !this.service.isWhitelisted(config, member)) {
      await this.kick(guild, member, channel, 'not_whitelisted');
      return;
    }

    if (config.slotLimit !== null) {
      let count = 0;
      for (const other of channel.members.values()) {
        if (!this.isExempt(state, other, leashPresent, config)) count += 1;
      }
      if (count > config.slotLimit) await this.kick(guild, member, channel, 'slot_limit');
    }
  }

  async kick(guild, member, channel, reason) {
    try {
      await member.voice.disconnect(reason === 'not_whitelisted' ? 'Whitelist : non autorisé' : 'Whitelist : salon complet');
      await this.logs.kick(guild.id, member, channel, reason);
    } catch (err) {
      this.logger.warn(`Déconnexion de ${member.id} impossible sur #${channel.name}`, err.message);
    }
  }
}

module.exports = { WhitelistEnforcer };
