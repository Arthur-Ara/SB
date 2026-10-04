'use strict';

const { Events } = require('discord.js');
const { snapshotRole } = require('../lib/serialize');

/** Nombre maximal de porteurs mémorisés pour pouvoir leur rendre un rôle supprimé puis recréé. */
const MAX_HOLDERS = 500;

module.exports = {
  event: Events.GuildRoleDelete,

  async execute(ctx, role) {
    if (role.managed) return;
    const { journal } = ctx.services;
    if (journal.isPaused(role.guild.id)) return;
    const before = snapshotRole(role);
    before.members = [...role.members.keys()].slice(0, MAX_HOLDERS);
    await journal.record({
      guildId: role.guild.id,
      kind: 'role',
      op: 'delete',
      targetId: role.id,
      label: role.name,
      before,
    });
  },
};
