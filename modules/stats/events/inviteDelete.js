'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.InviteDelete,
  async execute(ctx, invite) {
    await ctx.services.invites.onInviteDelete(invite);
  },
};
