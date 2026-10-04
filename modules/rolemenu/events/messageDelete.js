'use strict';

const { Events } = require('discord.js');

/** Le message d'un menu supprimé à la main : le menu repasse en « non publié » (les clics n'attribuent plus rien). */
module.exports = {
  event: Events.MessageDelete,

  async execute(ctx, message) {
    await ctx.services.rolemenu.clearMenuMessage(message.id);
  },
};
