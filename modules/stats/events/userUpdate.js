'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.UserUpdate,
  async execute(ctx, oldUser, newUser) {
    if (newUser.bot) return;
    await ctx.services.members.trackUser(newUser, { previous: oldUser, source: 'live' });
  },
};
