'use strict';

const { FINAL_STATUSES, ACTIVE_STATUSES } = require('./statuses');
const { normalizeCriteria } = require('./criteria');
const { normalizeQuestions } = require('./form');

function fromJson(value, fallback = []) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapCategory(row) {
  if (!row) return null;
  return {
    ...row,
    recruiter_role_ids: fromJson(row.recruiter_role_ids).map(String),
    notify_role_ids: fromJson(row.notify_role_ids).map(String),
    form_questions: normalizeQuestions(fromJson(row.form_questions)),
    criteria: normalizeCriteria(fromJson(row.criteria, {})),
  };
}

function mapCandidature(row) {
  if (!row) return null;
  return { ...row, form_answers: fromJson(row.form_answers), check_failures: fromJson(row.check_failures) };
}

/** Colonnes modifiables par `updateCategory` / `updateSettings` (jamais de nom de colonne venant de l'extérieur). */
const CATEGORY_COLUMNS = new Set([
  'label', 'emoji', 'button_style', 'select_description', 'category_id', 'recruiter_role_ids', 'notify_role_ids', 'max_open', 'cooldown_days',
  'accept_role_id', 'channel_name_pattern', 'auto_check', 'criteria', 'form_enabled', 'form_title', 'form_questions', 'opened_title',
  'opened_description', 'opened_color', 'opened_footer', 'opened_image', 'opened_thumbnail', 'position',
]);
const SETTINGS_COLUMNS = new Set([
  'log_channel_id', 'refusal_reason_required', 'auto_replies', 'panel_channel_id', 'panel_message_id', 'panel_style', 'panel_title',
  'panel_description', 'panel_color', 'panel_footer', 'panel_image', 'panel_thumbnail',
]);
const JSON_COLUMNS = new Set(['recruiter_role_ids', 'notify_role_ids', 'criteria', 'form_questions', 'auto_replies']);

function placeholders(list) {
  return list.map(() => '?').join(', ');
}

/** Accès aux données du module Candidature. */
class CandidatureService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.settingsCache = new Map();
    // Index mémoire des salons de candidature : un message hors de ces salons ne coûte aucune requête.
    this.channels = new Set();
  }

  async warmup() {
    const rows = await this.db.query('SELECT channel_id FROM cand_candidatures WHERE channel_deleted = 0');
    this.channels = new Set(rows.map((row) => String(row.channel_id)));
  }

  isCandidatureChannel(channelId) {
    return this.channels.has(String(channelId));
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const cached = this.settingsCache.get(String(guildId));
    if (cached) return cached;
    const row = await this.db.one('SELECT * FROM cand_settings WHERE guild_id = ?', [guildId]);
    const settings = {
      logChannelId: row?.log_channel_id ? String(row.log_channel_id) : null,
      refusalReasonRequired: row ? Boolean(Number(row.refusal_reason_required)) : true,
      autoReplies: fromJson(row?.auto_replies, {}) ?? {},
      panel: {
        channelId: row?.panel_channel_id ? String(row.panel_channel_id) : null,
        messageId: row?.panel_message_id ? String(row.panel_message_id) : null,
        style: row?.panel_style ?? 'buttons',
        title: row?.panel_title ?? null,
        description: row?.panel_description ?? null,
        color: row?.panel_color ?? null,
        footer: row?.panel_footer ?? null,
        image: row?.panel_image ?? null,
        thumbnail: row?.panel_thumbnail ?? null,
      },
    };
    this.settingsCache.set(String(guildId), settings);
    return settings;
  }

  async updateSettings(guildId, patch) {
    const entries = Object.entries(patch).filter(([key]) => SETTINGS_COLUMNS.has(key));
    if (!entries.length) return;
    const columns = entries.map(([key]) => key);
    const values = entries.map(([key, value]) => (JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value));
    await this.db.query(
      `INSERT INTO cand_settings (guild_id, ${columns.join(', ')}, updated_at) VALUES (?, ${placeholders(columns)}, ?)
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_at = VALUES(updated_at)`,
      [guildId, ...values, new Date()],
    );
    this.settingsCache.delete(String(guildId));
  }

  // ── Catégories ────────────────────────────────────────────────────────────

  async listCategories(guildId) {
    const rows = await this.db.query('SELECT * FROM cand_categories WHERE guild_id = ? ORDER BY position ASC, id ASC', [guildId]);
    return rows.map(mapCategory);
  }

  async getCategory(id) {
    return mapCategory(await this.db.one('SELECT * FROM cand_categories WHERE id = ?', [id]));
  }

  async createCategory(guildId, label) {
    const position = await this.db.one('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM cand_categories WHERE guild_id = ?', [guildId]);
    const result = await this.db.query('INSERT INTO cand_categories (guild_id, label, position, created_at) VALUES (?, ?, ?, ?)', [guildId, label, Number(position?.n ?? 1), new Date()]);
    return this.getCategory(result.insertId);
  }

  async updateCategory(id, patch) {
    const entries = Object.entries(patch).filter(([key]) => CATEGORY_COLUMNS.has(key));
    if (!entries.length) return;
    const values = entries.map(([key, value]) => (JSON_COLUMNS.has(key) && value !== null ? JSON.stringify(value) : value));
    await this.db.query(`UPDATE cand_categories SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
  }

  async deleteCategory(id) {
    await this.db.query('DELETE FROM cand_categories WHERE id = ?', [id]);
  }

  // ── Candidatures ──────────────────────────────────────────────────────────

  async createCandidature({ guildId, categoryId, channelId, applicantId, formAnswers = null }) {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO cand_candidatures (guild_id, category_id, channel_id, applicant_id, status, form_answers, status_at, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [guildId, categoryId, channelId, applicantId, formAnswers?.length ? JSON.stringify(formAnswers) : null, now, now],
    );
    this.channels.add(String(channelId));
    await this.addEvent(result.insertId, 'opened', { status: 'draft', actorId: applicantId });
    return this.getCandidature(result.insertId);
  }

  async getCandidature(id) {
    return mapCandidature(await this.db.one('SELECT * FROM cand_candidatures WHERE id = ?', [id]));
  }

  async getByChannel(channelId) {
    return mapCandidature(await this.db.one('SELECT * FROM cand_candidatures WHERE channel_id = ? ORDER BY id DESC LIMIT 1', [channelId]));
  }

  /** Candidatures non terminées du serveur (en rédaction comprises), les plus anciennes d'abord. */
  async listActive(guildId) {
    const rows = await this.db.query(`SELECT * FROM cand_candidatures WHERE guild_id = ? AND status IN (${placeholders(ACTIVE_STATUSES)}) ORDER BY created_at ASC, id ASC`, [guildId, ...ACTIVE_STATUSES]);
    return rows.map(mapCandidature);
  }

  async listByApplicant(guildId, applicantId, { limit = 50 } = {}) {
    const rows = await this.db.query('SELECT * FROM cand_candidatures WHERE guild_id = ? AND applicant_id = ? ORDER BY id DESC LIMIT ?', [guildId, applicantId, limit]);
    return rows.map(mapCandidature);
  }

  /** Recherche paginée. `scope: 'closed'` = terminées seulement, `'all'` = toutes. `categoryIds` restreint (portée du recruteur). */
  async search(guildId, { scope = 'closed', applicantId = null, status = null, categoryId = null, categoryIds = null, limit = 50, offset = 0 } = {}) {
    const where = ['guild_id = ?'];
    const params = [guildId];
    if (status) {
      where.push('status = ?');
      params.push(status);
    } else if (scope === 'closed') {
      where.push(`status IN (${placeholders(FINAL_STATUSES)})`);
      params.push(...FINAL_STATUSES);
    }
    if (applicantId) {
      where.push('applicant_id = ?');
      params.push(applicantId);
    }
    if (categoryId) {
      where.push('category_id = ?');
      params.push(categoryId);
    }
    if (categoryIds) {
      if (!categoryIds.length) return { rows: [], total: 0 };
      where.push(`category_id IN (${placeholders(categoryIds)})`);
      params.push(...categoryIds);
    }
    const clause = where.join(' AND ');
    const [rows, count] = await Promise.all([
      this.db.query(`SELECT * FROM cand_candidatures WHERE ${clause} ORDER BY COALESCE(closed_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      this.db.one(`SELECT COUNT(*) AS n FROM cand_candidatures WHERE ${clause}`, params),
    ]);
    return { rows: rows.map(mapCandidature), total: Number(count?.n ?? 0) };
  }

  async activeCountForCategory(categoryId) {
    const row = await this.db.one(`SELECT COUNT(*) AS n FROM cand_candidatures WHERE category_id = ? AND status IN (${placeholders(ACTIVE_STATUSES)})`, [categoryId, ...ACTIVE_STATUSES]);
    return Number(row?.n ?? 0);
  }

  async activeForUser(categoryId, userId) {
    return mapCandidature(
      await this.db.one(`SELECT * FROM cand_candidatures WHERE category_id = ? AND applicant_id = ? AND status IN (${placeholders(ACTIVE_STATUSES)}) ORDER BY id DESC LIMIT 1`, [categoryId, userId, ...ACTIVE_STATUSES]),
    );
  }

  /** Dernier refus du candidat dans cette catégorie (pour le délai de représentation). */
  async lastRefusal(categoryId, userId) {
    return this.db.one(`SELECT status_at FROM cand_candidatures WHERE category_id = ? AND applicant_id = ? AND status = 'refused' ORDER BY status_at DESC LIMIT 1`, [categoryId, userId]);
  }

  async setStatus(id, { status, reason = null, by = null, final = false }) {
    const now = new Date();
    await this.db.query(
      `UPDATE cand_candidatures SET status = ?, status_reason = ?, status_by = ?, status_at = ?, closed_at = ?, submitted_at = COALESCE(submitted_at, ?) WHERE id = ?`,
      [status, reason, by, now, final ? now : null, status === 'draft' || status === 'withdrawn' ? null : now, id],
    );
    await this.addEvent(id, 'status', { status, actorId: by, detail: reason });
  }

  async setCheckFailures(id, failures) {
    await this.db.query('UPDATE cand_candidatures SET check_failures = ? WHERE id = ?', [failures?.length ? JSON.stringify(failures) : null, id]);
  }

  async setCategoryOf(id, categoryId, actorId, detail) {
    await this.db.query('UPDATE cand_candidatures SET category_id = ? WHERE id = ?', [categoryId, id]);
    await this.addEvent(id, 'category', { actorId, detail });
  }

  async setControlMessage(id, messageId) {
    await this.db.query('UPDATE cand_candidatures SET control_message_id = ? WHERE id = ?', [messageId, id]);
  }

  async markChannelDeleted(id, actorId = null) {
    const row = await this.getCandidature(id);
    await this.db.query('UPDATE cand_candidatures SET channel_deleted = 1 WHERE id = ?', [id]);
    if (row) this.channels.delete(String(row.channel_id));
    await this.addEvent(id, 'deleted', { actorId });
  }

  // ── Historique des événements ─────────────────────────────────────────────

  async addEvent(candidatureId, kind, { status = null, actorId = null, detail = null } = {}) {
    await this.db.query('INSERT INTO cand_events (candidature_id, kind, status, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      candidatureId,
      kind,
      status,
      actorId,
      detail ? String(detail).slice(0, 1000) : null,
      new Date(),
    ]);
  }

  async listEvents(candidatureId) {
    return this.db.query('SELECT * FROM cand_events WHERE candidature_id = ? ORDER BY id ASC', [candidatureId]);
  }

  // ── Transcription ─────────────────────────────────────────────────────────

  async appendMessage(m) {
    const result = await this.db.query(
      `INSERT INTO cand_messages (candidature_id, message_id, author_id, author_name, author_avatar, author_role_color, author_bot, content, embeds, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [m.candidatureId, m.messageId, m.authorId, String(m.authorName).slice(0, 100), m.authorAvatar ?? null, m.authorRoleColor ?? null, m.authorBot ? 1 : 0, m.content ?? null, m.embeds ? JSON.stringify(m.embeds) : null, m.attachments ? JSON.stringify(m.attachments) : null, m.createdAt ?? new Date()],
    );
    return result.insertId || null;
  }

  async setMessageAttachments(messageRowId, attachments) {
    await this.db.query('UPDATE cand_messages SET attachments = ? WHERE id = ?', [JSON.stringify(attachments), messageRowId]);
  }

  async updateMessage(messageId, content) {
    await this.db.query('UPDATE cand_messages SET content = ?, updated_at = ? WHERE message_id = ?', [content, new Date(), messageId]);
  }

  async listMessages(candidatureId) {
    const rows = await this.db.query('SELECT * FROM cand_messages WHERE candidature_id = ? ORDER BY id ASC', [candidatureId]);
    return rows.map((row) => ({ ...row, embeds: fromJson(row.embeds, null), attachments: fromJson(row.attachments, []) }));
  }

  /** Textes et nombre de pièces jointes envoyés par le candidat (pour le contrôle des critères). */
  async applicantContent(candidature) {
    const rows = await this.listMessages(candidature.id);
    const mine = rows.filter((row) => !Number(row.author_bot) && String(row.author_id) === String(candidature.applicant_id));
    return {
      messages: mine.map((row) => row.content).filter((text) => text && text.trim()),
      attachments: mine.reduce((total, row) => total + (row.attachments?.length ?? 0), 0),
      count: mine.length,
    };
  }

  async saveAttachment({ messageRowId, name, contentType, size, buffer }) {
    const result = await this.db.query('INSERT INTO cand_attachments (message_row_id, name, content_type, size, data) VALUES (?, ?, ?, ?, ?)', [messageRowId, name, contentType ?? null, size ?? buffer.length, buffer]);
    return result.insertId;
  }

  async getAttachment(id) {
    return this.db.one(
      `SELECT a.name, a.content_type, a.data, c.guild_id, c.id AS candidature_id
         FROM cand_attachments a
         JOIN cand_messages m ON m.id = a.message_row_id
         JOIN cand_candidatures c ON c.id = m.candidature_id
        WHERE a.id = ?`,
      [id],
    );
  }
}

module.exports = { CandidatureService };
