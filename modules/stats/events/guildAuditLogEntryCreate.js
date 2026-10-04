'use strict';

const { Events } = require('discord.js');
const { parseAuditEntry } = require('../lib/audit');

module.exports = {
  event: Events.GuildAuditLogEntryCreate,
  async execute(ctx, entry, guild) {
    const { store } = ctx.services;
    const parsed = parseAuditEntry(entry, guild.id, 'live');

    // Bannissements, expulsions, exclusions temporaires
    for (const record of parsed.moderation) await store.recordModeration(record);

    // Les changements de rôles sont déjà historisés par guildMemberUpdate : on complète leur auteur.
    // (Les surnoms le sont aussi : les entrées "nick" sont ignorées ici pour éviter les doublons.)
    for (const [guildId, userId, roleId, action, executorId] of parsed.roles) {
      if (!executorId) continue;
      const change = { guildId, userId, roleId, action, executorId, auditLogId: entry.id, around: entry.createdAt };
      const updated = await store.attachRoleExecutor(change);
      if (!updated) {
        // L'entrée d'audit peut précéder l'événement de mise à jour du membre : nouvel essai différé.
        setTimeout(() => store.attachRoleExecutor(change).catch(() => {}), 3000).unref();
      }
    }
  },
};
