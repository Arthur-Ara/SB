'use strict';

function jsonList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Accès aux données du module Modération : réglages (salon de journal, catégorie « Prison »),
 * historique des actions (source commune de /history, /modlogs, /warn, /removewarn), état des
 * salons verrouillés et shadow-bans actifs.
 */
class ModerationService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.settingsCache = new Map();
    this.automodCache = new Map();
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const cached = this.settingsCache.get(guildId);
    if (cached) return cached;
    const row = await this.db.one('SELECT * FROM moderation_settings WHERE guild_id = ?', [guildId]);
    const settings = {
      logChannelId: row?.log_channel_id ?? null,
      prisonCategoryId: row?.prison_category_id ?? null,
      appealEnabled: Boolean(Number(row?.appeal_enabled ?? 0)),
      appealTicketTypeId: row?.appeal_ticket_type_id ? String(row.appeal_ticket_type_id) : null,
      automod: {
        enabled: Boolean(Number(row?.automod_enabled ?? 0)),
        action: row?.automod_action ?? 'delete',
        muteMinutes: Number(row?.automod_mute_minutes ?? 10),
        threshold: Number(row?.automod_threshold ?? 80),
        exemptRoleIds: jsonList(row?.automod_exempt_role_ids),
        exemptChannelIds: jsonList(row?.automod_exempt_channel_ids),
      },
    };
    this.settingsCache.set(guildId, settings);
    return settings;
  }

  /** Met à jour des colonnes de `moderation_settings` (liste blanche ci-dessous), en créant la ligne au besoin. */
  async updateSettings(guildId, patch) {
    const allowed = [
      'appeal_enabled', 'appeal_ticket_type_id', 'automod_enabled', 'automod_action', 'automod_mute_minutes', 'automod_threshold',
      'automod_exempt_role_ids', 'automod_exempt_channel_ids',
    ];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const columns = entries.map(([key]) => key);
    const values = entries.map(([key, value]) => (key.endsWith('_ids') ? JSON.stringify(value ?? []) : value));
    await this.db.query(
      `INSERT INTO moderation_settings (guild_id, ${columns.join(', ')}, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_at = VALUES(updated_at)`,
      [guildId, ...values, new Date()],
    );
    this.invalidateSettings(guildId);
  }

  invalidateSettings(guildId) {
    this.settingsCache.delete(guildId);
  }

  async setLogChannel(guildId, logChannelId) {
    await this.db.query(
      `INSERT INTO moderation_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, logChannelId, new Date()],
    );
    this.invalidateSettings(guildId);
  }

  async setPrisonCategory(guildId, categoryId) {
    await this.db.query(
      `INSERT INTO moderation_settings (guild_id, prison_category_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE prison_category_id = VALUES(prison_category_id), updated_at = VALUES(updated_at)`,
      [guildId, categoryId, new Date()],
    );
    this.invalidateSettings(guildId);
  }

  // ── Historique des actions ───────────────────────────────────────────────

  /** Enregistre une action ; renvoie son identifiant (référencé par /removewarn, /modlogs…). */
  async record({ guildId, action, targetId = null, channelId = null, executorId, reason = null, durationS = null, expiresAt = null, metadata = null }) {
    const result = await this.db.query(
      `INSERT INTO moderation_actions
         (guild_id, action, target_id, channel_id, executor_id, reason, duration_s, expires_at, metadata, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        guildId,
        action,
        targetId,
        channelId,
        executorId,
        reason ? String(reason).slice(0, 512) : null,
        durationS,
        expiresAt,
        metadata ? JSON.stringify(metadata) : null,
        new Date(),
      ],
    );
    return result.insertId;
  }

  /** Marque une action comme levée (warn retiré, tempvocmute terminé…). */
  async resolve(id, resolvedBy) {
    await this.db.query('UPDATE moderation_actions SET active = 0, resolved_at = ?, resolved_by = ? WHERE id = ?', [
      new Date(),
      resolvedBy,
      id,
    ]);
  }

  async get(guildId, id) {
    return this.db.one('SELECT * FROM moderation_actions WHERE guild_id = ? AND id = ?', [guildId, id]);
  }

  /** Actions effectuées par ce membre (modérateur) OU subies par lui (sanctionné), les plus récentes d'abord. */
  async userHistory(guildId, userId, limit = 100) {
    return this.db.query(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND (target_id = ? OR executor_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
      [guildId, userId, userId, limit],
    );
  }

  /** Actions ayant eu lieu dans ce salon (verrouillage, purge, suppressions groupées…). */
  async channelHistory(guildId, channelId, limit = 100) {
    return this.db.query('SELECT * FROM moderation_actions WHERE guild_id = ? AND channel_id = ? ORDER BY created_at DESC LIMIT ?', [
      guildId,
      channelId,
      limit,
    ]);
  }

  /**
   * Page d'historique (panel web) : filtrée par types d'actions (null = tous) et/ou par membre
   * (sanctionné OU modérateur), les plus récentes d'abord. Renvoie { rows, total }.
   */
  async historyPage(guildId, { actions = null, userId = null, limit = 25, offset = 0 } = {}) {
    let where = 'guild_id = ?';
    const params = [guildId];
    if (actions?.length) {
      where += ' AND action IN (?)';
      params.push(actions);
    }
    if (userId) {
      where += ' AND (target_id = ? OR executor_id = ?)';
      params.push(userId, userId);
    }
    const [rows, count] = await Promise.all([
      this.db.query(`SELECT * FROM moderation_actions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      this.db.one(`SELECT COUNT(*) AS n FROM moderation_actions WHERE ${where}`, params),
    ]);
    return { rows, total: Number(count?.n ?? 0) };
  }

  /** Preuves de plusieurs sanctions : Map(actionId → lignes moderation_proofs). */
  async proofsForActions(guildId, actionIds) {
    const byAction = new Map();
    if (!actionIds.length) return byAction;
    const rows = await this.db.query('SELECT * FROM moderation_proofs WHERE guild_id = ? AND action_id IN (?) ORDER BY id', [guildId, actionIds]);
    for (const row of rows) {
      const key = Number(row.action_id);
      if (!byAction.has(key)) byAction.set(key, []);
      byAction.get(key).push(row);
    }
    return byAction;
  }

  async activeWarns(guildId, userId) {
    return this.db.query(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND target_id = ? AND action = 'warn' AND active = 1
       ORDER BY created_at DESC LIMIT 25`,
      [guildId, userId],
    );
  }

  async warnCount(guildId, userId) {
    const row = await this.db.one(
      `SELECT COUNT(*) AS n FROM moderation_actions WHERE guild_id = ? AND target_id = ? AND action = 'warn' AND active = 1`,
      [guildId, userId],
    );
    return Number(row?.n ?? 0);
  }

  /** Tous les avertissements actifs du serveur (panel web), les plus récents d'abord. */
  async activeWarnsForGuild(guildId, limit = 200) {
    return this.db.query(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND action = 'warn' AND active = 1 ORDER BY created_at DESC LIMIT ?`,
      [guildId, limit],
    );
  }

  /**
   * Dernier enregistrement de bannissement par cible (panel web) : Discord (guild.bans.fetch())
   * reste la source de vérité de « qui est banni », cette table ne sert qu'à retrouver qui a banni
   * et pourquoi — y compris les bans déjà levés, donc à croiser avec la liste Discord avant affichage.
   */
  async banRecords(guildId) {
    const rows = await this.db.query(
      `SELECT target_id, executor_id, reason, created_at FROM moderation_actions
       WHERE guild_id = ? AND action = 'ban' ORDER BY created_at DESC`,
      [guildId],
    );
    const byTarget = new Map();
    for (const row of rows) if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, row);
    return byTarget;
  }

  // ── Preuves attachées aux sanctions ──────────────────────────────────────

  /** `proof` : { channelId, messageId, authorId, content, attachments } (voir lib/proofs.js#captureProof). Renvoie l'id de la preuve. */
  async addProof(guildId, actionId, proof, addedBy) {
    const result = await this.db.query(
      `INSERT INTO moderation_proofs (guild_id, action_id, channel_id, message_id, author_id, content, attachments, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, actionId, proof.channelId, proof.messageId, proof.authorId, proof.content, JSON.stringify(proof.attachments ?? []), addedBy, new Date()],
    );
    return result.insertId;
  }

  async proofs(guildId, actionId) {
    return this.db.query('SELECT * FROM moderation_proofs WHERE guild_id = ? AND action_id = ? ORDER BY id', [guildId, actionId]);
  }

  /** Nombre de preuves par sanction : Map(actionId → n), pour l'affichage de l'historique. */
  async proofCounts(guildId, actionIds) {
    const counts = new Map();
    if (!actionIds.length) return counts;
    const rows = await this.db.query(
      'SELECT action_id, COUNT(*) AS n FROM moderation_proofs WHERE guild_id = ? AND action_id IN (?) GROUP BY action_id',
      [guildId, actionIds],
    );
    for (const row of rows) counts.set(Number(row.action_id), Number(row.n));
    return counts;
  }

  async removeProof(guildId, actionId, proofId) {
    const result = await this.db.query('DELETE FROM moderation_proofs WHERE guild_id = ? AND action_id = ? AND id = ?', [guildId, actionId, proofId]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  // ── Blacklist (globale : un seul bannissement par utilisateur, tous serveurs confondus) ────

  async blacklistEntry(userId) {
    return this.db.one('SELECT * FROM moderation_blacklist WHERE user_id = ?', [userId]);
  }

  /** `guildId` : serveur d'origine (où /blacklist a été lancé), conservé à titre indicatif. */
  async addBlacklist(guildId, userId, actionId, executorId, reason) {
    await this.db.query(
      `INSERT INTO moderation_blacklist (guild_id, user_id, action_id, executor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action_id = VALUES(action_id), executor_id = VALUES(executor_id), reason = VALUES(reason), created_at = VALUES(created_at)`,
      [guildId, userId, actionId, executorId, reason ? String(reason).slice(0, 512) : null, new Date()],
    );
  }

  async removeBlacklist(userId) {
    await this.db.query('DELETE FROM moderation_blacklist WHERE user_id = ?', [userId]);
  }

  // ── Salons verrouillés (/lock, /lockall) ─────────────────────────────────

  /** previousState : { SendMessages: true|false|null, … } — état des permissions avant verrouillage. */
  async saveLockState(guildId, channelId, previousState, lockedBy) {
    await this.db.query(
      `INSERT INTO moderation_channel_locks (guild_id, channel_id, previous_state, locked_by, locked_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE previous_state = VALUES(previous_state), locked_by = VALUES(locked_by), locked_at = VALUES(locked_at)`,
      [guildId, channelId, JSON.stringify(previousState), lockedBy, new Date()],
    );
  }

  async lockState(guildId, channelId) {
    const row = await this.db.one('SELECT previous_state FROM moderation_channel_locks WHERE guild_id = ? AND channel_id = ?', [
      guildId,
      channelId,
    ]);
    if (!row) return null;
    return typeof row.previous_state === 'string' ? JSON.parse(row.previous_state) : row.previous_state;
  }

  async isLocked(guildId, channelId) {
    return Boolean(await this.lockState(guildId, channelId));
  }

  async clearLockState(guildId, channelId) {
    await this.db.query('DELETE FROM moderation_channel_locks WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
  }

  async lockedChannelIds(guildId) {
    const rows = await this.db.query('SELECT channel_id FROM moderation_channel_locks WHERE guild_id = ?', [guildId]);
    return rows.map((row) => row.channel_id);
  }

  // ── Shadow-bans actifs ────────────────────────────────────────────────────

  async shadowban(guildId, userId) {
    const row = await this.db.one(
      'SELECT prison_channel_id, previous_state, reason, created_at FROM moderation_shadowbans WHERE guild_id = ? AND user_id = ?',
      [guildId, userId],
    );
    if (!row) return null;
    return { ...row, previous_state: row.previous_state ? (typeof row.previous_state === 'string' ? JSON.parse(row.previous_state) : row.previous_state) : {} };
  }

  /** `previousState` : { [channelId]: true|false|null } — état ViewChannel d'avant le shadow-ban, pour le restaurer précisément à la levée. */
  async addShadowban(guildId, userId, prisonChannelId, previousState, executorId, reason) {
    await this.db.query(
      `INSERT INTO moderation_shadowbans (guild_id, user_id, prison_channel_id, previous_state, executor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [guildId, userId, prisonChannelId, JSON.stringify(previousState ?? {}), executorId, reason ? String(reason).slice(0, 512) : null, new Date()],
    );
  }

  async removeShadowban(guildId, userId) {
    await this.db.query('DELETE FROM moderation_shadowbans WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  /** Tous les shadow-bans actifs du serveur (panel web), les plus récents d'abord. */
  async listShadowbans(guildId) {
    return this.db.query('SELECT * FROM moderation_shadowbans WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
  }

  // ── Modification d'une sanction ──────────────────────────────────────────

  /** `patch` : sous-ensemble de { reason, expiresAt, durationS } ; trace de qui a modifié et quand. */
  async editAction(id, patch, editedBy) {
    const sets = ['edited_at = ?', 'edited_by = ?'];
    const values = [new Date(), editedBy];
    if ('reason' in patch) {
      sets.push('reason = ?');
      values.push(patch.reason ? String(patch.reason).slice(0, 512) : null);
    }
    if ('expiresAt' in patch) {
      sets.push('expires_at = ?');
      values.push(patch.expiresAt);
    }
    if ('durationS' in patch) {
      sets.push('duration_s = ?');
      values.push(patch.durationS);
    }
    values.push(id);
    await this.db.query(`UPDATE moderation_actions SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  // ── Bans temporaires ─────────────────────────────────────────────────────

  async dueTempBans(before = new Date()) {
    return this.db.query(`SELECT * FROM moderation_actions WHERE action = 'tempban' AND active = 1 AND expires_at <= ?`, [before]);
  }

  async activeTempBan(guildId, userId) {
    return this.db.one(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND target_id = ? AND action = 'tempban' AND active = 1 ORDER BY created_at DESC LIMIT 1`,
      [guildId, userId],
    );
  }

  /** Débannissement (quel qu'en soit l'auteur) : les bans et bans temporaires en cours du membre sont clos. */
  async resolveBans(guildId, userId, resolvedBy) {
    await this.db.query(
      `UPDATE moderation_actions SET active = 0, resolved_at = ?, resolved_by = ?
        WHERE guild_id = ? AND target_id = ? AND action IN ('ban', 'tempban') AND active = 1`,
      [new Date(), resolvedBy, guildId, userId],
    );
  }

  /** Bans temporaires actifs du serveur : Map(userId → ligne), pour afficher l'échéance sur le panel. */
  async activeTempBansForGuild(guildId) {
    const rows = await this.db.query(`SELECT * FROM moderation_actions WHERE guild_id = ? AND action = 'tempban' AND active = 1`, [guildId]);
    return new Map(rows.map((row) => [String(row.target_id), row]));
  }

  // ── Verrouillages temporaires ────────────────────────────────────────────

  async setUnlockAt(guildId, channelId, unlockAt) {
    await this.db.query('UPDATE moderation_channel_locks SET unlock_at = ? WHERE guild_id = ? AND channel_id = ?', [unlockAt, guildId, channelId]);
  }

  async dueUnlocks(before = new Date()) {
    return this.db.query('SELECT guild_id, channel_id, unlock_at FROM moderation_channel_locks WHERE unlock_at IS NOT NULL AND unlock_at <= ?', [before]);
  }

  async lockInfo(guildId) {
    const rows = await this.db.query('SELECT channel_id, unlock_at FROM moderation_channel_locks WHERE guild_id = ?', [guildId]);
    return new Map(rows.map((row) => [String(row.channel_id), row.unlock_at]));
  }

  // ── Sanctions automatiques au cumul d'avertissements ─────────────────────

  async listWarnRules(guildId) {
    return this.db.query('SELECT * FROM moderation_warn_rules WHERE guild_id = ? ORDER BY warn_count ASC', [guildId]);
  }

  async saveWarnRule(guildId, { warnCount, action, durationMinutes }) {
    await this.db.query(
      `INSERT INTO moderation_warn_rules (guild_id, warn_count, action, duration_minutes, created_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), duration_minutes = VALUES(duration_minutes)`,
      [guildId, warnCount, action, durationMinutes ?? null, new Date()],
    );
  }

  async deleteWarnRule(guildId, id) {
    await this.db.query('DELETE FROM moderation_warn_rules WHERE guild_id = ? AND id = ?', [guildId, id]);
  }

  // ── Automod ──────────────────────────────────────────────────────────────

  /** Mots interdits et mots autorisés (faux positifs) du serveur, mis en cache (invalidé à l'écriture). */
  async automodLists(guildId) {
    const cached = this.automodCache.get(guildId);
    if (cached) return cached;
    const [words, allow] = await Promise.all([
      this.db.query('SELECT id, word, added_by, created_at FROM moderation_automod_words WHERE guild_id = ? ORDER BY word ASC', [guildId]),
      this.db.query('SELECT token, added_by, created_at FROM moderation_automod_allow WHERE guild_id = ? ORDER BY token ASC', [guildId]),
    ]);
    const lists = { words, allow, allowSet: new Set(allow.map((row) => row.token)) };
    this.automodCache.set(guildId, lists);
    return lists;
  }

  async addAutomodWords(guildId, words, by) {
    for (const word of words) {
      await this.db.query('INSERT IGNORE INTO moderation_automod_words (guild_id, word, added_by, created_at) VALUES (?, ?, ?, ?)', [guildId, word, by, new Date()]);
    }
    this.automodCache.delete(guildId);
  }

  async deleteAutomodWord(guildId, id) {
    await this.db.query('DELETE FROM moderation_automod_words WHERE guild_id = ? AND id = ?', [guildId, id]);
    this.automodCache.delete(guildId);
  }

  async allowToken(guildId, token, by) {
    await this.db.query('INSERT IGNORE INTO moderation_automod_allow (guild_id, token, added_by, created_at) VALUES (?, ?, ?, ?)', [guildId, token, by, new Date()]);
    this.automodCache.delete(guildId);
  }

  async disallowToken(guildId, token) {
    await this.db.query('DELETE FROM moderation_automod_allow WHERE guild_id = ? AND token = ?', [guildId, token]);
    this.automodCache.delete(guildId);
  }

  async recordAutomodHit(hit) {
    await this.db.query(
      `INSERT INTO moderation_automod_hits (guild_id, user_id, channel_id, content, matched_word, token, score, action, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hit.guildId, hit.userId, hit.channelId, hit.content ? String(hit.content).slice(0, 2000) : null, hit.word, hit.token.slice(0, 100), hit.score, hit.action, new Date()],
    );
  }

  async listAutomodHits(guildId, limit = 100) {
    return this.db.query('SELECT * FROM moderation_automod_hits WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?', [guildId, limit]);
  }

  async getAutomodHit(guildId, id) {
    return this.db.one('SELECT * FROM moderation_automod_hits WHERE guild_id = ? AND id = ?', [guildId, id]);
  }

  async markFalsePositive(guildId, id, by, value = true) {
    await this.db.query('UPDATE moderation_automod_hits SET false_positive = ?, reviewed_by = ? WHERE guild_id = ? AND id = ?', [value ? 1 : 0, by, guildId, id]);
  }

  // ── Notes internes ───────────────────────────────────────────────────────

  async listNotes(guildId, userId) {
    return this.db.query('SELECT * FROM moderation_notes WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100', [guildId, userId]);
  }

  async addNote(guildId, userId, authorId, content) {
    const result = await this.db.query('INSERT INTO moderation_notes (guild_id, user_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)', [
      guildId,
      userId,
      authorId,
      String(content).slice(0, 2000),
      new Date(),
    ]);
    return result.insertId;
  }

  async getNote(guildId, id) {
    return this.db.one('SELECT * FROM moderation_notes WHERE guild_id = ? AND id = ?', [guildId, id]);
  }

  async deleteNote(guildId, id) {
    const result = await this.db.query('DELETE FROM moderation_notes WHERE guild_id = ? AND id = ?', [guildId, id]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  // ── Contestations ────────────────────────────────────────────────────────

  async appealFor(actionId) {
    return this.db.one('SELECT * FROM moderation_appeals WHERE action_id = ?', [actionId]);
  }

  async recordAppeal({ actionId, guildId, userId, ticketId, reason }) {
    await this.db.query('INSERT INTO moderation_appeals (action_id, guild_id, user_id, ticket_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      actionId,
      guildId,
      userId,
      ticketId ?? null,
      reason ? String(reason).slice(0, 2000) : null,
      new Date(),
    ]);
  }

  /** Sanctions d'un membre qu'il peut encore contester (récentes, pas déjà contestées). */
  async appealableActions(guildId, userId, types) {
    return this.db.query(
      `SELECT a.* FROM moderation_actions a LEFT JOIN moderation_appeals p ON p.action_id = a.id
        WHERE a.guild_id = ? AND a.target_id = ? AND a.action IN (?) AND p.action_id IS NULL
        ORDER BY a.created_at DESC LIMIT 25`,
      [guildId, userId, types],
    );
  }

  // ── Tempvocmute (surveillé par le planificateur) ─────────────────────────

  async dueTempVocMutes(before = new Date()) {
    return this.db.query(`SELECT * FROM moderation_actions WHERE action = 'tempvocmute' AND active = 1 AND expires_at <= ?`, [before]);
  }

  async activeTempVocMute(guildId, userId) {
    return this.db.one(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND target_id = ? AND action = 'tempvocmute' AND active = 1
       ORDER BY created_at DESC LIMIT 1`,
      [guildId, userId],
    );
  }

  /** Tous les mutes vocaux temporaires actifs du serveur (panel web), les plus proches de l'échéance d'abord. */
  async activeTempVocMutesForGuild(guildId) {
    return this.db.query(
      `SELECT * FROM moderation_actions WHERE guild_id = ? AND action = 'tempvocmute' AND active = 1 ORDER BY expires_at ASC`,
      [guildId],
    );
  }
}

module.exports = { ModerationService };
