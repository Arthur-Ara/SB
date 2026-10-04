'use strict';

function toJson(value) {
  return JSON.stringify(value ?? []);
}

function fromJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Normalise une ligne `modmail_categories` (JSON -> tableau). */
function mapModmailCategory(row) {
  if (!row) return null;
  return { ...row, staff_role_ids: fromJson(row.staff_role_ids) };
}

/** Normalise une ligne `modmail_threads` (JSON -> tableau). */
function mapModmailThread(row) {
  if (!row) return null;
  return { ...row, staff_role_ids: fromJson(row.staff_role_ids) };
}

/** Normalise une ligne `ticket_types` (JSON -> tableaux) pour tout le reste du module. */
function mapType(row) {
  if (!row) return null;
  return {
    ...row,
    mod_role_ids: fromJson(row.mod_role_ids),
    notify_role_ids: fromJson(row.notify_role_ids),
    helper_role_ids: fromJson(row.helper_role_ids),
    reping_role_ids: fromJson(row.reping_role_ids),
    form_questions: fromJson(row.form_questions),
  };
}

/** Normalise une ligne `ticket_tags` (rôles mentionnés JSON -> tableau). */
function mapTag(row) {
  if (!row) return null;
  return { ...row, mention_role_ids: fromJson(row.mention_role_ids) };
}

/** Normalise une ligne `tickets` (réponses du formulaire JSON -> tableau). */
function mapTicket(row) {
  if (!row) return null;
  return { ...row, form_answers: fromJson(row.form_answers) };
}

/** Échappe les jokers d'un motif LIKE (% et _) saisis par l'utilisateur. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Accès aux données du module Tickets : réglages, admins, panels, types (un bouton/option =
 * une config complète et indépendante), tickets, membres ajoutés et messages capturés pour le
 * transcript.
 */
class TicketService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.settingsCache = new Map();
    // Index mémoire des salons concernés : chaque message posté sur un serveur ne coûte plus de requête SQL
    // quand il ne s'agit ni d'un ticket ni d'un fil modmail (le cas de l'immense majorité des messages).
    this.ticketChannels = new Set();
    this.modmailChannels = new Set();
  }

  /** Charge les index de salons (au démarrage du module). */
  async warmup() {
    const [ticketRows, modmailRows] = await Promise.all([
      this.db.query('SELECT channel_id FROM tickets'),
      this.db.query(`SELECT channel_id FROM modmail_threads WHERE status = 'open'`),
    ]);
    this.ticketChannels = new Set(ticketRows.map((row) => String(row.channel_id)));
    // Un fil « panel uniquement » n'a pas de salon Discord (channel_id NULL).
    this.modmailChannels = new Set(modmailRows.filter((row) => row.channel_id).map((row) => String(row.channel_id)));
  }

  /** Ce salon est-il (ou a-t-il été) celui d'un ticket ? Réponse instantanée, sans base. */
  isTicketChannel(channelId) {
    return this.ticketChannels.has(String(channelId));
  }

  /** Ce salon est-il celui d'un fil modmail ouvert ? Réponse instantanée, sans base. */
  isModmailChannel(channelId) {
    return this.modmailChannels.has(String(channelId));
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const cached = this.settingsCache.get(guildId);
    if (cached) return cached;
    const row = await this.db.one('SELECT log_channel_id FROM ticket_settings WHERE guild_id = ?', [guildId]);
    const settings = { logChannelId: row?.log_channel_id ?? null };
    this.settingsCache.set(guildId, settings);
    return settings;
  }

  invalidateSettings(guildId) {
    this.settingsCache.delete(guildId);
  }

  async setLogChannel(guildId, logChannelId) {
    await this.db.query(
      `INSERT INTO ticket_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, logChannelId, new Date()],
    );
    this.invalidateSettings(guildId);
  }

  // ── Modmail ───────────────────────────────────────────────────────────────

  /** Interrupteur général (par serveur) : le modmail reste inactif tant qu'aucune catégorie n'existe. */
  async modmailEnabled(guildId) {
    const row = await this.db.one('SELECT modmail_enabled FROM ticket_settings WHERE guild_id = ?', [guildId]);
    return Boolean(Number(row?.modmail_enabled ?? 0));
  }

  async setModmailEnabled(guildId, enabled) {
    await this.db.query(
      `INSERT INTO ticket_settings (guild_id, modmail_enabled, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE modmail_enabled = VALUES(modmail_enabled), updated_at = VALUES(updated_at)`,
      [guildId, enabled ? 1 : 0, new Date()],
    );
  }

  async listModmailCategories(guildId) {
    const rows = await this.db.query('SELECT * FROM modmail_categories WHERE guild_id = ? ORDER BY position ASC, id ASC', [guildId]);
    return rows.map(mapModmailCategory);
  }

  async getModmailCategory(id) {
    return mapModmailCategory(await this.db.one('SELECT * FROM modmail_categories WHERE id = ?', [id]));
  }

  async createModmailCategory(guildId, name) {
    const [{ n } = { n: 0 }] = await this.db.query('SELECT COUNT(*) AS n FROM modmail_categories WHERE guild_id = ?', [guildId]);
    const result = await this.db.query(
      `INSERT INTO modmail_categories (guild_id, name, category_id, staff_role_ids, position, created_at) VALUES (?, ?, NULL, '[]', ?, ?)`,
      [guildId, name, n, new Date()],
    );
    return this.getModmailCategory(result.insertId);
  }

  /** `patch` : sous-ensemble de { name, categoryId, staffRoleIds, welcomeMessage, autoCloseHours, panelOnly }. */
  async updateModmailCategory(id, patch) {
    const columns = [];
    const values = [];
    if ('panelOnly' in patch) {
      columns.push('panel_only = ?');
      values.push(patch.panelOnly ? 1 : 0);
    }
    if ('welcomeMessage' in patch) {
      columns.push('welcome_message = ?');
      values.push(patch.welcomeMessage);
    }
    if ('autoCloseHours' in patch) {
      columns.push('auto_close_hours = ?');
      values.push(patch.autoCloseHours);
    }
    if ('name' in patch) {
      columns.push('name = ?');
      values.push(patch.name);
    }
    if ('categoryId' in patch) {
      columns.push('category_id = ?');
      values.push(patch.categoryId);
    }
    if ('staffRoleIds' in patch) {
      columns.push('staff_role_ids = ?');
      values.push(toJson(patch.staffRoleIds));
    }
    if (!columns.length) return this.getModmailCategory(id);
    values.push(id);
    await this.db.query(`UPDATE modmail_categories SET ${columns.join(', ')} WHERE id = ?`, values);
    return this.getModmailCategory(id);
  }

  async deleteModmailCategory(id) {
    await this.db.query('DELETE FROM modmail_categories WHERE id = ?', [id]);
  }

  async createModmailThread({ guildId, userId, channelId, openedBy = null, category }) {
    const result = await this.db.query(
      `INSERT INTO modmail_threads (guild_id, user_id, channel_id, status, opened_by, category_id, category_name, staff_role_ids, created_at, last_message_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      [guildId, userId, channelId ?? null, openedBy, category?.id ?? null, category?.name ?? null, toJson(category?.staff_role_ids ?? []), new Date(), new Date()],
    );
    if (channelId) this.modmailChannels.add(String(channelId));
    return mapModmailThread(await this.db.one('SELECT * FROM modmail_threads WHERE id = ?', [result.insertId]));
  }

  async openModmailForUser(guildId, userId) {
    return mapModmailThread(await this.db.one(`SELECT * FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND status = 'open'`, [guildId, userId]));
  }

  /** Fils ouverts de ce membre, tous serveurs confondus (un message privé est rattaché au fil actif). */
  async openModmailsForUser(userId) {
    const rows = await this.db.query(`SELECT * FROM modmail_threads WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC`, [userId]);
    return rows.map(mapModmailThread);
  }

  async modmailByChannel(channelId) {
    return mapModmailThread(await this.db.one(`SELECT * FROM modmail_threads WHERE channel_id = ? AND status = 'open'`, [channelId]));
  }

  async getModmailThread(id) {
    return mapModmailThread(await this.db.one('SELECT * FROM modmail_threads WHERE id = ?', [id]));
  }

  async listModmailThreads(guildId, { status, limit = 100 } = {}) {
    const rows = status
      ? await this.db.query('SELECT * FROM modmail_threads WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?', [guildId, status, limit])
      : await this.db.query('SELECT * FROM modmail_threads WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?', [guildId, limit]);
    return rows.map(mapModmailThread);
  }

  /** Activité dans un fil (message du membre ou du staff) : repousse la fermeture automatique. */
  async touchModmail(threadId) {
    await this.db.query('UPDATE modmail_threads SET last_message_at = ? WHERE id = ?', [new Date(), threadId]);
  }

  /** Fils ouverts inactifs au-delà du délai de fermeture automatique de leur catégorie. */
  async dueModmailAutoClose() {
    const rows = await this.db.query(
      `SELECT t.*, c.auto_close_hours FROM modmail_threads t JOIN modmail_categories c ON c.id = t.category_id
        WHERE t.status = 'open' AND c.auto_close_hours IS NOT NULL
          AND COALESCE(t.last_message_at, t.created_at) <= DATE_SUB(NOW(), INTERVAL c.auto_close_hours HOUR)
        LIMIT 50`,
    );
    return rows.map(mapModmailThread);
  }

  // ── Préfixes de grade (modmail) ──────────────────────────────────────────

  /** Préfixes du serveur : Map(roleId → préfixe), mise en cache (invalidée à l'écriture). */
  async rolePrefixes(guildId) {
    if (!this.prefixCache) this.prefixCache = new Map();
    const cached = this.prefixCache.get(guildId);
    if (cached) return cached;
    const rows = await this.db.query('SELECT role_id, prefix FROM modmail_role_prefixes WHERE guild_id = ?', [guildId]);
    const map = new Map(rows.map((row) => [String(row.role_id), row.prefix]));
    this.prefixCache.set(guildId, map);
    return map;
  }

  async setRolePrefix(guildId, roleId, prefix) {
    await this.db.query(
      `INSERT INTO modmail_role_prefixes (guild_id, role_id, prefix) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE prefix = VALUES(prefix)`,
      [guildId, roleId, prefix],
    );
    this.prefixCache?.delete(guildId);
  }

  async deleteRolePrefix(guildId, roleId) {
    await this.db.query('DELETE FROM modmail_role_prefixes WHERE guild_id = ? AND role_id = ?', [guildId, roleId]);
    this.prefixCache?.delete(guildId);
  }

  /** Serveurs où le modmail est activé ET a au moins une catégorie (une seule requête pour tous les serveurs). */
  async modmailReadyGuildIds() {
    const rows = await this.db.query(
      `SELECT DISTINCT c.guild_id FROM modmail_categories c
         JOIN ticket_settings s ON s.guild_id = c.guild_id
        WHERE s.modmail_enabled = 1`,
    );
    return new Set(rows.map((row) => String(row.guild_id)));
  }

  async closeModmail(id, closedBy, reason) {
    const row = await this.db.one('SELECT channel_id FROM modmail_threads WHERE id = ?', [id]);
    if (row?.channel_id) this.modmailChannels.delete(String(row.channel_id));
    await this.db.query(`UPDATE modmail_threads SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ? WHERE id = ?`, [
      closedBy,
      reason ?? null,
      new Date(),
      id,
    ]);
  }

  // ── Messages capturés du modmail (transcript web) ───────────────────────

  async appendModmailMessage(row) {
    try {
      const result = await this.db.query(
        `INSERT INTO modmail_messages (thread_id, message_id, author_id, author_name, author_avatar, author_bot, kind, content, embeds, attachments, created_at, via_web, anonymous)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.threadId,
          row.messageId ?? null,
          row.authorId,
          row.authorName,
          row.authorAvatar ?? null,
          row.authorBot ? 1 : 0,
          row.kind ?? 'member',
          row.content ?? null,
          row.embeds ? JSON.stringify(row.embeds) : null,
          row.attachments ? JSON.stringify(row.attachments) : null,
          row.createdAt ?? new Date(),
          row.viaWeb ? 1 : 0,
          row.anonymous ? 1 : 0,
        ],
      );
      return result.insertId;
    } catch (err) {
      if (/Duplicate entry/i.test(err.message)) return null;
      throw err;
    }
  }

  async setModmailMessageAttachments(messageRowId, attachments) {
    await this.db.query('UPDATE modmail_messages SET attachments = ? WHERE id = ?', [JSON.stringify(attachments), messageRowId]);
  }

  async saveModmailAttachment({ messageRowId, name, contentType, size, buffer }) {
    const result = await this.db.query(
      `INSERT INTO modmail_attachments (message_row_id, name, content_type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [messageRowId, name, contentType ?? null, size ?? buffer.length, buffer, new Date()],
    );
    return result.insertId;
  }

  /** Pièce jointe + serveur du fil auquel elle appartient (contrôle d'accès du panel web). */
  async getModmailAttachment(id) {
    return this.db.one(
      `SELECT a.name, a.content_type, a.data, t.guild_id, m.thread_id
         FROM modmail_attachments a
         JOIN modmail_messages m ON m.id = a.message_row_id
         JOIN modmail_threads t ON t.id = m.thread_id
        WHERE a.id = ?`,
      [id],
    );
  }

  async listModmailMessages(threadId, { after = 0 } = {}) {
    const rows = await this.db.query('SELECT * FROM modmail_messages WHERE thread_id = ? AND id > ? ORDER BY created_at ASC', [threadId, after]);
    return rows.map((row) => ({
      ...row,
      embeds: row.embeds ? (typeof row.embeds === 'string' ? JSON.parse(row.embeds) : row.embeds) : [],
      attachments: row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [],
    }));
  }

  // ── Admins du module (/ticket admin) ────────────────────────────────────

  async listAdmins(guildId) {
    return this.db.query('SELECT user_id, added_by, added_at FROM ticket_admins WHERE guild_id = ? ORDER BY added_at ASC', [guildId]);
  }

  async isAdmin(guildId, userId) {
    const row = await this.db.one('SELECT 1 AS x FROM ticket_admins WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return Boolean(row);
  }

  async addAdmin(guildId, userId, addedBy) {
    await this.db.query(
      `INSERT INTO ticket_admins (guild_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE added_by = VALUES(added_by), added_at = VALUES(added_at)`,
      [guildId, userId, addedBy, new Date()],
    );
  }

  async removeAdmin(guildId, userId) {
    await this.db.query('DELETE FROM ticket_admins WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  // ── Panels ────────────────────────────────────────────────────────────────

  async listPanels(guildId) {
    return this.db.query('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at ASC', [guildId]);
  }

  async getPanel(id) {
    return this.db.one('SELECT * FROM ticket_panels WHERE id = ?', [id]);
  }

  async createPanel(guildId, createdBy) {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO ticket_panels (guild_id, style, open_title, open_description, created_by, created_at, updated_at)
       VALUES (?, 'buttons', ?, ?, ?, ?, ?)`,
      [guildId, 'Support', 'Clique sur un bouton ci-dessous pour ouvrir un ticket.', createdBy, now, now],
    );
    return this.getPanel(result.insertId);
  }

  /** `patch` : sous-ensemble de { style, open_title, open_description, open_color, open_footer, open_image, open_thumbnail }. */
  async updatePanel(id, patch) {
    const columns = [
      'style', 'open_title', 'open_description', 'open_color', 'open_footer', 'open_image', 'open_thumbnail',
      'schedule_enabled', 'schedule_start', 'schedule_end', 'schedule_timezone',
    ];
    const sets = [];
    const values = [];
    for (const column of columns) {
      if (!(column in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[column]);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    values.push(new Date());
    values.push(id);
    await this.db.query(`UPDATE ticket_panels SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  async setPanelMessage(id, channelId, messageId) {
    await this.db.query('UPDATE ticket_panels SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?', [
      channelId,
      messageId,
      new Date(),
      id,
    ]);
  }

  async deletePanel(id) {
    await this.db.query('DELETE FROM ticket_types WHERE panel_id = ?', [id]);
    await this.db.query('DELETE FROM ticket_panels WHERE id = ?', [id]);
  }

  // ── Types (boutons / options d'un panel) ─────────────────────────────────

  async listTypes(panelId) {
    const rows = await this.db.query('SELECT * FROM ticket_types WHERE panel_id = ? ORDER BY position ASC, id ASC', [panelId]);
    return rows.map(mapType);
  }

  async getType(id) {
    return mapType(await this.db.one('SELECT * FROM ticket_types WHERE id = ?', [id]));
  }

  /** Tous les types de tickets du serveur, tous panels confondus — pour d'autres modules (ex. Support automatique). */
  async listAllTypes(guildId) {
    const rows = await this.db.query(
      `SELECT y.* FROM ticket_types y JOIN ticket_panels p ON p.id = y.panel_id WHERE p.guild_id = ? ORDER BY y.label ASC`,
      [guildId],
    );
    return rows.map(mapType);
  }

  async createType(panelId, label) {
    const now = new Date();
    const [{ n } = { n: 0 }] = await this.db.query('SELECT COUNT(*) AS n FROM ticket_types WHERE panel_id = ?', [panelId]);
    const result = await this.db.query(
      `INSERT INTO ticket_types
         (panel_id, position, label, button_style, mod_role_ids, notify_role_ids, helper_role_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'primary', '[]', '[]', '[]', ?, ?)`,
      [panelId, Number(n) || 0, label, now, now],
    );
    return this.getType(result.insertId);
  }

  /**
   * `patch` : sous-ensemble des colonnes de `ticket_types` (hors id/panel_id/created_at). Les
   * champs `*_role_ids` sont sérialisés automatiquement si présents en tant que tableaux.
   */
  async updateType(id, patch) {
    const columns = [
      'position', 'label', 'emoji', 'button_style', 'select_description', 'channel_name_pattern', 'category_id', 'max_open',
      'mod_role_ids', 'notify_role_ids', 'helper_role_ids', 'reping_role_ids', 'reping_same_as_notify',
      'opened_title', 'opened_description', 'opened_color', 'opened_footer', 'opened_image', 'opened_thumbnail',
      'auto_transcript', 'transcript_prompt', 'live_transcript', 'user_can_close',
      'auto_close_minutes', 'reping_minutes',
      'claimed_channel_name_pattern', 'closed_channel_name_pattern', 'reping_message', 'close_on_leave',
      'rating_enabled', 'form_enabled', 'form_title', 'form_questions', 'auto_delete_hours', 'claim_required',
    ];
    const jsonColumns = new Set(['mod_role_ids', 'notify_role_ids', 'helper_role_ids', 'reping_role_ids', 'form_questions']);
    const sets = [];
    const values = [];
    for (const column of columns) {
      if (!(column in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(jsonColumns.has(column) ? toJson(patch[column]) : patch[column]);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    values.push(new Date());
    values.push(id);
    await this.db.query(`UPDATE ticket_types SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  async deleteType(id) {
    await this.db.query('DELETE FROM ticket_types WHERE id = ?', [id]);
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async openCountForType(typeId) {
    const row = await this.db.one(`SELECT COUNT(*) AS n FROM tickets WHERE type_id = ? AND status = 'open'`, [typeId]);
    return Number(row?.n ?? 0);
  }

  async openTicketForUser(typeId, userId) {
    return this.db.one(`SELECT * FROM tickets WHERE type_id = ? AND opener_id = ? AND status = 'open'`, [typeId, userId]);
  }

  async createTicket({ guildId, panelId, typeId, channelId, openerId, subject, formAnswers = null }) {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO tickets (guild_id, panel_id, type_id, channel_id, opener_id, status, subject, form_answers, last_message_at, last_message_is_staff, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?)`,
      [guildId, panelId, typeId, channelId, openerId, subject ?? null, formAnswers?.length ? JSON.stringify(formAnswers) : null, now, now],
    );
    this.ticketChannels.add(String(channelId));
    return this.getTicket(result.insertId);
  }

  async getTicket(id) {
    return mapTicket(await this.db.one('SELECT * FROM tickets WHERE id = ?', [id]));
  }

  /** Transfert vers un autre type (et son panel) : le sujet suit le nouveau libellé. */
  async transferTicket(id, { typeId, panelId, subject }) {
    await this.db.query('UPDATE tickets SET type_id = ?, panel_id = ?, subject = ? WHERE id = ?', [typeId, panelId, subject, id]);
  }

  /** Salon du ticket supprimé (par le bot ou à la main) : le ticket est archivé, plus aucun balayage ne le traite. */
  async markDeleted(id) {
    await this.db.query('UPDATE tickets SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?', [new Date(), id]);
  }

  /** Tickets fermés dont le salon doit être supprimé automatiquement (option `auto_delete_hours` du type). */
  async dueForAutoDelete() {
    const rows = await this.db.query(
      `SELECT t.* FROM tickets t JOIN ticket_types y ON y.id = t.type_id
        WHERE t.status = 'closed' AND t.deleted_at IS NULL AND y.auto_delete_hours IS NOT NULL
          AND t.closed_at IS NOT NULL AND t.closed_at <= DATE_SUB(NOW(), INTERVAL y.auto_delete_hours HOUR)
        LIMIT 50`,
    );
    return rows.map(mapTicket);
  }

  /**
   * Recherche dans l'historique (tickets fermés) : texte (n° de ticket, sujet, raison, réponses du formulaire,
   * contenu des messages), ouvreur, staff qui l'a pris en charge, type, étiquette, période de fermeture.
   * Renvoie { rows, total }.
   */
  /**
   * @param {{ typeIds: string[], userId: string } | null} [visibleTo] restreint aux tickets que ce membre du staff peut
   *   voir (types dont il a un rôle, ou ticket qu'il a ouvert, pris en charge ou auquel il a été ajouté) ; null = tout.
   */
  async searchClosedTickets(guildId, { q = null, openerId = null, staffId = null, typeId = null, tagId = null, from = null, to = null, limit = 50, offset = 0, visibleTo = null } = {}) {
    const where = ["t.guild_id = ?", "t.status = 'closed'"];
    const params = [guildId];
    if (visibleTo) {
      const typeIds = visibleTo.typeIds.map(Number).filter(Number.isInteger);
      where.push(
        `(${typeIds.length ? `t.type_id IN (${typeIds.map(() => '?').join(', ')}) OR ` : ''}t.opener_id = ? OR t.claimed_by = ?
          OR EXISTS (SELECT 1 FROM ticket_members tm WHERE tm.ticket_id = t.id AND tm.user_id = ?))`,
      );
      params.push(...typeIds, visibleTo.userId, visibleTo.userId, visibleTo.userId);
    }
    if (openerId) {
      where.push('t.opener_id = ?');
      params.push(openerId);
    }
    if (staffId) {
      where.push('t.claimed_by = ?');
      params.push(staffId);
    }
    if (typeId) {
      where.push('t.type_id = ?');
      params.push(typeId);
    }
    if (tagId) {
      where.push('EXISTS (SELECT 1 FROM ticket_tag_links l WHERE l.ticket_id = t.id AND l.tag_id = ?)');
      params.push(tagId);
    }
    if (from) {
      where.push('t.closed_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('t.closed_at < ?');
      params.push(to);
    }
    if (q) {
      const like = likePattern(q);
      where.push(
        `(CAST(t.id AS CHAR) = ? OR t.subject LIKE ? OR t.close_reason LIKE ? OR CAST(t.form_answers AS CHAR) LIKE ?
          OR EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.content LIKE ?))`,
      );
      params.push(String(q).replace(/^#/, ''), like, like, like, like);
    }
    const clause = where.join(' AND ');
    const [rows, count] = await Promise.all([
      this.db.query(`SELECT t.* FROM tickets t WHERE ${clause} ORDER BY t.closed_at DESC, t.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      this.db.one(`SELECT COUNT(*) AS n FROM tickets t WHERE ${clause}`, params),
    ]);
    return { rows: rows.map(mapTicket), total: Number(count?.n ?? 0) };
  }

  /** Membres du staff ayant déjà pris en charge au moins un ticket du serveur (filtre de l'historique). */
  async staffWhoClaimed(guildId) {
    const rows = await this.db.query('SELECT DISTINCT claimed_by FROM tickets WHERE guild_id = ? AND claimed_by IS NOT NULL', [guildId]);
    return rows.map((row) => String(row.claimed_by));
  }

  // ── Réponses prédéfinies ─────────────────────────────────────────────────

  async listSnippets(guildId) {
    return this.db.query('SELECT * FROM ticket_snippets WHERE guild_id = ? ORDER BY name ASC', [guildId]);
  }

  async getSnippet(id) {
    return this.db.one('SELECT * FROM ticket_snippets WHERE id = ?', [id]);
  }

  async snippetByName(guildId, name) {
    return this.db.one('SELECT * FROM ticket_snippets WHERE guild_id = ? AND name = ?', [guildId, name]);
  }

  async saveSnippet(guildId, { id = null, name, content, by }) {
    const now = new Date();
    if (id) {
      await this.db.query('UPDATE ticket_snippets SET name = ?, content = ?, updated_at = ? WHERE id = ? AND guild_id = ?', [name, content, now, id, guildId]);
      return this.getSnippet(id);
    }
    const result = await this.db.query(
      'INSERT INTO ticket_snippets (guild_id, name, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [guildId, name, content, by, now, now],
    );
    return this.getSnippet(result.insertId);
  }

  async deleteSnippet(guildId, id) {
    await this.db.query('DELETE FROM ticket_snippets WHERE id = ? AND guild_id = ?', [id, guildId]);
  }

  // ── Étiquettes ───────────────────────────────────────────────────────────

  /** Étiquettes du serveur, de la plus prioritaire (position 0) à la moins prioritaire. */
  async listTags(guildId) {
    const rows = await this.db.query('SELECT * FROM ticket_tags WHERE guild_id = ? ORDER BY position ASC, id ASC', [guildId]);
    return rows.map(mapTag);
  }

  async getTag(id) {
    return mapTag(await this.db.one('SELECT * FROM ticket_tags WHERE id = ?', [id]));
  }

  /** `categoryId`, `mentionRoleIds`, `channelPrefix` : effets facultatifs appliqués quand l'étiquette est posée. */
  async saveTag(guildId, { id = null, name, emoji = null, color = null, categoryId = null, mentionRoleIds = [], channelPrefix = null }) {
    const values = [name, emoji, color, categoryId, toJson(mentionRoleIds), channelPrefix];
    if (id) {
      await this.db.query(
        'UPDATE ticket_tags SET name = ?, emoji = ?, color = ?, category_id = ?, mention_role_ids = ?, channel_prefix = ? WHERE id = ? AND guild_id = ?',
        [...values, id, guildId],
      );
      return this.getTag(id);
    }
    const [{ n } = { n: 0 }] = await this.db.query('SELECT COUNT(*) AS n FROM ticket_tags WHERE guild_id = ?', [guildId]);
    const result = await this.db.query(
      `INSERT INTO ticket_tags (guild_id, name, emoji, color, category_id, mention_role_ids, channel_prefix, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, ...values, Number(n) || 0, new Date()],
    );
    return this.getTag(result.insertId);
  }

  /** Monte (-1) ou descend (+1) une étiquette dans l'ordre de priorité ; les positions sont renumérotées 0…n. */
  async moveTag(guildId, id, direction) {
    const tags = await this.listTags(guildId);
    const index = tags.findIndex((tag) => String(tag.id) === String(id));
    const target = index + (direction < 0 ? -1 : 1);
    if (index === -1 || target < 0 || target >= tags.length) return;
    [tags[index], tags[target]] = [tags[target], tags[index]];
    for (const [position, tag] of tags.entries()) {
      if (Number(tag.position) !== position) await this.db.query('UPDATE ticket_tags SET position = ? WHERE id = ?', [position, tag.id]);
    }
  }

  async deleteTag(guildId, id) {
    const tag = await this.getTag(id);
    if (!tag || String(tag.guild_id) !== String(guildId)) return;
    await this.db.query('DELETE FROM ticket_tag_links WHERE tag_id = ?', [id]);
    await this.db.query('DELETE FROM ticket_tags WHERE id = ?', [id]);
  }

  /** Étiquettes de plusieurs tickets, de la plus prioritaire à la moins prioritaire : Map(ticketId → [tag]). */
  async tagsForTickets(ticketIds) {
    const byTicket = new Map();
    if (!ticketIds.length) return byTicket;
    const rows = await this.db.query(
      `SELECT l.ticket_id, g.* FROM ticket_tag_links l JOIN ticket_tags g ON g.id = l.tag_id
        WHERE l.ticket_id IN (?) ORDER BY g.position ASC, g.id ASC`,
      [ticketIds],
    );
    for (const row of rows) {
      const key = String(row.ticket_id);
      if (!byTicket.has(key)) byTicket.set(key, []);
      byTicket.get(key).push({
        id: row.id,
        name: row.name,
        emoji: row.emoji,
        color: row.color,
        position: Number(row.position),
        category_id: row.category_id ? String(row.category_id) : null,
        channel_prefix: row.channel_prefix,
      });
    }
    return byTicket;
  }

  /** Pose (true) ou retire (false) une étiquette ; renvoie le nouvel état. */
  async setTicketTag(ticketId, tagId, on, by) {
    if (on) {
      await this.db.query('INSERT IGNORE INTO ticket_tag_links (ticket_id, tag_id, added_by, added_at) VALUES (?, ?, ?, ?)', [ticketId, tagId, by, new Date()]);
    } else {
      await this.db.query('DELETE FROM ticket_tag_links WHERE ticket_id = ? AND tag_id = ?', [ticketId, tagId]);
    }
    return on;
  }

  async ticketHasTag(ticketId, tagId) {
    return Boolean(await this.db.one('SELECT 1 AS x FROM ticket_tag_links WHERE ticket_id = ? AND tag_id = ?', [ticketId, tagId]));
  }

  // ── Listes automatiques (/ticket autolist) ──────────────────────────────

  async listAutolists(guildId) {
    return this.db.query('SELECT * FROM ticket_autolists WHERE guild_id = ? ORDER BY id ASC', [guildId]);
  }

  /** Serveurs ayant au moins une liste automatique (rafraîchissement périodique). */
  async autolistGuildIds() {
    const rows = await this.db.query('SELECT DISTINCT guild_id FROM ticket_autolists');
    return rows.map((row) => String(row.guild_id));
  }

  async addAutolist({ guildId, channelId, messageId, typeId = null, createdBy }) {
    await this.db.query(
      'INSERT INTO ticket_autolists (guild_id, channel_id, message_id, type_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [guildId, channelId, messageId, typeId, createdBy, new Date()],
    );
  }

  async deleteAutolist(id) {
    await this.db.query('DELETE FROM ticket_autolists WHERE id = ?', [id]);
  }

  // ── Liste noire ──────────────────────────────────────────────────────────

  async blacklistEntry(guildId, userId) {
    return this.db.one('SELECT * FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  async listBlacklist(guildId) {
    return this.db.query('SELECT * FROM ticket_blacklist WHERE guild_id = ? ORDER BY added_at DESC', [guildId]);
  }

  async addBlacklist(guildId, userId, reason, by) {
    await this.db.query(
      `INSERT INTO ticket_blacklist (guild_id, user_id, reason, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), added_by = VALUES(added_by), added_at = VALUES(added_at)`,
      [guildId, userId, reason ? String(reason).slice(0, 512) : null, by, new Date()],
    );
  }

  async removeBlacklist(guildId, userId) {
    const result = await this.db.query('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  /**
   * Suivi d'activité pour l'auto-clôture/reping (voir lib/scheduler.js), à chaque message dans le
   * salon. `first_opener_message_at` n'est posé qu'une fois (COALESCE), au tout premier message de
   * l'ouvreur : avant ça, un ticket muet compte pour la clôture automatique (dès l'ouverture, pas
   * de reping tant que l'ouvreur n'a rien dit) ; après, un ticket sans réponse du staff compte pour
   * le reping.
   */
  async touchActivity(ticketId, { isStaff, isOpener }) {
    const now = new Date();
    // Toute vraie conversation annule aussi une demande de fermeture automatique restée sans réponse.
    await this.db.query(
      `UPDATE tickets SET last_message_at = ?, last_message_is_staff = ?, first_opener_message_at = COALESCE(first_opener_message_at, ?),
         autoclose_asked_at = NULL WHERE id = ?`,
      [now, isStaff ? 1 : 0, isOpener ? now : null, ticketId],
    );
  }

  /** La demande de confirmation de fermeture automatique vient d'être postée : ne pas la reposer. */
  async markAutoCloseAsked(ticketId) {
    await this.db.query('UPDATE tickets SET autoclose_asked_at = ? WHERE id = ?', [new Date(), ticketId]);
  }

  /** Le staff garde le ticket ouvert : le délai d'inactivité repart de zéro. */
  async keepOpen(ticketId) {
    await this.db.query('UPDATE tickets SET autoclose_asked_at = NULL, last_message_at = ? WHERE id = ?', [new Date(), ticketId]);
  }

  async markReping(ticketId) {
    await this.db.query('UPDATE tickets SET last_reping_at = ? WHERE id = ?', [new Date(), ticketId]);
  }

  /**
   * Tickets dont la fermeture automatique doit être proposée au staff : soit le staff a répondu et
   * attend l'ouvreur, soit personne n'a jamais rien dit depuis l'ouverture (ticket abandonné dès le
   * début) — et la question n'a pas déjà été posée sans réponse depuis.
   */
  async dueForAutoClose() {
    return this.db.query(
      `SELECT t.* FROM tickets t JOIN ticket_types y ON y.id = t.type_id
       WHERE t.status = 'open' AND y.auto_close_minutes IS NOT NULL AND t.autoclose_asked_at IS NULL
         AND (t.last_message_is_staff = 1 OR t.first_opener_message_at IS NULL)
         AND t.last_message_at IS NOT NULL AND t.last_message_at <= DATE_SUB(NOW(), INTERVAL y.auto_close_minutes MINUTE)`,
    );
  }

  /** Tickets où l'ouvreur a déjà parlé au moins une fois mais le staff n'a pas répondu depuis, au-delà du délai (et pas déjà repingués récemment). */
  async dueForReping() {
    return this.db.query(
      `SELECT t.* FROM tickets t JOIN ticket_types y ON y.id = t.type_id
       WHERE t.status = 'open' AND y.reping_minutes IS NOT NULL AND t.last_message_is_staff = 0
         AND t.first_opener_message_at IS NOT NULL
         AND t.last_message_at IS NOT NULL AND t.last_message_at <= DATE_SUB(NOW(), INTERVAL y.reping_minutes MINUTE)
         AND (t.last_reping_at IS NULL OR t.last_reping_at <= DATE_SUB(NOW(), INTERVAL y.reping_minutes MINUTE))`,
    );
  }

  /** Webhook du salon, créé à la volée au premier message envoyé depuis le panel web (transcript live). */
  async setWebhook(ticketId, webhookId, webhookToken) {
    await this.db.query('UPDATE tickets SET webhook_id = ?, webhook_token = ? WHERE id = ?', [webhookId, webhookToken, ticketId]);
  }

  async getTicketByChannel(channelId) {
    return mapTicket(await this.db.one('SELECT * FROM tickets WHERE channel_id = ?', [channelId]));
  }

  /** Tickets ouverts d'un membre (tous types confondus) : fermeture automatique s'il quitte le serveur. */
  async openTicketsByOpener(guildId, userId) {
    return this.db.query(`SELECT * FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open'`, [guildId, userId]);
  }

  async listOpenTickets(guildId) {
    return (await this.db.query(`SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' ORDER BY created_at ASC`, [guildId])).map(mapTicket);
  }

  async listTickets(guildId, { status = null, limit = 200 } = {}) {
    if (status) return this.db.query('SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?', [guildId, status, limit]);
    return this.db.query('SELECT * FROM tickets WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?', [guildId, limit]);
  }

  async claim(id, userId) {
    await this.db.query('UPDATE tickets SET claimed_by = ? WHERE id = ?', [userId, id]);
  }

  async unclaim(id) {
    await this.db.query('UPDATE tickets SET claimed_by = NULL WHERE id = ?', [id]);
  }

  /** `auto` : fermeture par le mécanisme automatique (aucune demande de notation à la suppression). */
  async closeTicket(id, { reason, closedBy, auto = false }) {
    await this.db.query(
      `UPDATE tickets SET status = 'closed', close_reason = ?, closed_by = ?, closed_at = ?, auto_closed = ? WHERE id = ?`,
      [reason ?? null, closedBy, new Date(), auto ? 1 : 0, id],
    );
  }

  /** Réouverture : le compteur d'inactivité repart de zéro (sinon un vieux ticket serait aussitôt « dû » de nouveau). */
  async reopenTicket(id) {
    await this.db.query(`UPDATE tickets SET status = 'open', auto_closed = 0, autoclose_asked_at = NULL, last_message_at = ? WHERE id = ?`, [
      new Date(),
      id,
    ]);
  }

  /** Note laissée par l'ouvreur (1 à 5) sur le ticket, une seule fois (voir events/ratingInteraction.js). */
  async setRating(id, stars) {
    await this.db.query('UPDATE tickets SET rating_stars = ?, rating_at = ? WHERE id = ?', [stars, new Date(), id]);
  }

  /** Nombre de tickets notés et moyenne, tous types confondus (tuile du panel web). */
  async ratingStats(guildId) {
    const row = await this.db.one(
      `SELECT COUNT(*) AS n, AVG(rating_stars) AS avg FROM tickets WHERE guild_id = ? AND rating_stars IS NOT NULL`,
      [guildId],
    );
    const count = Number(row?.n ?? 0);
    return { count, average: count ? Number(row.avg) : null };
  }

  /** Nombre de tickets notés et moyenne par membre du staff (celui qui avait pris en charge le ticket à sa fermeture). */
  async ratingsByStaff(guildId) {
    const rows = await this.db.query(
      `SELECT claimed_by, COUNT(*) AS n, AVG(rating_stars) AS avg
       FROM tickets
       WHERE guild_id = ? AND rating_stars IS NOT NULL AND claimed_by IS NOT NULL
       GROUP BY claimed_by
       ORDER BY avg DESC, n DESC`,
      [guildId],
    );
    return rows.map((row) => ({ userId: String(row.claimed_by), count: Number(row.n), average: Number(row.avg) }));
  }

  /** Moyenne et nombre d'avis par type de ticket (les tickets notés uniquement). */
  async ratingsByType(guildId) {
    const rows = await this.db.query(
      `SELECT type_id, COUNT(*) AS n, AVG(rating_stars) AS avg FROM tickets
       WHERE guild_id = ? AND rating_stars IS NOT NULL GROUP BY type_id ORDER BY avg DESC, n DESC`,
      [guildId],
    );
    return rows.map((row) => ({ typeId: String(row.type_id), count: Number(row.n), average: Number(row.avg) }));
  }

  /** Tous les avis reçus, les plus récents d'abord (onglet « Avis » du panel web). */
  async listRatedTickets(guildId, limit = 300) {
    return this.db.query(
      `SELECT id, type_id, opener_id, claimed_by, rating_stars, rating_at FROM tickets
       WHERE guild_id = ? AND rating_stars IS NOT NULL ORDER BY rating_at DESC, id DESC LIMIT ?`,
      [guildId, limit],
    );
  }

  /** Historique des fermetures/réouvertures/suppression, pour l'archive postée à la suppression du salon. */
  async recordEvent(ticketId, event, actorId, reason) {
    await this.db.query('INSERT INTO ticket_events (ticket_id, event, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', [
      ticketId,
      event,
      actorId,
      reason ?? null,
      new Date(),
    ]);
  }

  async listEvents(ticketId) {
    return this.db.query('SELECT event, actor_id, reason, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]);
  }

  async markTranscriptGenerated(id) {
    await this.db.query('UPDATE tickets SET transcript_generated = 1 WHERE id = ?', [id]);
  }

  async deleteTicketRecord(id) {
    await this.db.query('DELETE FROM ticket_members WHERE ticket_id = ?', [id]);
    await this.db.query('DELETE FROM tickets WHERE id = ?', [id]);
  }

  // ── Membres ajoutés (/ticket add, /ticket remove) ───────────────────────

  async listMembers(ticketId) {
    return this.db.query('SELECT user_id, added_by, added_at FROM ticket_members WHERE ticket_id = ? ORDER BY added_at ASC', [ticketId]);
  }

  async addMember(ticketId, userId, addedBy) {
    await this.db.query(
      `INSERT INTO ticket_members (ticket_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE added_by = VALUES(added_by), added_at = VALUES(added_at)`,
      [ticketId, userId, addedBy, new Date()],
    );
  }

  async removeMember(ticketId, userId) {
    await this.db.query('DELETE FROM ticket_members WHERE ticket_id = ? AND user_id = ?', [ticketId, userId]);
  }

  async isMember(ticketId, userId) {
    const row = await this.db.one('SELECT 1 AS x FROM ticket_members WHERE ticket_id = ? AND user_id = ?', [ticketId, userId]);
    return Boolean(row);
  }

  // ── Messages capturés (transcript) ───────────────────────────────────────

  /** Renvoie l'id de la ligne insérée (utilisé pour rattacher les pièces jointes), ou null si doublon ignoré. */
  async appendMessage(row) {
    try {
      const result = await this.db.query(
        `INSERT INTO ticket_messages
           (ticket_id, message_id, author_id, author_name, author_avatar, author_role_color, author_bot,
            content, embeds, attachments, via_web, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.ticketId,
          row.messageId,
          row.authorId,
          row.authorName,
          row.authorAvatar ?? null,
          row.authorRoleColor ?? null,
          row.authorBot ? 1 : 0,
          row.content ?? null,
          row.embeds ? JSON.stringify(row.embeds) : null,
          row.attachments ? JSON.stringify(row.attachments) : null,
          row.viaWeb ? 1 : 0,
          row.createdAt ?? new Date(),
        ],
      );
      return result.insertId;
    } catch (err) {
      // Doublon (message_id déjà capturé) : ignoré silencieusement.
      if (/Duplicate entry/i.test(err.message)) return null;
      throw err;
    }
  }

  /**
   * Met à jour contenu et embeds d'un message déjà capturé : Discord ajoute les aperçus de liens
   * (GIF Tenor/Giphy, images…) APRÈS l'envoi, via un événement « message modifié ».
   */
  async updateMessageByDiscordId(messageId, { content, embeds }) {
    await this.db.query('UPDATE ticket_messages SET content = ?, embeds = ?, updated_at = ? WHERE message_id = ? AND via_web = 0', [
      content ?? null,
      embeds && embeds.length ? JSON.stringify(embeds) : null,
      new Date(),
      messageId,
    ]);
  }

  /** Met à jour la colonne `attachments` d'un message déjà inséré (une fois les pièces jointes téléchargées). */
  async setMessageAttachments(messageRowId, attachments) {
    await this.db.query('UPDATE ticket_messages SET attachments = ? WHERE id = ?', [JSON.stringify(attachments), messageRowId]);
  }

  /** Contenu binaire d'une pièce jointe téléchargée (voir events/messageCreate.js), servi par le panel web. */
  async saveAttachment({ messageRowId, name, contentType, size, buffer }) {
    const result = await this.db.query(
      `INSERT INTO ticket_attachments (message_row_id, name, content_type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [messageRowId, name, contentType ?? null, size ?? buffer.length, buffer, new Date()],
    );
    return result.insertId;
  }

  /** Pièce jointe + serveur du ticket auquel elle appartient (contrôle d'accès du panel web). */
  async getAttachment(id) {
    return this.db.one(
      `SELECT a.name, a.content_type, a.data, t.guild_id, m.ticket_id
         FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_row_id
         JOIN tickets t ON t.id = m.ticket_id
        WHERE a.id = ?`,
      [id],
    );
  }

  /**
   * Messages d'un ticket : tous, ou seulement ceux postérieurs à `after` (id) — plus ceux modifiés depuis
   * `since` (date), pour que le transcript live reçoive aussi les aperçus de liens ajoutés après coup.
   */
  async listMessages(ticketId, { after = 0, since = null } = {}) {
    const rows = since
      ? await this.db.query(
          'SELECT * FROM ticket_messages WHERE ticket_id = ? AND (id > ? OR updated_at > ?) ORDER BY created_at ASC, id ASC',
          [ticketId, after, since],
        )
      : await this.db.query('SELECT * FROM ticket_messages WHERE ticket_id = ? AND id > ? ORDER BY created_at ASC, id ASC', [ticketId, after]);
    return rows.map((row) => ({
      ...row,
      embeds: row.embeds ? (typeof row.embeds === 'string' ? JSON.parse(row.embeds) : row.embeds) : [],
      attachments: row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [],
    }));
  }
}

module.exports = { TicketService };
