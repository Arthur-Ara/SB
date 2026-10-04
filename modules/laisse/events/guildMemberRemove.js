'use strict';

const { Events } = require('discord.js');

/** Un membre quitte le serveur : il sort de la liste où il était, et sa propre liste est vidée. */
module.exports = {
  event: Events.GuildMemberRemove,
  async execute(ctx, member) {
    const { leash, logs } = ctx.services;
    const guildId = member.guild.id;
    const link = await leash.removeLink(guildId, member.id);
    const released = await leash.clearList(guildId, member.id);
    if (link) await logs.move(guildId, `<@${member.id}> a quitté le serveur : retiré de la laisse de <@${link.leasherId}>.`);
    if (released.length) {
      await logs.move(guildId, `<@${member.id}> a quitté le serveur : sa laisse (${released.map((id) => `<@${id}>`).join(', ')}) a été vidée.`);
    }
  },
};
