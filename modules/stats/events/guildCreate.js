'use strict';

const { Events } = require('discord.js');

/** Le bot rejoint un nouveau serveur : enregistrement puis rétroactivité. */
module.exports = {
  event: Events.GuildCreate,
  async execute(ctx, guild) {
    const { store, members, voice, backfill } = ctx.services;
    ctx.logger.info(`Nouveau serveur : ${guild.name} (${guild.id})`);
    await store.upsertGuild(guild);
    await store.setBackfillStatus(guild.id, 'pending');
    await members.syncStructure(guild);
    await voice.scanActive([guild]);
    backfill.enqueue(guild.id);
  },
};
