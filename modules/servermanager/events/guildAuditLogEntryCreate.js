'use strict';

const { AuditLogEvent, Events } = require('discord.js');

/** Entrées du journal d'audit qui désignent l'auteur d'une modification de salon ou de rôle. */
const KIND_OF_ACTION = new Map([
  [AuditLogEvent.ChannelCreate, 'channel'],
  [AuditLogEvent.ChannelUpdate, 'channel'],
  [AuditLogEvent.ChannelDelete, 'channel'],
  [AuditLogEvent.ChannelOverwriteCreate, 'channel'],
  [AuditLogEvent.ChannelOverwriteUpdate, 'channel'],
  [AuditLogEvent.ChannelOverwriteDelete, 'channel'],
  [AuditLogEvent.RoleCreate, 'role'],
  [AuditLogEvent.RoleUpdate, 'role'],
  [AuditLogEvent.RoleDelete, 'role'],
]);

module.exports = {
  event: Events.GuildAuditLogEntryCreate,

  async execute(ctx, entry, guild) {
    const { journal } = ctx.services;
    if (!entry.executorId || !entry.targetId) return;

    const kind = KIND_OF_ACTION.get(entry.action);
    if (kind) {
      journal.rememberAudit(kind, entry.targetId, entry.executorId);
      await journal.attachExecutor(guild.id, kind, entry.targetId, entry.executorId);
      return;
    }

    // Rôles ajoutés / retirés à un membre : le journal d'audit est la source (pas besoin du cache des membres).
    if (entry.action === AuditLogEvent.MemberRoleUpdate) {
      if (journal.isPaused(guild.id)) return;
      for (const change of entry.changes ?? []) {
        if (change.key !== '$add' && change.key !== '$remove') continue;
        for (const role of change.new ?? []) {
          await journal.record({
            guildId: guild.id,
            kind: 'member_role',
            op: change.key === '$add' ? 'add' : 'remove',
            targetId: entry.targetId,
            roleId: role.id,
            executorId: entry.executorId,
            label: role.name ?? '',
          });
        }
      }
    }
  },
};
