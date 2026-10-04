'use strict';

const { Events } = require('discord.js');
const automod = require('./automod');

/** Un message modifié après coup passe aussi par l'automod (sinon il suffirait d'éditer pour contourner). */
module.exports = {
  event: Events.MessageUpdate,

  async execute(ctx, oldMessage, newMessage) {
    if (!newMessage.guild || oldMessage.content === newMessage.content) return;
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (message) await automod.execute(ctx, message);
  },
};
