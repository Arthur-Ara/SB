'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.GuildMemberAdd,
  async execute(ctx, member) {
    if (member.user.bot) return;
    const { store, members, invites } = ctx.services;
    await members.trackUser(member.user);
    await members.upsertMember(member);
    await store.recordMemberEvents([[member.guild.id, member.id, 'join', member.joinedAt ?? new Date(), 'live']]);
    await invites.onMemberAdd(member).catch((err) => ctx.logger.warn('Attribution de l’invitation impossible', err.message));
  },
};
