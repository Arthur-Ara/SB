'use strict';

const MENU_COLUMNS = [
  'name',
  'type',
  'mode',
  'max_selected',
  'removable',
  'placeholder',
  'embed_title',
  'embed_description',
  'embed_color',
  'embed_footer',
  'embed_image',
  'embed_thumbnail',
];
const OPTION_COLUMNS = ['label', 'emoji', 'description', 'style'];

/** Accès aux données du module RôleMenu : menus, options et conditions. */
class RoleMenuService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.messageCache = new Map(); // messageId → menuId | null (réactions : une requête par message)
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const row = await this.db.one('SELECT log_channel_id FROM rolemenu_settings WHERE guild_id = ?', [guildId]);
    return { logChannelId: row?.log_channel_id ?? null };
  }

  async setLogChannel(guildId, logChannelId) {
    await this.db.query(
      `INSERT INTO rolemenu_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, logChannelId, new Date()],
    );
  }

  // ── Menus ─────────────────────────────────────────────────────────────────

  listMenus(guildId) {
    return this.db.query('SELECT * FROM rolemenu_menus WHERE guild_id = ? ORDER BY id ASC', [guildId]);
  }

  getMenu(id) {
    return this.db.one('SELECT * FROM rolemenu_menus WHERE id = ?', [id]);
  }

  async createMenu(guildId, { name, type, mode, maxSelected = 0 }) {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO rolemenu_menus (guild_id, name, type, mode, max_selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [guildId, name, type, mode, maxSelected, now, now],
    );
    return this.getMenu(result.insertId);
  }

  /** `patch` : sous-ensemble de MENU_COLUMNS (noms de colonnes SQL). */
  async updateMenu(id, patch) {
    const sets = [];
    const values = [];
    for (const column of MENU_COLUMNS) {
      if (!(column in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[column]);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    values.push(new Date(), id);
    await this.db.query(`UPDATE rolemenu_menus SET ${sets.join(', ')} WHERE id = ?`, values);
    this.messageCache.clear();
  }

  async setMenuMessage(id, channelId, messageId) {
    await this.db.query('UPDATE rolemenu_menus SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?', [channelId, messageId, new Date(), id]);
    this.messageCache.clear();
  }

  /** Oublie le message d'un menu dont le message Discord a été supprimé. */
  async clearMenuMessage(messageId) {
    const result = await this.db.query('UPDATE rolemenu_menus SET channel_id = NULL, message_id = NULL WHERE message_id = ?', [messageId]);
    if (result.affectedRows) this.messageCache.clear();
    return result.affectedRows ?? 0;
  }

  async deleteMenu(id) {
    await this.db.query('DELETE FROM rolemenu_conditions WHERE menu_id = ?', [id]);
    await this.db.query('DELETE FROM rolemenu_options WHERE menu_id = ?', [id]);
    await this.db.query('DELETE FROM rolemenu_menus WHERE id = ?', [id]);
    this.messageCache.clear();
  }

  /** Menu à réactions publié sur ce message (null si aucun) — mis en cache. */
  async reactionMenuIdByMessage(messageId) {
    if (this.messageCache.has(messageId)) return this.messageCache.get(messageId);
    const row = await this.db.one("SELECT id FROM rolemenu_menus WHERE message_id = ? AND type = 'reaction'", [messageId]);
    const id = row ? String(row.id) : null;
    if (this.messageCache.size > 5000) this.messageCache.clear();
    this.messageCache.set(messageId, id);
    return id;
  }

  // ── Options ───────────────────────────────────────────────────────────────

  listOptions(menuId) {
    return this.db.query('SELECT * FROM rolemenu_options WHERE menu_id = ? ORDER BY position ASC, id ASC', [menuId]);
  }

  getOption(id) {
    return this.db.one('SELECT * FROM rolemenu_options WHERE id = ?', [id]);
  }

  async addOption(menuId, { roleId, label = null, emoji = null, description = null, style = 'secondary' }) {
    const last = await this.db.one('SELECT COALESCE(MAX(position), 0) AS p FROM rolemenu_options WHERE menu_id = ?', [menuId]);
    const result = await this.db.query(
      `INSERT INTO rolemenu_options (menu_id, role_id, label, emoji, description, style, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [menuId, roleId, label, emoji, description, style, Number(last?.p ?? 0) + 1, new Date()],
    );
    this.messageCache.clear();
    return this.getOption(result.insertId);
  }

  async updateOption(id, patch) {
    const sets = [];
    const values = [];
    for (const column of OPTION_COLUMNS) {
      if (!(column in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[column]);
    }
    if (!sets.length) return;
    values.push(id);
    await this.db.query(`UPDATE rolemenu_options SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  async deleteOption(id) {
    await this.db.query('DELETE FROM rolemenu_conditions WHERE option_id = ?', [id]);
    await this.db.query('DELETE FROM rolemenu_options WHERE id = ?', [id]);
    this.messageCache.clear();
  }

  /** Échange la position de l'option avec sa voisine (direction : -1 vers le haut, +1 vers le bas). */
  async moveOption(id, direction) {
    const option = await this.getOption(id);
    if (!option) return false;
    const siblings = await this.listOptions(option.menu_id);
    const index = siblings.findIndex((o) => String(o.id) === String(id));
    const other = siblings[index + direction];
    if (index < 0 || !other) return false;
    // Les positions sont renumérotées pour rester distinctes même si d'anciennes lignes en partagent une.
    const order = siblings.map((o) => String(o.id));
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    for (let i = 0; i < order.length; i += 1) {
      await this.db.query('UPDATE rolemenu_options SET position = ? WHERE id = ?', [i + 1, order[i]]);
    }
    return true;
  }

  // ── Conditions ────────────────────────────────────────────────────────────

  listConditions(menuId) {
    return this.db.query('SELECT * FROM rolemenu_conditions WHERE menu_id = ? ORDER BY id ASC', [menuId]);
  }

  getCondition(id) {
    return this.db.one('SELECT * FROM rolemenu_conditions WHERE id = ?', [id]);
  }

  async addCondition(menuId, optionId, type, params) {
    const result = await this.db.query(
      'INSERT INTO rolemenu_conditions (menu_id, option_id, type, params, created_at) VALUES (?, ?, ?, ?, ?)',
      [menuId, optionId ?? null, type, JSON.stringify(params ?? {}), new Date()],
    );
    return this.getCondition(result.insertId);
  }

  async deleteCondition(id) {
    await this.db.query('DELETE FROM rolemenu_conditions WHERE id = ?', [id]);
  }

  /** Menu + options + conditions, prêt à l'emploi (menu null si inconnu). */
  async bundle(menuId) {
    const menu = await this.getMenu(menuId);
    if (!menu) return null;
    const [options, conditions] = await Promise.all([this.listOptions(menuId), this.listConditions(menuId)]);
    return { menu, options, conditions };
  }
}

module.exports = { RoleMenuService };
