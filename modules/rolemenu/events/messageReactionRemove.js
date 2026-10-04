'use strict';

const { Events } = require('discord.js');
const { parseEmoji, reactionKey } = require('../lib/safety');

module.exports = {
  event: Events.MessageReactionRemove,

  async execute(ctx, reaction, user) {
    if (user.bot) return;
    const guildId = reaction.message.guildId;
    if (!guildId || !ctx.modules.isEnabledFor('rolemenu', guildId)) return;
    const { rolemenu: service, engine } = ctx.services;
    const menuId = await service.reactionMenuIdByMessage(reaction.message.id);
    if (!menuId) return;
    const bundle = await service.bundle(menuId);
    if (!bundle || String(bundle.menu.guild_id) !== guildId) return;
    const key = reactionKey(reaction.emoji);
    const option = bundle.options.find((o) => parseEmoji(o.emoji)?.key === key);
    if (!option) return;
    const guild = ctx.client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
    if (!member) return;
    await engine.remove(member, bundle, option); // « retrait impossible » (menu non retirable) : le rôle reste, sans message
  },
};
