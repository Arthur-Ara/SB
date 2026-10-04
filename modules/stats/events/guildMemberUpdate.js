'use strict';

const { Events } = require('discord.js');

function sameInstant(a, b) {
  if (!a || !b) return !a && !b;
  return new Date(a).getTime() === new Date(b).getTime();
}

module.exports = {
  event: Events.GuildMemberUpdate,
  async execute(ctx, oldMember, newMember) {
    if (newMember.user.bot) return;
    const { store, members } = ctx.services;
    const guildId = newMember.guild.id;
    const userId = newMember.id;
    const now = new Date();

    // Ancien état : depuis le cache discord.js, sinon depuis la base.
    let previousNickname;
    let previousPremium;
    if (oldMember.partial) {
      const stored = await store.loadMember(guildId, userId);
      previousNickname = stored ? stored.nickname ?? null : undefined;
      previousPremium = stored?.premium_since ?? null;
    } else {
      previousNickname = oldMember.nickname ?? null;
      previousPremium = oldMember.premiumSince ?? null;
    }

    // Surnom local
    const nickname = newMember.nickname ?? null;
    if (previousNickname !== undefined && previousNickname !== nickname) {
      await store.recordNameChanges([[userId, guildId, 'nickname', previousNickname, nickname, now, 'live', null]]);
    }

    // Rôles (l'auteur du changement est complété par le journal d'audit)
    if (!oldMember.partial) {
      const rows = [];
      for (const role of newMember.roles.cache.values()) {
        if (role.id !== guildId && !oldMember.roles.cache.has(role.id)) {
          rows.push([guildId, userId, role.id, 'add', null, now, 'live', null]);
        }
      }
      for (const role of oldMember.roles.cache.values()) {
        if (role.id !== guildId && !newMember.roles.cache.has(role.id)) {
          rows.push([guildId, userId, role.id, 'remove', null, now, 'live', null]);
        }
      }
      await store.recordRoleChanges(rows);
    }

    // Boost
    const premium = newMember.premiumSince ?? null;
    if (!sameInstant(previousPremium, premium)) {
      if (premium) await store.recordBoostStart(guildId, userId, premium);
      else await store.recordBoostEnd(guildId, userId, now);
    }

    await members.upsertMember(newMember);
  },
};
