'use strict';

const { Events } = require('discord.js');
const { TRACKED_CHANNEL_TYPES, snapshotChannel } = require('../lib/serialize');

module.exports = {
  event: Events.ChannelDelete,

  async execute(ctx, channel) {
    if (!channel.guild || !TRACKED_CHANNEL_TYPES.has(channel.type)) return;
    const { journal } = ctx.services;
    if (journal.isPaused(channel.guild.id) || ctx.services.isTicketChannel(channel.id)) return;
    await journal.record({
      guildId: channel.guild.id,
      kind: 'channel',
      op: 'delete',
      targetId: channel.id,
      label: channel.name,
      before: snapshotChannel(channel),
    });
  },
};
