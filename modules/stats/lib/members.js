'use strict';

const { detectNitro } = require('./discordUtils');

function sameInstant(a, b) {
  if (!a || !b) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function userRow(user, now) {
  return [user.id, user.username, user.globalName ?? null, user.avatar ?? null, now, now];
}

function memberRow(member, now) {
  return [
    member.guild.id,
    member.id,
    member.nickname ?? null,
    member.avatar ?? null,
    member.joinedAt ?? null,
    null,
    1,
    member.premiumSince ?? null,
    detectNitro(member) ? 1 : 0,
    now,
  ];
}

/**
 * Synchronisation des membres, utilisateurs, salons et rôles entre Discord et MySQL.
 * Détecte aussi ce qui a changé pendant que le bot était hors ligne
 * (pseudos, arrivées, départs, boosts).
 */
class MemberSync {
  constructor({ store, logger }) {
    this.store = store;
    this.logger = logger;
    this.knownChannels = new Set();
  }

  async syncStructure(guild) {
    const now = new Date();
    const channels = [...guild.channels.cache.values()].map((channel) => [
      channel.id,
      guild.id,
      channel.parentId ?? null,
      channel.name.slice(0, 100),
      channel.type,
      0,
      now,
    ]);
    await this.store.upsertChannels(guild.id, channels, { markMissing: true });
    for (const row of channels) this.knownChannels.add(row[0]);

    const roles = [...guild.roles.cache.values()].map((role) => [
      role.id,
      guild.id,
      role.name.slice(0, 100),
      role.color,
      role.position,
      0,
      now,
    ]);
    await this.store.upsertRoles(guild.id, roles);
  }

  /** Enregistre un salon (ou fil) rencontré pour la première fois. */
  async ensureChannel(channel) {
    if (!channel?.guildId || this.knownChannels.has(channel.id)) return;
    this.knownChannels.add(channel.id);
    await this.store.upsertChannels(channel.guildId, [
      [channel.id, channel.guildId, channel.parentId ?? null, (channel.name ?? channel.id).slice(0, 100), channel.type, 0, new Date()],
    ]);
  }

  /**
   * Récupère tous les membres d'un serveur et met la base à jour.
   * @param joinsSince  les arrivées postérieures à cette date sont enregistrées (dédupliquées)
   * @param eventSource 'backfill' (rétroactivité) ou 'sync' (rattrapage au démarrage)
   */
  async syncGuild(guild, { joinsSince = null, eventSource = 'sync' } = {}) {
    const fetched = await guild.members.fetch();
    const humans = [...fetched.values()].filter((member) => !member.user.bot);
    const now = new Date();
    const since = joinsSince ? new Date(joinsSince).getTime() : null;

    const stored = await this.store.loadMembers(guild.id);
    const storedUsers = await this.store.loadUsers(humans.map((member) => member.id));

    const events = [];
    const names = [];
    const boostStarts = [];
    const boostEnds = [];

    for (const member of humans) {
      const previous = stored.get(member.id);
      const joinedAt = member.joinedAt;

      if (since !== null && joinedAt && joinedAt.getTime() >= since) {
        events.push([guild.id, member.id, 'join', joinedAt, eventSource]);
      }

      if (previous?.is_member) {
        if (previous.joined_at && joinedAt && !sameInstant(previous.joined_at, joinedAt)) {
          // Parti puis revenu pendant l'absence du bot : le départ n'a pas été vu.
          events.push([guild.id, member.id, 'leave', new Date(joinedAt.getTime() - 1000), 'sync']);
          events.push([guild.id, member.id, 'join', joinedAt, 'sync']);
        }
        if ((previous.nickname ?? null) !== (member.nickname ?? null)) {
          names.push([member.id, guild.id, 'nickname', previous.nickname ?? null, member.nickname ?? null, now, 'sync', null]);
        }
        if (previous.premium_since && !member.premiumSince) boostEnds.push(member.id);
      }
      if (member.premiumSince && !sameInstant(previous?.premium_since ?? null, member.premiumSince)) {
        boostStarts.push([member.id, member.premiumSince]);
      }

      const previousUser = storedUsers.get(member.id);
      if (previousUser) {
        if (previousUser.username !== member.user.username) {
          names.push([member.id, null, 'username', previousUser.username, member.user.username, now, 'sync', null]);
        }
        if ((previousUser.global_name ?? null) !== (member.user.globalName ?? null)) {
          names.push([member.id, null, 'global_name', previousUser.global_name ?? null, member.user.globalName ?? null, now, 'sync', null]);
        }
      }
    }

    const present = new Set(humans.map((member) => member.id));
    const departed = [];
    for (const [userId, previous] of stored) {
      if (previous.is_member && !present.has(userId) && !fetched.has(userId)) {
        departed.push(userId);
        events.push([guild.id, userId, 'leave', now, 'sync']);
        if (previous.premium_since) boostEnds.push(userId);
      }
    }

    await this.store.upsertUsers(humans.map((member) => userRow(member.user, now)));
    await this.store.upsertMembers(humans.map((member) => memberRow(member, now)));
    await this.store.markMembersLeft(guild.id, departed, now);
    await this.store.recordMemberEvents(events);
    await this.store.recordNameChanges(names);
    for (const [userId, startedAt] of boostStarts) await this.store.recordBoostStart(guild.id, userId, startedAt);
    for (const userId of boostEnds) await this.store.recordBoostEnd(guild.id, userId, now);

    this.logger.info(
      `${guild.name} : ${humans.length} membres synchronisés (${events.length} arrivées/départs, ${names.length} changements de pseudo)`,
    );
    return { members: humans.length, events: events.length, names: names.length };
  }

  /** Met à jour le profil global d'un utilisateur en historisant les changements de pseudo. */
  async trackUser(user, { previous = null, source = 'live' } = {}) {
    if (!user || user.bot) return;
    const now = new Date();
    const before = previous && !previous.partial ? previous : (await this.store.loadUsers([user.id])).get(user.id);
    const names = [];
    if (before) {
      const oldUsername = before.username;
      const oldGlobal = before.globalName !== undefined ? before.globalName : before.global_name;
      if (oldUsername && oldUsername !== user.username) {
        names.push([user.id, null, 'username', oldUsername, user.username, now, source, null]);
      }
      if ((oldGlobal ?? null) !== (user.globalName ?? null)) {
        names.push([user.id, null, 'global_name', oldGlobal ?? null, user.globalName ?? null, now, source, null]);
      }
    }
    await this.store.recordNameChanges(names);
    await this.store.upsertUsers([userRow(user, now)]);
  }

  async upsertMember(member) {
    const now = new Date();
    await this.store.upsertMembers([memberRow(member, now)]);
  }
}

module.exports = { MemberSync, memberRow, userRow };
