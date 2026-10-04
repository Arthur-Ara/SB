'use strict';

const { Events } = require('discord.js');
const { snapshotRole } = require('../lib/serialize');

module.exports = {
  event: Events.GuildRoleCreate,

  async execute(ctx, role) {
    if (role.managed) return; // rôle d'intégration (bot, boost) : jamais touché
    const { journal } = ctx.services;
    if (journal.isPaused(role.guild.id)) return;
    await journal.record({
      guildId: role.guild.id,
      kind: 'role',
      op: 'create',
      targetId: role.id,
      label: role.name,
      after: snapshotRole(role),
    });
  },
};
