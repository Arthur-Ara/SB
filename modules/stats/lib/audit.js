'use strict';

const { AuditLogEvent } = require('discord.js');

/** Types d'entrées du journal d'audit exploités par le module. */
const AUDIT_TYPES = [
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberRoleUpdate,
];

function changesOf(entry) {
  return Array.isArray(entry.changes) ? entry.changes : [];
}

/**
 * Traduit une entrée du journal d'audit en lignes pour la base.
 * Renvoie { moderation: [], roles: [], names: [] } (tableaux éventuellement vides).
 */
function parseAuditEntry(entry, guildId, source) {
  const targetId = entry.targetId ?? entry.target?.id ?? null;
  const executorId = entry.executorId ?? entry.executor?.id ?? null;
  const createdAt = entry.createdAt;
  const result = { moderation: [], roles: [], names: [] };
  if (!targetId) return result;

  const base = { guildId, targetId, executorId, reason: entry.reason ?? null, createdAt, auditLogId: entry.id, source };

  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      result.moderation.push({ ...base, action: 'ban' });
      break;

    case AuditLogEvent.MemberKick:
      result.moderation.push({ ...base, action: 'kick' });
      break;

    case AuditLogEvent.MemberUpdate:
      for (const change of changesOf(entry)) {
        if (change.key === 'communication_disabled_until' && change.new) {
          const expiresAt = new Date(change.new);
          if (!Number.isNaN(expiresAt.getTime()) && expiresAt > createdAt) {
            result.moderation.push({ ...base, action: 'timeout', expiresAt });
          }
        }
        if (change.key === 'nick') {
          result.names.push([targetId, guildId, 'nickname', change.old ?? null, change.new ?? null, createdAt, source, entry.id]);
        }
      }
      break;

    case AuditLogEvent.MemberRoleUpdate:
      for (const change of changesOf(entry)) {
        const action = change.key === '$add' ? 'add' : change.key === '$remove' ? 'remove' : null;
        if (!action) continue;
        for (const role of change.new ?? []) {
          result.roles.push([guildId, targetId, role.id, action, executorId, createdAt, source, entry.id]);
        }
      }
      break;

    default:
      break;
  }
  return result;
}

module.exports = { AUDIT_TYPES, parseAuditEntry };
