'use strict';

const { Events } = require('discord.js');

/** Le bot a quitté (ou a été retiré d'un) serveur : les données sont conservées. */
module.exports = {
  event: Events.GuildDelete,
  async execute(ctx, guild) {
    if (guild.available === false) return; // panne Discord, pas un départ
    const { store, voice } = ctx.services;
    ctx.logger.info(`Serveur quitté : ${guild.name ?? guild.id}`);
    await store.markGuildAbsent(guild.id);
    await voice.closeGuild(guild.id);
  },
};
