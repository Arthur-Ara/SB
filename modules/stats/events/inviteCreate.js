'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.InviteCreate,
  async execute(ctx, invite) {
    await ctx.services.invites.onInviteCreate(invite);
  },
};
