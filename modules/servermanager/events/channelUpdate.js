'use strict';

const { Events } = require('discord.js');
const { TRACKED_CHANNEL_TYPES, snapshotChannel, channelsDiffer } = require('../lib/serialize');

module.exports = {
  event: Events.ChannelUpdate,

  async execute(ctx, oldChannel, newChannel) {
    if (!newChannel.guild || !TRACKED_CHANNEL_TYPES.has(newChannel.type)) return;
    const { journal } = ctx.services;
    if (journal.isPaused(newChannel.guild.id) || ctx.services.isTicketChannel(newChannel.id)) return;
    const before = snapshotChannel(oldChannel);
    const after = snapshotChannel(newChannel);
    if (!channelsDiffer(before, after)) return; // simple changement de position : non suivi
    await journal.record({
      guildId: newChannel.guild.id,
      kind: 'channel',
      op: 'update',
      targetId: newChannel.id,
      label: before.name,
      before,
      after,
    });
  },
};
