'use strict';

/**
 * Déplacements automatiques : quand un maître et un membre en laisse sont tous deux en vocal,
 * ils sont toujours dans le même salon.
 *  - le maître rejoint / change de salon → ses membres en laisse (déjà en vocal) le suivent ;
 *  - un membre en laisse rejoint / change de salon → il est ramené auprès de son maître.
 * Les membres immunisés restent dans les listes mais ne sont jamais déplacés.
 * Les déplacements faits par le bot déclenchent à leur tour ces règles, ce qui gère les chaînes
 * (A tient B qui tient C) ; les boucles sont impossibles (refusées à l'ajout).
 */
class LeashMover {
  constructor({ service, logs, logger }) {
    this.service = service;
    this.logs = logs;
    this.logger = logger;
  }

  channelOf(guild, userId) {
    return guild.voiceStates.cache.get(userId)?.channelId ?? null;
  }

  async onVoiceStateUpdate(oldState, newState) {
    const before = oldState.channelId;
    const after = newState.channelId;
    if (before === after || !after) return; // mute, caméra, ou départ du vocal : rien à faire
    const { guild } = newState;
    const userId = newState.id;
    const state = await this.service.state(guild.id);

    // 1. Il tient des membres en laisse : ceux qui sont en vocal le suivent.
    for (const leashedId of this.service.listOf(state, userId)) {
      if (this.service.member(state, leashedId).immune) continue;
      const current = this.channelOf(guild, leashedId);
      if (!current || current === after) continue;
      const reason = before ? `<@${userId}> vient de s’y déplacer` : `<@${userId}> vient de le rejoindre`;
      await this.move(guild, leashedId, after, `<@${leashedId}> a été déplacé dans <#${after}> car ${reason}.`);
    }

    // 2. Il est en laisse : il reste avec son maître.
    const link = state.links.get(userId);
    if (!link || this.service.member(state, userId).immune) return;
    const leasherChannel = this.channelOf(guild, link.leasherId);
    if (!leasherChannel || leasherChannel === after) return;
    const action = before ? `a tenté d’aller dans <#${after}>` : `a rejoint <#${after}>`;
    await this.move(
      guild,
      userId,
      leasherChannel,
      `<@${userId}> a été ramené dans <#${leasherChannel}> car il ${action} alors que <@${link.leasherId}>, qui le tient en laisse, est dans <#${leasherChannel}>.`,
    );
  }

  /** Après un ajout en laisse : rapproche immédiatement les deux membres s'ils sont en vocal. */
  async syncPair(guild, leashedId, leasherId) {
    const state = await this.service.state(guild.id);
    if (this.service.member(state, leashedId).immune) return;
    const target = this.channelOf(guild, leasherId);
    const current = this.channelOf(guild, leashedId);
    if (!target || !current || target === current) return;
    await this.move(guild, leashedId, target, `<@${leashedId}> a été déplacé dans <#${target}> car <@${leasherId}> vient de le mettre en laisse.`);
  }

  async move(guild, userId, channelId, logText) {
    try {
      await guild.members.edit(userId, { channel: channelId, reason: 'Module Laisse' });
      await this.logs.move(guild.id, logText);
    } catch (err) {
      this.logger.warn(`Déplacement de ${userId} impossible sur ${guild.name}`, err.message);
      await this.logs.error(
        guild.id,
        `Impossible de déplacer <@${userId}> dans <#${channelId}> : ${err.message}. Le bot a-t-il la permission « Déplacer des membres » ?`,
      );
    }
  }
}

module.exports = { LeashMover };
