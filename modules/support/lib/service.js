'use strict';

function roleList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Normalise une ligne `support_nodes` (rôles autorisés JSON -> tableau). */
function mapNode(row) {
  if (!row) return null;
  return { ...row, allowed_role_ids: roleList(row.allowed_role_ids) };
}

/**
 * Accès aux données du module Support automatique : panels publiés et l'arbre de catégories/
 * réponses de chacun (table unique `support_nodes`, auto-référencée par `parent_id`).
 */
class SupportService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  // ── Réglages ──────────────────────────────────────────────────────────────

  async settings(guildId) {
    const row = await this.db.one('SELECT log_channel_id FROM support_settings WHERE guild_id = ?', [guildId]);
    return { logChannelId: row?.log_channel_id ?? null };
  }

  async setLogChannel(guildId, logChannelId) {
    await this.db.query(
      `INSERT INTO support_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, logChannelId, new Date()],
    );
  }

  // ── Panels ────────────────────────────────────────────────────────────────

  async listPanels(guildId) {
    return this.db.query('SELECT * FROM support_panels WHERE guild_id = ? ORDER BY id ASC', [guildId]);
  }

  async getPanel(id) {
    return this.db.one('SELECT * FROM support_panels WHERE id = ?', [id]);
  }

  async createPanel(guildId) {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO support_panels (guild_id, placeholder, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [guildId, 'Choisis une catégorie…', now, now],
    );
    return this.getPanel(result.insertId);
  }

  /** `patch` : sous-ensemble de { embed_title, embed_description, embed_color, embed_footer, embed_image, embed_thumbnail, placeholder }. */
  async updatePanel(id, patch) {
    const columns = ['embed_title', 'embed_description', 'embed_color', 'embed_footer', 'embed_image', 'embed_thumbnail', 'placeholder'];
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
    await this.db.query(`UPDATE support_panels SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  async setPanelMessage(id, channelId, messageId) {
    await this.db.query('UPDATE support_panels SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?', [channelId, messageId, new Date(), id]);
  }

  /** Supprime le panel et tout son arbre (pas de contrainte FK : cascade faite ici, voir deleteNode). */
  async deletePanel(id) {
    const topNodes = await this.db.query('SELECT id FROM support_nodes WHERE panel_id = ? AND parent_id IS NULL', [id]);
    for (const node of topNodes) await this.deleteNode(node.id);
    await this.db.query('DELETE FROM support_panels WHERE id = ?', [id]);
  }

  // ── Nœuds (catégories / réponses) ────────────────────────────────────────

  /** Enfants directs d'un nœud (ou racine du panel si `parentId` est `null`). */
  async listChildren(panelId, parentId) {
    const rows =
      parentId === null || parentId === undefined
        ? await this.db.query('SELECT * FROM support_nodes WHERE panel_id = ? AND parent_id IS NULL ORDER BY position ASC, id ASC', [panelId])
        : await this.db.query('SELECT * FROM support_nodes WHERE panel_id = ? AND parent_id = ? ORDER BY position ASC, id ASC', [panelId, parentId]);
    return rows.map(mapNode);
  }

  /** Tous les nœuds du panel, à plat (le panel web reconstruit l'arbre côté client via `parent_id`). */
  async listAllNodes(panelId) {
    return (await this.db.query('SELECT * FROM support_nodes WHERE panel_id = ? ORDER BY position ASC, id ASC', [panelId])).map(mapNode);
  }

  async getNode(id) {
    return mapNode(await this.db.one('SELECT * FROM support_nodes WHERE id = ?', [id]));
  }

  /**
   * Le membre peut-il voir ce nœud ? Il doit avoir un des rôles autorisés du nœud ET de chacun de ses parents
   * (une catégorie réservée réserve aussi tout son contenu). Aucun rôle défini = ouvert à tous.
   */
  async canSee(node, member) {
    let current = node;
    for (let depth = 0; current && depth < 25; depth += 1) {
      if (current.allowed_role_ids.length && !current.allowed_role_ids.some((id) => member?.roles?.cache?.has(id))) return false;
      current = current.parent_id ? await this.getNode(current.parent_id) : null;
    }
    return true;
  }

  /** Échange la position du nœud avec son voisin (direction : -1 vers le haut, +1 vers le bas) parmi ses frères. */
  async moveNode(id, direction) {
    const node = await this.getNode(id);
    if (!node) return false;
    const siblings = await this.listChildren(node.panel_id, node.parent_id);
    const index = siblings.findIndex((n) => String(n.id) === String(id));
    if (index < 0 || !siblings[index + direction]) return false;
    // Positions renumérotées pour rester distinctes même si d'anciennes lignes en partageaient une.
    const order = siblings.map((n) => String(n.id));
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    for (let i = 0; i < order.length; i += 1) {
      await this.db.query('UPDATE support_nodes SET position = ? WHERE id = ?', [i, order[i]]);
    }
    return true;
  }

  // ── Efficacité (affichages, avis, tickets ouverts) ───────────────────────

  async guildOfNode(node) {
    const panel = await this.getPanel(node.panel_id);
    return panel ? String(panel.guild_id) : null;
  }

  async recordView(node) {
    const guildId = await this.guildOfNode(node);
    if (!guildId) return;
    await this.db.query(
      'INSERT INTO support_node_stats (node_id, guild_id, views, tickets) VALUES (?, ?, 1, 0) ON DUPLICATE KEY UPDATE views = views + 1',
      [node.id, guildId],
    );
  }

  /** Ticket ouvert depuis le bouton « Créer un ticket » de cette réponse. */
  async recordEscalation(node) {
    const guildId = await this.guildOfNode(node);
    if (!guildId) return;
    await this.db.query(
      'INSERT INTO support_node_stats (node_id, guild_id, views, tickets) VALUES (?, ?, 0, 1) ON DUPLICATE KEY UPDATE tickets = tickets + 1',
      [node.id, guildId],
    );
  }

  /** Avis d'un membre sur une réponse (le dernier avis remplace le précédent). */
  async setFeedback(node, userId, helpful) {
    const guildId = await this.guildOfNode(node);
    if (!guildId) return;
    await this.db.query(
      `INSERT INTO support_feedback (node_id, user_id, guild_id, helpful, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE helpful = VALUES(helpful), updated_at = VALUES(updated_at)`,
      [node.id, userId, guildId, helpful ? 1 : 0, new Date()],
    );
  }

  /** Statistiques de tous les nœuds du serveur : Map(nodeId → { views, tickets, helpful, unhelpful }). */
  async statsForGuild(guildId) {
    const [counters, feedback] = await Promise.all([
      this.db.query('SELECT node_id, views, tickets FROM support_node_stats WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT node_id, SUM(helpful = 1) AS helpful, SUM(helpful = 0) AS unhelpful FROM support_feedback WHERE guild_id = ? GROUP BY node_id', [guildId]),
    ]);
    const stats = new Map();
    const entry = (id) => {
      const key = String(id);
      if (!stats.has(key)) stats.set(key, { views: 0, tickets: 0, helpful: 0, unhelpful: 0 });
      return stats.get(key);
    };
    for (const row of counters) Object.assign(entry(row.node_id), { views: Number(row.views), tickets: Number(row.tickets) });
    for (const row of feedback) Object.assign(entry(row.node_id), { helpful: Number(row.helpful), unhelpful: Number(row.unhelpful) });
    return stats;
  }

  async createNode(panelId, parentId, kind, label) {
    const now = new Date();
    const [{ n } = { n: 0 }] = await this.db.query('SELECT COUNT(*) AS n FROM support_nodes WHERE panel_id = ? AND parent_id <=> ?', [
      panelId,
      parentId ?? null,
    ]);
    const result = await this.db.query(
      `INSERT INTO support_nodes (panel_id, parent_id, kind, position, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [panelId, parentId ?? null, kind, Number(n) || 0, label, now, now],
    );
    return this.getNode(result.insertId);
  }

  /**
   * `patch` : sous-ensemble des colonnes de `support_nodes` (hors id/panel_id/parent_id/kind/
   * created_at) — `allow_ticket`/`ticket_type_id`/`ticket_extra_message` n'ont de sens que pour un
   * nœud `response`, mais rien n'empêche de les stocker (ignorés à l'affichage/l'usage sinon).
   */
  async updateNode(id, patch) {
    const columns = [
      'label', 'emoji', 'select_description',
      'embed_title', 'embed_description', 'embed_color', 'embed_footer', 'embed_image', 'embed_thumbnail',
      'allow_ticket', 'ticket_type_id', 'ticket_extra_message', 'allowed_role_ids',
    ];
    const sets = [];
    const values = [];
    for (const column of columns) {
      if (!(column in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(column === 'allowed_role_ids' ? (patch[column]?.length ? JSON.stringify(patch[column]) : null) : patch[column]);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    values.push(new Date());
    values.push(id);
    await this.db.query(`UPDATE support_nodes SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  /** Supprime un nœud et tous ses descendants (récursif, pas de contrainte FK dans ce projet). */
  async deleteNode(id) {
    const children = await this.db.query('SELECT id FROM support_nodes WHERE parent_id = ?', [id]);
    for (const child of children) await this.deleteNode(child.id);
    await this.db.query('DELETE FROM support_feedback WHERE node_id = ?', [id]);
    await this.db.query('DELETE FROM support_node_stats WHERE node_id = ?', [id]);
    await this.db.query('DELETE FROM support_nodes WHERE id = ?', [id]);
  }
}

module.exports = { SupportService };
