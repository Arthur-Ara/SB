'use strict';

/** Accès MySQL du module : réglages, correspondances d'IDs, rollbacks exécutés. */
class SmStore {
  constructor(db) {
    this.db = db;
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const row = await this.db.one('SELECT * FROM sm_settings WHERE guild_id = ?', [guildId]);
    return {
      logChannelId: row?.log_channel_id ?? null,
      trackingSince: row?.tracking_since ? new Date(row.tracking_since) : null,
      backupEnabled: Boolean(Number(row?.backup_enabled ?? 0)),
      backupIntervalHours: Number(row?.backup_interval_hours ?? 24),
      backupKeep: Number(row?.backup_keep ?? 7),
      lastBackupAt: row?.last_backup_at ? new Date(row.last_backup_at) : null,
    };
  }

  /** Réglages des sauvegardes automatiques (colonnes de sm_settings, liste blanche). */
  async updateBackupSettings(guildId, patch) {
    const allowed = ['backup_enabled', 'backup_interval_hours', 'backup_keep', 'last_backup_at'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const columns = entries.map(([key]) => key);
    await this.db.query(
      `INSERT INTO sm_settings (guild_id, ${columns.join(', ')}, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_at = VALUES(updated_at)`,
      [guildId, ...entries.map(([, value]) => value), new Date()],
    );
  }

  async backupGuildIds() {
    const rows = await this.db.query('SELECT guild_id FROM sm_settings WHERE backup_enabled = 1');
    return rows.map((row) => String(row.guild_id));
  }

  async setLogChannel(guildId, channelId) {
    await this.db.query(
      `INSERT INTO sm_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, channelId, new Date()],
    );
  }

  /** Mémorise le début de la couverture du journal (première fois que le module voit ce serveur). */
  async ensureTrackingSince(guildId) {
    const now = new Date();
    await this.db.query(
      `INSERT INTO sm_settings (guild_id, tracking_since, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tracking_since = COALESCE(tracking_since, VALUES(tracking_since))`,
      [guildId, now, now],
    );
  }

  // ── Correspondance d'IDs ──────────────────────────────────────────────────

  async idMap(guildId) {
    const rows = await this.db.query('SELECT kind, old_id, new_id FROM sm_id_map WHERE guild_id = ?', [guildId]);
    const maps = { channel: new Map(), role: new Map() };
    for (const row of rows) maps[row.kind].set(String(row.old_id), String(row.new_id));
    return maps;
  }

  async saveIdMap(guildId, kind, oldId, newId) {
    await this.db.query(
      `INSERT INTO sm_id_map (guild_id, kind, old_id, new_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE new_id = VALUES(new_id), created_at = VALUES(created_at)`,
      [guildId, kind, oldId, newId, new Date()],
    );
  }

  // ── Rollbacks ─────────────────────────────────────────────────────────────

  async createBatch({ guildId, invokerId, scope, windowS, targetUserId, planned }) {
    const result = await this.db.query(
      `INSERT INTO sm_batches (guild_id, invoker_id, scope, window_s, target_user_id, status, planned, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      [guildId, invokerId, scope, windowS, targetUserId ?? null, planned, new Date()],
    );
    return result.insertId;
  }

  async finishBatch(id, { status, applied, skipped, failed, report }) {
    await this.db.query(
      `UPDATE sm_batches SET status = ?, applied = ?, skipped = ?, failed = ?, report = ?, finished_at = ? WHERE id = ?`,
      [status, applied, skipped, failed, JSON.stringify(report).slice(0, 4_000_000), new Date(), id],
    );
  }

  async history(guildId, limit = 50) {
    return this.db.query(
      `SELECT id, invoker_id, scope, window_s, target_user_id, status, planned, applied, skipped, failed, created_at
         FROM sm_batches WHERE guild_id = ? ORDER BY id DESC LIMIT ?`,
      [guildId, limit],
    );
  }

  async markRolledBack(changeId, by, batchId) {
    await this.db.query('UPDATE sm_changes SET rolled_back_at = ?, rolled_back_by = ?, batch_id = ? WHERE id = ?', [
      new Date(),
      by,
      batchId,
      changeId,
    ]);
  }

  async markModReverted(actionId, guildId, batchId, by) {
    await this.db.query(
      'INSERT IGNORE INTO sm_mod_reverted (action_id, guild_id, batch_id, reverted_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [actionId, guildId, batchId, by, new Date()],
    );
  }

  async batch(guildId, id) {
    const row = await this.db.one('SELECT * FROM sm_batches WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!row) return null;
    let report = [];
    try {
      report = row.report ? JSON.parse(row.report) : [];
    } catch {
      report = [];
    }
    return { ...row, report };
  }

  /** Journal des modifications (panel web), les plus récentes d'abord ; `kind`/`executorId` facultatifs. */
  async changes(guildId, { kind = null, executorId = null, limit = 50, offset = 0 } = {}) {
    let where = 'guild_id = ?';
    const params = [guildId];
    if (kind) {
      where += ' AND kind = ?';
      params.push(kind);
    }
    if (executorId) {
      where += ' AND executor_id = ?';
      params.push(executorId);
    }
    const [rows, count] = await Promise.all([
      this.db.query(
        `SELECT id, kind, op, target_id, role_id, executor_id, label, created_at, rolled_back_at, rolled_back_by, batch_id
           FROM sm_changes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.db.one(`SELECT COUNT(*) AS n FROM sm_changes WHERE ${where}`, params),
    ]);
    return { rows, total: Number(count?.n ?? 0) };
  }

  // ── Sauvegardes ───────────────────────────────────────────────────────────

  async createBackup({ guildId, name, origin, data, createdBy }) {
    const json = JSON.stringify(data);
    const result = await this.db.query(
      `INSERT INTO sm_backups (guild_id, name, origin, roles_count, channels_count, size_bytes, data, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, String(name).slice(0, 80), origin, data.roles.length, data.channels.length, Buffer.byteLength(json), json, createdBy, new Date()],
    );
    return result.insertId;
  }

  async listBackups(guildId) {
    return this.db.query(
      `SELECT id, name, origin, roles_count, channels_count, size_bytes, created_by, created_at, restored_at, restored_by
         FROM sm_backups WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100`,
      [guildId],
    );
  }

  async getBackup(guildId, id) {
    const row = await this.db.one('SELECT * FROM sm_backups WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
  }

  async deleteBackup(guildId, id) {
    const result = await this.db.query('DELETE FROM sm_backups WHERE guild_id = ? AND id = ?', [guildId, id]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  async markRestored(id, by) {
    await this.db.query('UPDATE sm_backups SET restored_at = ?, restored_by = ? WHERE id = ?', [new Date(), by, id]);
  }

  /** Ne garde que les `keep` sauvegardes automatiques les plus récentes (les manuelles ne sont jamais purgées). */
  async pruneAutoBackups(guildId, keep) {
    const rows = await this.db.query(
      `SELECT id FROM sm_backups WHERE guild_id = ? AND origin = 'auto' ORDER BY created_at DESC LIMIT 1000 OFFSET ?`,
      [guildId, keep],
    );
    if (rows.length) await this.db.query('DELETE FROM sm_backups WHERE id IN (?)', [rows.map((row) => row.id)]);
    return rows.length;
  }

  async journalSize(guildId) {
    const row = await this.db.one(
      'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM sm_changes WHERE guild_id = ? AND rolled_back_at IS NULL',
      [guildId],
    );
    return { count: Number(row?.n ?? 0), oldest: row?.oldest ? new Date(row.oldest) : null };
  }
}

module.exports = { SmStore };
