'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.VoiceStateUpdate,
  async execute(ctx, oldState, newState) {
    await ctx.services.voice.handleUpdate(oldState, newState);
  },
};
