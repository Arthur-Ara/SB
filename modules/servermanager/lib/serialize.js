'use strict';

/**
 * Instantanés (JSON) des salons et des rôles : c'est ce qui permet de restaurer l'état d'avant une
 * modification, y compris après une suppression. Les positions sont volontairement absentes des
 * comparaisons (Discord les recalcule en cascade à chaque déplacement) : elles ne servent qu'à
 * replacer un salon ou un rôle recréé.
 */

// Texte, vocal, catégorie, annonces, conférence, forum, média.
const TRACKED_CHANNEL_TYPES = new Set([0, 2, 4, 5, 13, 15, 16]);
const CHANNEL_FIELDS = ['name', 'topic', 'nsfw', 'rateLimitPerUser', 'bitrate', 'userLimit', 'parentId'];
const ROLE_FIELDS = ['name', 'color', 'hoist', 'mentionable', 'permissions'];

/** Type d'une dérogation de permissions (OverwriteType) : 0 = rôle, 1 = membre. */
const OVERWRITE_ROLE = 0;

function snapshotChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    topic: channel.topic ?? null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    position: channel.rawPosition ?? 0,
    overwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    })),
  };
}

function snapshotRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: Boolean(role.hoist),
    mentionable: Boolean(role.mentionable),
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
    managed: Boolean(role.managed),
  };
}

function overwritesKey(list) {
  return JSON.stringify(
    [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((o) => [o.id, o.type, o.allow, o.deny]),
  );
}

/** Vrai si une modification suivie (hors position) sépare les deux instantanés. */
function channelsDiffer(before, after) {
  if (CHANNEL_FIELDS.some((field) => before[field] !== after[field])) return true;
  return overwritesKey(before.overwrites) !== overwritesKey(after.overwrites);
}

function rolesDiffer(before, after) {
  return ROLE_FIELDS.some((field) => before[field] !== after[field]);
}

module.exports = {
  TRACKED_CHANNEL_TYPES,
  CHANNEL_FIELDS,
  ROLE_FIELDS,
  OVERWRITE_ROLE,
  snapshotChannel,
  snapshotRole,
  channelsDiffer,
  rolesDiffer,
};
