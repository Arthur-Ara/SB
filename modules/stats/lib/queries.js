'use strict';

const { bucketSql, buildBuckets, bucketIndexAt, fill, resolveInterval } = require('./buckets');
const { avatarUrl, guildIconUrl, num, detectNitro } = require('./discordUtils');

const DAY_S = 86_400;
const DISCORD_EPOCH = 1_420_070_400_000n;
const THREAD_TYPES = new Set([10, 11, 12]);

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toDate(value) {
  return value ? new Date(value) : null;
}

function snowflakeDate(id) {
  try {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
  } catch {
    return null;
  }
}

function roleColor(color) {
  const value = num(color);
  return value ? `#${value.toString(16).padStart(6, '0')}` : null;
}

/** Temps (en s) passé en vocal dans [from, to[, calculé en SQL. Paramètres : from, now, to. */
const VOICE_OVERLAP_SQL = `GREATEST(0, TIMESTAMPDIFF(SECOND,
  GREATEST(joined_at, CAST(? AS DATETIME(3))),
  LEAST(COALESCE(left_at, CAST(? AS DATETIME(3))), CAST(? AS DATETIME(3)))))`;

/**
 * Normalise une période d'analyse.
 * @returns {{ guildId, from: Date, to: Date, offset: number, interval: string, buckets: object }}
 */
function createScope({ guildId, from, to, interval = 'auto', offset = 0 }) {
  const effective = resolveInterval(interval, from, to);
  return { guildId, from, to, offset, interval: effective, buckets: buildBuckets(from, to, effective, offset) };
}

/** Requêtes d'agrégation (dashboard web et slash commands). */
class StatsQueries {
  constructor({ db, client }) {
    this.db = db;
    this.client = client;
  }

  // ── Serveurs ──────────────────────────────────────────────────────────────

  async guilds() {
    const rows = await this.db.query(
      `SELECT id, name, icon, backfill_status, backfilled_at, tracking_since
         FROM stats_guilds WHERE is_present = 1 ORDER BY name`,
    );
    return rows.map((row) => {
      const live = this.client.guilds.cache.get(row.id);
      return {
        id: row.id,
        name: live?.name ?? row.name,
        icon: guildIconUrl(row.id, live?.icon ?? row.icon),
        memberCount: live?.memberCount ?? null,
        backfillStatus: row.backfill_status,
        trackingSince: toDate(row.tracking_since),
      };
    });
  }

  async guildExists(guildId) {
    return Boolean(await this.db.one('SELECT id FROM stats_guilds WHERE id = ?', [guildId]));
  }

  // ── Séries temporelles ────────────────────────────────────────────────────

  messageBuckets(q, userId = null) {
    const params = [q.guildId, q.from, q.to];
    let where = 'guild_id = ? AND created_at >= ? AND created_at < ?';
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    return this.db.query(
      `SELECT ${bucketSql('created_at', q.interval, q.offset)} AS k,
              COUNT(*) AS messages,
              COUNT(DISTINCT user_id) AS authors,
              AVG(NULLIF(length, 0)) AS avg_length,
              SUM(mentions_everyone) AS everyone,
              SUM(mentions_here) AS here
         FROM stats_messages WHERE ${where} GROUP BY k`,
      params,
    );
  }

  deletionBuckets(q) {
    return this.db.query(
      `SELECT ${bucketSql('deleted_at', q.interval, q.offset)} AS k, COUNT(*) AS n
         FROM stats_message_deletions WHERE guild_id = ? AND deleted_at >= ? AND deleted_at < ? GROUP BY k`,
      [q.guildId, q.from, q.to],
    );
  }

  memberEventBuckets(q) {
    return this.db.query(
      `SELECT ${bucketSql('created_at', q.interval, q.offset)} AS k, type, COUNT(*) AS n
         FROM stats_member_events WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY k, type`,
      [q.guildId, q.from, q.to],
    );
  }

  moderationBuckets(q) {
    return this.db.query(
      `SELECT ${bucketSql('created_at', q.interval, q.offset)} AS k, action, COUNT(*) AS n
         FROM stats_moderation_actions WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY k, action`,
      [q.guildId, q.from, q.to],
    );
  }

  /** Nombre total de membres : dernier instantané connu à la fin de chaque intervalle. */
  async memberCurve(q) {
    const { guildId, from, to, buckets } = q;
    const [before, inside] = await Promise.all([
      this.db.one(
        `SELECT taken_at, member_count FROM stats_guild_snapshots
          WHERE guild_id = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 1`,
        [guildId, from],
      ),
      this.db.query(
        `SELECT taken_at, member_count FROM stats_guild_snapshots
          WHERE guild_id = ? AND taken_at >= ? AND taken_at < ? ORDER BY taken_at`,
        [guildId, from, to],
      ),
    ]);
    const points = (before ? [before, ...inside] : inside).map((row) => ({
      t: new Date(row.taken_at).getTime(),
      v: num(row.member_count),
    }));
    const live = this.client.guilds.cache.get(guildId);
    const now = Date.now();
    if (live && to.getTime() >= now - 60_000) points.push({ t: Math.min(now, to.getTime() - 1), v: live.memberCount });

    const values = new Array(buckets.keys.length).fill(null);
    let j = 0;
    let last = null;
    for (let i = 0; i < values.length; i += 1) {
      if (buckets.starts[i] > now) break; // pas de valeur dans le futur
      while (j < points.length && points[j].t < buckets.ends[i]) {
        last = points[j].v;
        j += 1;
      }
      values[i] = last;
    }
    return values;
  }

  /** Heures de vocal et membres distincts par intervalle (les sessions sont réparties au prorata). */
  async voiceBuckets(q, userId = null) {
    const { guildId, from, to, buckets } = q;
    const params = [guildId, to, from];
    let sql = `SELECT user_id, joined_at, left_at FROM stats_voice_sessions
                WHERE guild_id = ? AND joined_at < ? AND (left_at IS NULL OR left_at > ?)`;
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    const rows = await this.db.query(sql, params);

    const n = buckets.keys.length;
    const seconds = new Array(n).fill(0);
    const users = Array.from({ length: n }, () => new Set());
    const distinct = new Set();
    const now = Date.now();
    const fromMs = from.getTime();
    const toMs = to.getTime();
    let total = 0;

    for (const row of rows) {
      const start = Math.max(new Date(row.joined_at).getTime(), fromMs);
      const end = Math.min(row.left_at ? new Date(row.left_at).getTime() : now, toMs);
      if (end <= start) continue;
      distinct.add(row.user_id);
      total += (end - start) / 1000;
      for (let i = bucketIndexAt(buckets, start); i < n && buckets.starts[i] < end; i += 1) {
        const overlap = Math.min(end, buckets.ends[i]) - Math.max(start, buckets.starts[i]);
        if (overlap > 0) {
          seconds[i] += overlap / 1000;
          users[i].add(row.user_id);
        }
      }
    }
    return {
      hours: seconds.map((s) => round(s / 3600, 2)),
      users: users.map((set) => set.size),
      totalSeconds: Math.round(total),
      distinctUsers: distinct.size,
    };
  }

  async roleMentionSeries(q, roleId) {
    const rows = await this.db.query(
      `SELECT ${bucketSql('created_at', q.interval, q.offset)} AS k, COUNT(*) AS n
         FROM stats_role_mentions
        WHERE guild_id = ? AND role_id = ? AND created_at >= ? AND created_at < ? GROUP BY k`,
      [q.guildId, roleId, q.from, q.to],
    );
    const values = fill(q.buckets, rows, 'n');
    return { interval: q.interval, labels: q.buckets.keys, values, total: values.reduce((a, b) => a + b, 0) };
  }

  /**
   * Classement des rôles les plus mentionnés sur la période, avec une courbe par rôle
   * (mêmes intervalles que les autres graphiques).
   */
  async roleMentionRanking(q, limit = 8) {
    const top = await this.db.query(
      `SELECT m.role_id, COUNT(*) AS n, r.name, r.color, r.is_deleted
         FROM stats_role_mentions m
         LEFT JOIN stats_roles r ON r.id = m.role_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
        GROUP BY m.role_id, r.name, r.color, r.is_deleted
        ORDER BY n DESC, m.role_id LIMIT ?`,
      [q.guildId, q.from, q.to, limit],
    );
    const range = { from: q.from, to: q.to, interval: q.interval, offset: q.offset };
    if (!top.length) return { range, labels: q.buckets.keys, total: 0, roles: [] };

    const [rows, all] = await Promise.all([
      this.db.query(
        `SELECT ${bucketSql('created_at', q.interval, q.offset)} AS k, role_id, COUNT(*) AS n
           FROM stats_role_mentions
          WHERE guild_id = ? AND role_id IN (?) AND created_at >= ? AND created_at < ? GROUP BY k, role_id`,
        [q.guildId, top.map((row) => row.role_id), q.from, q.to],
      ),
      this.db.one(
        'SELECT COUNT(*) AS n FROM stats_role_mentions WHERE guild_id = ? AND created_at >= ? AND created_at < ?',
        [q.guildId, q.from, q.to],
      ),
    ]);
    const roles = top.map((row) => {
      const id = String(row.role_id);
      return {
        id,
        name: row.name ?? `Rôle ${id}`,
        color: roleColor(row.color),
        deleted: row.name == null || Boolean(num(row.is_deleted)),
        mentions: num(row.n),
        values: fill(q.buckets, rows.filter((r) => String(r.role_id) === id), 'n'),
      };
    });
    return { range, labels: q.buckets.keys, total: num(all?.n), roles };
  }

  // ── Totaux ────────────────────────────────────────────────────────────────

  async periodTotals(q) {
    const params = [q.guildId, q.from, q.to];
    const [messages, deletions, events, moderation] = await Promise.all([
      this.db.one(
        `SELECT COUNT(*) AS messages, COUNT(DISTINCT user_id) AS authors, AVG(NULLIF(length, 0)) AS avg_length,
                COALESCE(SUM(mentions_everyone), 0) AS everyone, COALESCE(SUM(mentions_here), 0) AS here
           FROM stats_messages WHERE guild_id = ? AND created_at >= ? AND created_at < ?`,
        params,
      ),
      this.db.one(
        'SELECT COUNT(*) AS n FROM stats_message_deletions WHERE guild_id = ? AND deleted_at >= ? AND deleted_at < ?',
        params,
      ),
      this.db.query(
        `SELECT type, COUNT(*) AS n FROM stats_member_events
          WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY type`,
        params,
      ),
      this.db.query(
        `SELECT action, COUNT(*) AS n FROM stats_moderation_actions
          WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY action`,
        params,
      ),
    ]);
    const byType = Object.fromEntries(events.map((row) => [row.type, num(row.n)]));
    const byAction = Object.fromEntries(moderation.map((row) => [row.action, num(row.n)]));
    return {
      messages: num(messages?.messages),
      authors: num(messages?.authors),
      avgLength: messages?.avg_length == null ? null : round(num(messages.avg_length), 1),
      everyone: num(messages?.everyone),
      here: num(messages?.here),
      deletions: num(deletions?.n),
      joins: byType.join ?? 0,
      leaves: byType.leave ?? 0,
      bans: byAction.ban ?? 0,
      kicks: byAction.kick ?? 0,
      timeouts: byAction.timeout ?? 0,
    };
  }

  async voiceTotals(q, userId = null) {
    const now = new Date();
    const params = [q.from, now, q.to, q.guildId, q.to, q.from];
    let where = 'guild_id = ? AND joined_at < ? AND (left_at IS NULL OR left_at > ?)';
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    const row = await this.db.one(
      `SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS sessions, COALESCE(SUM(${VOICE_OVERLAP_SQL}), 0) AS seconds
         FROM stats_voice_sessions WHERE ${where}`,
      params,
    );
    return { users: num(row?.users), sessions: num(row?.sessions), seconds: num(row?.seconds) };
  }

  /** Ancienneté moyenne et médiane des membres actuels (médiane via LIMIT/OFFSET indexé). */
  async seniority(guildId, now = new Date()) {
    const stats = await this.db.one(
      `SELECT COUNT(*) AS n, AVG(TIMESTAMPDIFF(SECOND, joined_at, ?)) AS avg_seconds
         FROM stats_members WHERE guild_id = ? AND is_member = 1 AND joined_at IS NOT NULL`,
      [now, guildId],
    );
    const count = num(stats?.n);
    if (!count) return { count: 0, avgDays: null, medianDays: null };
    const middle = await this.db.query(
      `SELECT joined_at FROM stats_members
        WHERE guild_id = ? AND is_member = 1 AND joined_at IS NOT NULL
        ORDER BY joined_at LIMIT ? OFFSET ?`,
      [guildId, count % 2 ? 1 : 2, Math.floor((count - 1) / 2)],
    );
    const ages = middle.map((row) => (now.getTime() - new Date(row.joined_at).getTime()) / 1000);
    const median = ages.reduce((a, b) => a + b, 0) / ages.length;
    return {
      count,
      avgDays: round(num(stats.avg_seconds) / DAY_S, 1),
      medianDays: round(median / DAY_S, 1),
    };
  }

  async currentState(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    const now = new Date();
    const [seniority, boosters, snapshot] = await Promise.all([
      this.seniority(guildId, now),
      this.db.one(
        `SELECT COUNT(*) AS n, AVG(TIMESTAMPDIFF(SECOND, premium_since, ?)) AS avg_seconds
           FROM stats_members WHERE guild_id = ? AND is_member = 1 AND premium_since IS NOT NULL`,
        [now, guildId],
      ),
      this.db.one(
        `SELECT member_count, boost_count, nitro_count FROM stats_guild_snapshots
          WHERE guild_id = ? AND source = 'live' ORDER BY taken_at DESC LIMIT 1`,
        [guildId],
      ),
    ]);
    const nitro = guild
      ? [...guild.members.cache.values()].filter(detectNitro).length
      : num(snapshot?.nitro_count, null);
    return {
      memberCount: guild?.memberCount ?? num(snapshot?.member_count, null),
      boosts: guild ? guild.premiumSubscriptionCount ?? 0 : num(snapshot?.boost_count, null),
      premiumTier: guild?.premiumTier ?? null,
      boosters: num(boosters?.n),
      boosterAvgDays: boosters?.avg_seconds == null ? null : round(num(boosters.avg_seconds) / DAY_S, 1),
      nitro,
      seniority,
    };
  }

  /**
   * Séries d'un groupe (une seule famille de requêtes), pour qu'un graphique puisse
   * avoir sa propre période sans recalculer tout le dashboard.
   * Groupes : messages, members, events, deletions, voice, moderation.
   */
  async seriesGroup(q, group) {
    const b = q.buckets;
    switch (group) {
      case 'messages': {
        const rows = await this.messageBuckets(q);
        const messages = fill(b, rows, 'messages');
        const authors = fill(b, rows, 'authors');
        return {
          messages,
          avgMessagesPerMember: messages.map((count, i) => (authors[i] ? round(count / authors[i], 2) : null)),
          avgLength: fill(b, rows, 'avg_length', { empty: null, transform: (v) => round(Number(v), 1) }),
          everyone: fill(b, rows, 'everyone'),
          here: fill(b, rows, 'here'),
          activeText: authors,
        };
      }
      case 'members':
        return { members: await this.memberCurve(q) };
      case 'events': {
        const rows = await this.memberEventBuckets(q);
        return {
          joins: fill(b, rows.filter((row) => row.type === 'join'), 'n'),
          leaves: fill(b, rows.filter((row) => row.type === 'leave'), 'n'),
        };
      }
      case 'deletions':
        return { deletions: fill(b, await this.deletionBuckets(q), 'n') };
      case 'voice': {
        const voice = await this.voiceBuckets(q);
        return { voiceHours: voice.hours, activeVoice: voice.users, voiceTotals: voice };
      }
      case 'moderation': {
        const rows = await this.moderationBuckets(q);
        const moderation = { all: new Array(b.keys.length).fill(0) };
        for (const action of ['ban', 'kick', 'timeout']) {
          moderation[action] = fill(b, rows.filter((row) => row.action === action), 'n');
          moderation[action].forEach((value, i) => {
            moderation.all[i] += value;
          });
        }
        return { moderation };
      }
      default:
        throw new Error(`Groupe de séries inconnu : ${group}`);
    }
  }

  /** Séries d'un seul groupe, avec leurs libellés (période propre à un graphique). */
  async series(q, group) {
    const { voiceTotals, ...series } = await this.seriesGroup(q, group);
    return { range: { from: q.from, to: q.to, interval: q.interval, offset: q.offset }, labels: q.buckets.keys, series };
  }

  /** Vue d'ensemble du dashboard : toutes les séries + totaux de la période + état actuel. */
  async overview(q) {
    const groups = ['messages', 'members', 'events', 'deletions', 'voice', 'moderation'];
    const [totals, current, ...parts] = await Promise.all([
      this.periodTotals(q),
      this.currentState(q.guildId),
      ...groups.map((group) => this.seriesGroup(q, group)),
    ]);
    const { voiceTotals, ...series } = Object.assign({}, ...parts);
    return {
      range: { from: q.from, to: q.to, interval: q.interval, offset: q.offset },
      labels: q.buckets.keys,
      series,
      totals: { ...totals, voiceSeconds: voiceTotals.totalSeconds, voiceUsers: voiceTotals.distinctUsers },
      current,
    };
  }

  // ── Classements ───────────────────────────────────────────────────────────

  async topSenders(q, limit = 10) {
    const rows = await this.db.query(
      `SELECT user_id, COUNT(*) AS n FROM stats_messages
        WHERE guild_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY user_id ORDER BY n DESC LIMIT ?`,
      [q.guildId, q.from, q.to, limit],
    );
    return rows.map((row) => ({ userId: row.user_id, messages: num(row.n) }));
  }

  async topChannels(q, limit = 10, userId = null) {
    const params = [q.guildId, q.from, q.to];
    let where = 'guild_id = ? AND created_at >= ? AND created_at < ?';
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    params.push(limit);
    const rows = await this.db.query(
      `SELECT t.channel_id, t.n, c.name, c.type, c.is_deleted
         FROM (SELECT channel_id, COUNT(*) AS n FROM stats_messages WHERE ${where}
               GROUP BY channel_id ORDER BY n DESC LIMIT ?) t
         LEFT JOIN stats_channels c ON c.id = t.channel_id
        ORDER BY t.n DESC`,
      params,
    );
    return rows.map((row) => ({
      channelId: row.channel_id,
      name: row.name ?? this.client.channels.cache.get(row.channel_id)?.name ?? row.channel_id,
      isThread: THREAD_TYPES.has(num(row.type, -1)),
      isDeleted: Boolean(num(row.is_deleted)),
      messages: num(row.n),
    }));
  }

  async topVoice(q, limit = 10) {
    const rows = await this.db.query(
      `SELECT user_id, SUM(${VOICE_OVERLAP_SQL}) AS seconds
         FROM stats_voice_sessions
        WHERE guild_id = ? AND joined_at < ? AND (left_at IS NULL OR left_at > ?)
        GROUP BY user_id ORDER BY seconds DESC LIMIT ?`,
      [q.from, new Date(), q.to, q.guildId, q.to, q.from, limit],
    );
    return rows.map((row) => ({ userId: row.user_id, seconds: num(row.seconds) })).filter((row) => row.seconds > 0);
  }

  async oldestMembers(guildId, limit = 10) {
    const rows = await this.db.query(
      `SELECT user_id, joined_at FROM stats_members
        WHERE guild_id = ? AND is_member = 1 AND joined_at IS NOT NULL
        ORDER BY joined_at ASC LIMIT ?`,
      [guildId, limit],
    );
    return rows.map((row) => ({ userId: row.user_id, joinedAt: toDate(row.joined_at) }));
  }

  async oldestBoosters(guildId, limit = 10) {
    const rows = await this.db.query(
      `SELECT user_id, premium_since FROM stats_members
        WHERE guild_id = ? AND is_member = 1 AND premium_since IS NOT NULL
        ORDER BY premium_since ASC LIMIT ?`,
      [guildId, limit],
    );
    return rows.map((row) => ({ userId: row.user_id, boostingSince: toDate(row.premium_since) }));
  }

  async leaderboards(q, limit = 10) {
    const [senders, channels, voice, oldest, boosters] = await Promise.all([
      this.topSenders(q, limit),
      this.topChannels(q, limit),
      this.topVoice(q, limit),
      this.oldestMembers(q.guildId, limit),
      this.oldestBoosters(q.guildId, limit),
    ]);
    const people = await this.resolveUsers(
      q.guildId,
      [...senders, ...voice, ...oldest, ...boosters].map((row) => row.userId),
    );
    const withUser = (rows) => rows.map((row) => ({ ...row, user: people.get(row.userId) }));
    return {
      senders: withUser(senders),
      channels,
      voice: withUser(voice),
      oldest: withUser(oldest),
      boosters: withUser(boosters),
    };
  }

  /** Rôles du serveur, triés par nombre de mentions sur la période. */
  async roles(q) {
    const rows = await this.db.query(
      `SELECT r.id, r.name, r.color, r.is_deleted, COALESCE(c.n, 0) AS mentions
         FROM stats_roles r
         LEFT JOIN (SELECT role_id, COUNT(*) AS n FROM stats_role_mentions
                     WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY role_id) c
           ON c.role_id = r.id
        WHERE r.guild_id = ? AND r.id <> r.guild_id
        ORDER BY mentions DESC, r.is_deleted ASC, r.position DESC`,
      [q.guildId, q.from, q.to, q.guildId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: roleColor(row.color),
      deleted: Boolean(num(row.is_deleted)),
      mentions: num(row.mentions),
    }));
  }

  // ── Utilisateurs ──────────────────────────────────────────────────────────

  /** id → { id, name, username, avatar } (surnom du serveur en priorité). */
  async resolveUsers(guildId, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const people = new Map();
    if (!unique.length) return people;
    const rows = await this.db.query(
      `SELECT u.id, u.username, u.global_name, u.avatar, m.nickname
         FROM stats_users u LEFT JOIN stats_members m ON m.user_id = u.id AND m.guild_id = ?
        WHERE u.id IN (?)`,
      [guildId, unique],
    );
    for (const row of rows) {
      people.set(row.id, {
        id: row.id,
        name: row.nickname || row.global_name || row.username,
        username: row.username,
        avatar: avatarUrl(row.id, row.avatar),
      });
    }
    for (const id of unique) {
      if (people.has(id)) continue;
      const cached = this.client.users.cache.get(id);
      people.set(id, {
        id,
        name: cached ? cached.globalName ?? cached.username : `Utilisateur ${id}`,
        username: cached?.username ?? null,
        avatar: avatarUrl(id, cached?.avatar ?? null),
        bot: cached?.bot ?? false,
      });
    }
    return people;
  }

  /** Fiche d'investigation complète d'un membre (outil de recherche par ID). */
  async memberProfile(q, userId) {
    const { guildId } = q;
    const now = new Date();
    const [user, membership, guilds] = await Promise.all([
      this.db.one('SELECT id, username, global_name, avatar, first_seen_at FROM stats_users WHERE id = ?', [userId]),
      this.db.one(
        `SELECT nickname, joined_at, left_at, is_member, premium_since, nitro_detected
           FROM stats_members WHERE guild_id = ? AND user_id = ?`,
        [guildId, userId],
      ),
      this.db.query(
        `SELECT m.guild_id, g.name, m.is_member, m.joined_at, m.nickname
           FROM stats_members m JOIN stats_guilds g ON g.id = m.guild_id
          WHERE m.user_id = ? ORDER BY g.name`,
        [userId],
      ),
    ]);
    const discordUser = this.client.users.cache.get(userId) ?? (await this.client.users.fetch(userId).catch(() => null));
    if (!user && !membership && !discordUser) return null;

    const period = [guildId, userId, q.from, q.to];
    const [
      periodMessages,
      allTime,
      deletions,
      voicePeriod,
      voiceAllTime,
      messageRows,
      voiceSeries,
      channels,
      names,
      presence,
      roleHistory,
      moderation,
      boosts,
      recent,
    ] = await Promise.all([
      this.db.one(
        `SELECT COUNT(*) AS messages, AVG(NULLIF(length, 0)) AS avg_length, MIN(created_at) AS first_at,
                MAX(created_at) AS last_at, COALESCE(SUM(mentions_everyone), 0) AS everyone,
                COALESCE(SUM(mentions_here), 0) AS here
           FROM stats_messages WHERE guild_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?`,
        period,
      ),
      this.db.one(
        `SELECT COUNT(*) AS messages, MIN(created_at) AS first_at, MAX(created_at) AS last_at
           FROM stats_messages WHERE guild_id = ? AND user_id = ?`,
        [guildId, userId],
      ),
      this.db.one(
        `SELECT COUNT(*) AS n FROM stats_message_deletions
          WHERE guild_id = ? AND user_id = ? AND deleted_at >= ? AND deleted_at < ?`,
        period,
      ),
      this.voiceTotals(q, userId),
      this.db.one(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(COALESCE(duration_seconds, GREATEST(0, TIMESTAMPDIFF(SECOND, joined_at, ?)))), 0) AS seconds
           FROM stats_voice_sessions WHERE guild_id = ? AND user_id = ?`,
        [now, guildId, userId],
      ),
      this.messageBuckets(q, userId),
      this.voiceBuckets(q, userId),
      this.topChannels(q, 5, userId),
      this.db.query(
        `SELECT h.name_type, h.guild_id, g.name AS guild_name, h.old_value, h.new_value, h.changed_at, h.source
           FROM stats_name_history h LEFT JOIN stats_guilds g ON g.id = h.guild_id
          WHERE h.user_id = ? ORDER BY h.changed_at DESC LIMIT 300`,
        [userId],
      ),
      this.db.query(
        `SELECT type, created_at, source FROM stats_member_events
          WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100`,
        [guildId, userId],
      ),
      this.db.query(
        `SELECT h.role_id, r.name, r.color, h.action, h.executor_id, h.created_at, h.source
           FROM stats_role_history h LEFT JOIN stats_roles r ON r.id = h.role_id
          WHERE h.guild_id = ? AND h.user_id = ? ORDER BY h.created_at DESC LIMIT 200`,
        [guildId, userId],
      ),
      this.db.query(
        `SELECT action, executor_id, reason, expires_at, created_at FROM stats_moderation_actions
          WHERE guild_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT 100`,
        [guildId, userId],
      ),
      this.db.query(
        `SELECT started_at, ended_at FROM stats_boost_history
          WHERE guild_id = ? AND user_id = ? ORDER BY started_at DESC`,
        [guildId, userId],
      ),
      this.db.query(
        `SELECT m.id, m.channel_id, c.name AS channel_name, m.created_at, m.length, m.content, m.attachments,
                d.deleted_at
           FROM stats_messages m
           LEFT JOIN stats_channels c ON c.id = m.channel_id
           LEFT JOIN stats_message_deletions d ON d.message_id = m.id
          WHERE m.guild_id = ? AND m.user_id = ?
          ORDER BY m.created_at DESC LIMIT 50`,
        [guildId, userId],
      ),
    ]);

    const messageCount = num(periodMessages?.messages);
    let rank = null;
    if (messageCount > 0) {
      const row = await this.db.one(
        `SELECT COUNT(*) + 1 AS position FROM (
           SELECT user_id FROM stats_messages WHERE guild_id = ? AND created_at >= ? AND created_at < ?
           GROUP BY user_id HAVING COUNT(*) > ?) t`,
        [guildId, q.from, q.to, messageCount],
      );
      rank = num(row?.position, null);
    }

    const executors = await this.resolveUsers(
      guildId,
      [...roleHistory, ...moderation].map((row) => row.executor_id),
    );
    const guild = this.client.guilds.cache.get(guildId);
    const liveMember = guild?.members.cache.get(userId) ?? null;

    return {
      identity: {
        id: userId,
        username: discordUser?.username ?? user?.username ?? null,
        globalName: discordUser?.globalName ?? user?.global_name ?? null,
        avatar: avatarUrl(userId, discordUser?.avatar ?? user?.avatar ?? null, 128),
        bot: discordUser?.bot ?? false,
        createdAt: snowflakeDate(userId),
        firstSeenAt: toDate(user?.first_seen_at),
      },
      membership: membership
        ? {
            isMember: Boolean(num(membership.is_member)),
            nickname: liveMember?.nickname ?? membership.nickname,
            joinedAt: toDate(membership.joined_at),
            leftAt: toDate(membership.left_at),
            boostingSince: toDate(membership.premium_since),
            nitro: liveMember ? detectNitro(liveMember) : Boolean(num(membership.nitro_detected)),
          }
        : null,
      roles: liveMember
        ? [...liveMember.roles.cache.values()]
            .filter((role) => role.id !== guildId)
            .sort((a, b) => b.position - a.position)
            .map((role) => ({ id: role.id, name: role.name, color: roleColor(role.color) }))
        : [],
      guilds: guilds.map((row) => ({
        id: row.guild_id,
        name: row.name,
        isMember: Boolean(num(row.is_member)),
        joinedAt: toDate(row.joined_at),
        nickname: row.nickname,
      })),
      period: {
        messages: messageCount,
        rank,
        avgLength: periodMessages?.avg_length == null ? null : round(num(periodMessages.avg_length), 1),
        firstMessageAt: toDate(periodMessages?.first_at),
        lastMessageAt: toDate(periodMessages?.last_at),
        everyone: num(periodMessages?.everyone),
        here: num(periodMessages?.here),
        deletions: num(deletions?.n),
        voiceSeconds: voicePeriod.seconds,
        voiceSessions: voicePeriod.sessions,
      },
      allTime: {
        messages: num(allTime?.messages),
        firstMessageAt: toDate(allTime?.first_at),
        lastMessageAt: toDate(allTime?.last_at),
        voiceSeconds: num(voiceAllTime?.seconds),
        voiceSessions: num(voiceAllTime?.sessions),
      },
      series: {
        interval: q.interval,
        labels: q.buckets.keys,
        messages: fill(q.buckets, messageRows, 'messages'),
        voiceHours: voiceSeries.hours,
      },
      channels,
      names: names.map((row) => ({
        type: row.name_type,
        guildId: row.guild_id,
        guildName: row.guild_name,
        oldValue: row.old_value,
        newValue: row.new_value,
        changedAt: toDate(row.changed_at),
        source: row.source,
      })),
      presence: presence.map((row) => ({ type: row.type, at: toDate(row.created_at), source: row.source })),
      roleHistory: roleHistory.map((row) => ({
        roleId: row.role_id,
        name: row.name ?? row.role_id,
        color: roleColor(row.color),
        action: row.action,
        executor: row.executor_id ? executors.get(row.executor_id) : null,
        at: toDate(row.created_at),
        source: row.source,
      })),
      moderation: moderation.map((row) => ({
        action: row.action,
        executor: row.executor_id ? executors.get(row.executor_id) : null,
        reason: row.reason,
        expiresAt: toDate(row.expires_at),
        at: toDate(row.created_at),
      })),
      boosts: boosts.map((row) => ({ startedAt: toDate(row.started_at), endedAt: toDate(row.ended_at) })),
      recentMessages: recent.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name ?? row.channel_id,
        at: toDate(row.created_at),
        length: num(row.length),
        content: row.content,
        attachments: num(row.attachments),
        deletedAt: toDate(row.deleted_at),
      })),
    };
  }
}

module.exports = { StatsQueries, createScope };
