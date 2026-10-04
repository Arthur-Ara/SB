'use strict';

const { Events } = require('discord.js');
const { isTrackableMessage } = require('../lib/discordUtils');

module.exports = {
  event: Events.MessageCreate,
  async execute(ctx, message) {
    if (!isTrackableMessage(message)) return;
    ctx.services.store.recordMessage(message, 'live');
    await ctx.services.members.ensureChannel(message.channel);
  },
};
