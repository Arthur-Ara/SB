'use strict';

const { Events } = require('discord.js');
const { TRACKED_CHANNEL_TYPES, snapshotChannel } = require('../lib/serialize');

module.exports = {
  event: Events.ChannelCreate,

  async execute(ctx, channel) {
    if (!channel.guild || !TRACKED_CHANNEL_TYPES.has(channel.type)) return;
    const { journal } = ctx.services;
    if (journal.isPaused(channel.guild.id)) return;
    await journal.record({
      guildId: channel.guild.id,
      kind: 'channel',
      op: 'create',
      targetId: channel.id,
      label: channel.name,
      after: snapshotChannel(channel),
    });
  },
};
