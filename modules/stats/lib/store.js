'use strict';

const { chunk } = require('../../../src/core/database');

/**
 * File d'insertion groupée : les lignes s'accumulent en mémoire et sont écrites
 * par paquets (INSERT IGNORE multi-lignes) toutes les `intervalMs` ou dès que
 * `maxSize` est atteint. Indispensable pour tenir le volume des messages.
 */
class BatchQueue {
  constructor({ db, logger, table, columns, maxSize = 500, intervalMs = 2000 }) {
    this.db = db;
    this.logger = logger;
    this.table = table;
    this.columns = columns;
    this.maxSize = maxSize;
    this.rows = [];
    this.pending = Promise.resolve();
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  push(row) {
    this.rows.push(row);
    if (this.rows.length >= this.maxSize) this.flush();
  }

  flush() {
    this.pending = this.pending.then(async () => {
      if (!this.rows.length) return;
      const rows = this.rows.splice(0, this.rows.length);
      for (const part of chunk(rows, 1000)) {
        try {
          await this.db.query(`INSERT IGNORE INTO ${this.table} (${this.columns.join(', ')}) VALUES ?`, [part]);
        } catch (err) {
          this.logger.error(`Insertion groupée dans ${this.table} échouée (${part.length} lignes)`, err);
        }
      }
    });
    return this.pending;
  }

  async stop() {
    clearInterval(this.timer);
    await this.flush();
  }
}

const EVERYONE = /@everyone/;
const HERE = /@here/;

/** Toutes les écritures du module Statistiques. */
class StatsStore {
  constructor(db, logger, settings) {
    this.db = db;
    this.logger = logger;
    this.settings = settings;
    this.knownUsers = new Set();

    this.messages = new BatchQueue({
      db,
      logger,
      table: 'stats_messages',
      columns: [
        'id', 'guild_id', 'channel_id', 'user_id', 'created_at', 'length', 'content',
        'attachments', 'mentions_everyone', 'mentions_here', 'source',
      ],
    });
    this.roleMentions = new BatchQueue({
      db,
      logger,
      table: 'stats_role_mentions',
      columns: ['message_id', 'role_id', 'guild_id', 'user_id', 'created_at'],
    });
    this.users = new BatchQueue({
      db,
      logger,
      table: 'stats_users',
      columns: ['id', 'username', 'global_name', 'avatar', 'first_seen_at', 'updated_at'],
      intervalMs: 5000,
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  recordMessage(message, source = 'live') {
    const content = message.content ?? '';
    const createdAt = message.createdAt;
    this.messages.push([
      message.id,
      message.guildId,
      message.channelId,
      message.author.id,
      createdAt,
      [...content].length,
      this.settings.storeMessageContent && content ? content : null,
      Math.min(message.attachments?.size ?? 0, 65535),
      EVERYONE.test(content) ? 1 : 0,
      HERE.test(content) ? 1 : 0,
      source,
    ]);
    for (const roleId of message.mentions?.roles?.keys() ?? []) {
      this.roleMentions.push([message.id, roleId, message.guildId, message.author.id, createdAt]);
    }
    this.rememberUser(message.author);
  }

  /** Enregistre un auteur inconnu (ex : ancien membre rencontré pendant la rétroactivité). */
  rememberUser(user) {
    if (!user || user.bot || this.knownUsers.has(user.id)) return;
    if (this.knownUsers.size > 50_000) this.knownUsers.clear();
    this.knownUsers.add(user.id);
    const now = new Date();
    this.users.push([user.id, user.username, user.globalName ?? null, user.avatar ?? null, now, now]);
  }

  /** deletions : [{ messageId, guildId, channelId, userId|null, deletedAt }] */
  async recordDeletions(deletions) {
    if (!deletions.length) return;
    const unknown = deletions.filter((d) => !d.userId).map((d) => d.messageId);
    if (unknown.length) {
      await this.messages.flush();
      const rows = await this.db.query('SELECT id, user_id FROM stats_messages WHERE id IN (?)', [unknown]);
      const authors = new Map(rows.map((row) => [row.id, row.user_id]));
      for (const deletion of deletions) deletion.userId ??= authors.get(deletion.messageId) ?? null;
    }
    const values = deletions.map((d) => [d.messageId, d.guildId, d.channelId, d.userId, d.deletedAt]);
    await this.db.query(
      'INSERT IGNORE INTO stats_message_deletions (message_id, guild_id, channel_id, user_id, deleted_at) VALUES ?',
      [values],
    );
  }

  // ── Serveurs ──────────────────────────────────────────────────────────────

  async upsertGuild(guild) {
    await this.db.query(
      `INSERT INTO stats_guilds (id, name, icon, owner_id, bot_joined_at, is_present, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), icon = VALUES(icon), owner_id = VALUES(owner_id),
         bot_joined_at = COALESCE(VALUES(bot_joined_at), bot_joined_at), is_present = 1, updated_at = VALUES(updated_at)`,
      [guild.id, guild.name, guild.icon ?? null, guild.ownerId ?? null, guild.joinedAt ?? null, new Date()],
    );
  }

  async markGuildAbsent(guildId) {
    await this.db.query('UPDATE stats_guilds SET is_present = 0, updated_at = ? WHERE id = ?', [new Date(), guildId]);
  }

  async markAbsentGuilds(presentIds) {
    if (presentIds.length) {
      await this.db.query('UPDATE stats_guilds SET is_present = 0 WHERE id NOT IN (?)', [presentIds]);
    } else {
      await this.db.query('UPDATE stats_guilds SET is_present = 0');
    }
  }

  async guildStates() {
    const rows = await this.db.query('SELECT id, backfill_status, tracking_since FROM stats_guilds');
    return new Map(rows.map((row) => [row.id, row]));
  }

  async setBackfillStatus(guildId, status, { trackingSince } = {}) {
    const now = new Date();
    await this.db.query(
      `UPDATE stats_guilds
         SET backfill_status = ?,
             backfilled_at = IF(? = 'done', ?, backfilled_at),
             tracking_since = COALESCE(tracking_since, ?),
             updated_at = ?
       WHERE id = ?`,
      [status, status, now, trackingSince ?? null, now, guildId],
    );
  }

  // ── Membres & utilisateurs ────────────────────────────────────────────────

  async loadUsers(ids) {
    const users = new Map();
    for (const part of chunk(ids, 1000)) {
      const rows = await this.db.query('SELECT id, username, global_name FROM stats_users WHERE id IN (?)', [part]);
      for (const row of rows) users.set(row.id, row);
    }
    return users;
  }

  async loadMembers(guildId) {
    const rows = await this.db.query(
      'SELECT user_id, nickname, joined_at, is_member, premium_since FROM stats_members WHERE guild_id = ?',
      [guildId],
    );
    return new Map(rows.map((row) => [row.user_id, row]));
  }

  async loadMember(guildId, userId) {
    return this.db.one(
      'SELECT user_id, nickname, joined_at, is_member, premium_since FROM stats_members WHERE guild_id = ? AND user_id = ?',
      [guildId, userId],
    );
  }

  async upsertUsers(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT INTO stats_users (id, username, global_name, avatar, first_seen_at, updated_at) VALUES ?
         ON DUPLICATE KEY UPDATE username = VALUES(username), global_name = VALUES(global_name),
           avatar = VALUES(avatar), updated_at = VALUES(updated_at)`,
        [part],
      );
    }
    for (const row of rows) this.knownUsers.add(row[0]);
  }

  async upsertMembers(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT INTO stats_members
           (guild_id, user_id, nickname, guild_avatar, joined_at, left_at, is_member, premium_since, nitro_detected, updated_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), guild_avatar = VALUES(guild_avatar),
           joined_at = VALUES(joined_at), left_at = NULL, is_member = 1, premium_since = VALUES(premium_since),
           nitro_detected = VALUES(nitro_detected), updated_at = VALUES(updated_at)`,
        [part],
      );
    }
  }

  async markMembersLeft(guildId, userIds, at) {
    for (const part of chunk(userIds, 1000)) {
      await this.db.query(
        `UPDATE stats_members SET is_member = 0, left_at = ?, premium_since = NULL, updated_at = ?
         WHERE guild_id = ? AND user_id IN (?)`,
        [at, at, guildId, part],
      );
    }
  }

  /** rows : [guildId, userId, 'join'|'leave', date, source] */
  async recordMemberEvents(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        'INSERT IGNORE INTO stats_member_events (guild_id, user_id, type, created_at, source) VALUES ?',
        [part],
      );
    }
  }

  /** rows : [userId, guildId|null, type, oldValue, newValue, date, source, auditLogId|null] */
  async recordNameChanges(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT IGNORE INTO stats_name_history
           (user_id, guild_id, name_type, old_value, new_value, changed_at, source, audit_log_id)
         VALUES ?`,
        [part],
      );
    }
  }

  /** rows : [guildId, userId, roleId, 'add'|'remove', executorId|null, date, source, auditLogId|null] */
  async recordRoleChanges(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT IGNORE INTO stats_role_history
           (guild_id, user_id, role_id, action, executor_id, created_at, source, audit_log_id)
         VALUES ?`,
        [part],
      );
    }
  }

  /** Complète l'auteur d'un changement de rôle détecté en direct (le journal d'audit arrive séparément). */
  async attachRoleExecutor({ guildId, userId, roleId, action, executorId, auditLogId, around }) {
    const result = await this.db.query(
      `UPDATE stats_role_history SET executor_id = ?, audit_log_id = ?
       WHERE guild_id = ? AND user_id = ? AND role_id = ? AND action = ? AND executor_id IS NULL
         AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC LIMIT 1`,
      [
        executorId,
        auditLogId,
        guildId,
        userId,
        roleId,
        action,
        new Date(around.getTime() - 60_000),
        new Date(around.getTime() + 60_000),
      ],
    );
    return result.affectedRows ?? 0;
  }

  /** record : { guildId, targetId, executorId, action, reason, expiresAt, createdAt, auditLogId, source } */
  async recordModeration(record) {
    await this.db.query(
      `INSERT IGNORE INTO stats_moderation_actions
         (guild_id, target_id, executor_id, action, reason, expires_at, created_at, audit_log_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.guildId,
        record.targetId,
        record.executorId,
        record.action,
        record.reason ? record.reason.slice(0, 512) : null,
        record.expiresAt ?? null,
        record.createdAt,
        record.auditLogId ?? null,
        record.source ?? 'live',
      ],
    );
  }

  async recordBoostStart(guildId, userId, startedAt) {
    await this.db.query('INSERT IGNORE INTO stats_boost_history (guild_id, user_id, started_at) VALUES (?, ?, ?)', [
      guildId,
      userId,
      startedAt,
    ]);
  }

  async recordBoostEnd(guildId, userId, endedAt) {
    await this.db.query(
      'UPDATE stats_boost_history SET ended_at = ? WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL',
      [endedAt, guildId, userId],
    );
  }

  // ── Structure (salons, rôles) ─────────────────────────────────────────────

  async upsertChannels(guildId, rows, { markMissing = false } = {}) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT INTO stats_channels (id, guild_id, parent_id, name, type, is_deleted, updated_at) VALUES ?
         ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), type = VALUES(type),
           is_deleted = 0, updated_at = VALUES(updated_at)`,
        [part],
      );
    }
    if (markMissing && rows.length) {
      // Les fils archivés sortent du cache : on ne les marque pas comme supprimés.
      await this.db.query(
        'UPDATE stats_channels SET is_deleted = 1 WHERE guild_id = ? AND type NOT IN (10, 11, 12) AND id NOT IN (?)',
        [guildId, rows.map((row) => row[0])],
      );
    }
  }

  async upsertRoles(guildId, rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT INTO stats_roles (id, guild_id, name, color, position, is_deleted, updated_at) VALUES ?
         ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color), position = VALUES(position),
           is_deleted = 0, updated_at = VALUES(updated_at)`,
        [part],
      );
    }
    if (rows.length) {
      await this.db.query('UPDATE stats_roles SET is_deleted = 1 WHERE guild_id = ? AND id NOT IN (?)', [
        guildId,
        rows.map((row) => row[0]),
      ]);
    }
  }

  // ── Instantanés & méta ────────────────────────────────────────────────────

  /** rows : [guildId, takenAt, memberCount, boostCount, boosterCount, nitroCount, source] */
  async insertSnapshots(rows) {
    for (const part of chunk(rows, 1000)) {
      await this.db.query(
        `INSERT IGNORE INTO stats_guild_snapshots
           (guild_id, taken_at, member_count, boost_count, booster_count, nitro_count, source)
         VALUES ?`,
        [part],
      );
    }
  }

  async getMeta(name) {
    const row = await this.db.one('SELECT value FROM stats_meta WHERE name = ?', [name]);
    return row?.value ?? null;
  }

  async setMeta(name, value) {
    await this.db.query(
      `INSERT INTO stats_meta (name, value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [name, String(value), new Date()],
    );
  }

  /**
   * Efface le contenu des messages plus anciens que `days` jours (longueur, salon, date… restent : les
   * statistiques ne changent pas). Par paquets, pour ne pas verrouiller la table longtemps. Renvoie le total effacé.
   */
  async purgeOldContent(days) {
    if (!days) return 0;
    const limit = new Date(Date.now() - days * 86_400_000);
    let total = 0;
    // Serveur par serveur : l'index (guild_id, created_at) évite de parcourir toute la table à chaque paquet.
    for (const { id } of await this.db.query('SELECT id FROM stats_guilds')) {
      for (;;) {
        const result = await this.db.query(
          'UPDATE stats_messages SET content = NULL WHERE guild_id = ? AND created_at < ? AND content IS NOT NULL LIMIT 5000',
          [id, limit],
        );
        const affected = Number(result.affectedRows ?? 0);
        total += affected;
        if (affected < 5000) break;
      }
    }
    return total;
  }

  async flush() {
    await Promise.all([this.messages.flush(), this.roleMentions.flush(), this.users.flush()]);
  }

  async close() {
    await Promise.all([this.messages.stop(), this.roleMentions.stop(), this.users.stop()]);
  }
}

module.exports = { StatsStore, BatchQueue };
