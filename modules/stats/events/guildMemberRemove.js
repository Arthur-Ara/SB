'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.GuildMemberRemove,
  async execute(ctx, member) {
    if (member.user?.bot) return;
    const { store, voice } = ctx.services;
    const guildId = member.guild.id;
    const now = new Date();
    await store.markMembersLeft(guildId, [member.id], now);
    await store.recordMemberEvents([[guildId, member.id, 'leave', now, 'live']]);
    await store.recordBoostEnd(guildId, member.id, now);
    await voice.close(guildId, member.id, now);
    await ctx.services.invites.onMemberRemove(member).catch(() => {});
  },
};
