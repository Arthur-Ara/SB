'use strict';

const { Events } = require('discord.js');
const { isFinal } = require('../lib/statuses');
const { setStatus } = require('../lib/lifecycle');

/**
 * Salon supprimé hors du bot : la candidature et sa transcription sont conservées. Si elle était encore en cours,
 * elle est clôturée comme « retirée » (sinon le candidat serait bloqué par « candidature déjà en cours »).
 */
module.exports = {
  event: Events.ChannelDelete,

  async execute(ctx, channel) {
    if (!channel.guild || !ctx.services.candidatures.isCandidatureChannel(channel.id)) return;
    const { candidatures } = ctx.services;
    const candidature = await candidatures.getByChannel(channel.id);
    if (!candidature || Number(candidature.channel_deleted)) return;
    if (!isFinal(candidature.status)) {
      const category = await candidatures.getCategory(candidature.category_id);
      await setStatus(ctx, { candidature, category, guild: channel.guild, channel: null, status: 'withdrawn', reason: 'Salon supprimé manuellement.', by: null });
    }
    await candidatures.markChannelDeleted(candidature.id);
  },
};
