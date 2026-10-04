'use strict';

const { Events } = require('discord.js');
const { snapshotRole, rolesDiffer } = require('../lib/serialize');

module.exports = {
  event: Events.GuildRoleUpdate,

  async execute(ctx, oldRole, newRole) {
    if (newRole.managed) return;
    const { journal } = ctx.services;
    if (journal.isPaused(newRole.guild.id)) return;
    const before = snapshotRole(oldRole);
    const after = snapshotRole(newRole);
    if (!rolesDiffer(before, after)) return; // simple changement de position : non suivi
    await journal.record({
      guildId: newRole.guild.id,
      kind: 'role',
      op: 'update',
      targetId: newRole.id,
      label: before.name,
      before,
      after,
    });
  },
};
