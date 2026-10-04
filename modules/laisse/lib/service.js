'use strict';

const DEFAULT_SETTINGS = Object.freeze({ globalLimit: 3, leashLeashers: true, logChannelId: null });
const DEFAULT_MEMBER = Object.freeze({
  allowed: false,
  allowedBy: null,
  allowedAt: null,
  maxLeashes: null,
  immune: false,
  immuneBy: null,
  immuneAt: null,
  godmode: false,
  godmodeBy: null,
  godmodeAt: null,
  admin: false,
  adminBy: null,
  adminAt: null,
});

// Colonnes modifiables de leash_members (liste blanche : les noms sont insérés dans le SQL).
const MEMBER_COLUMNS = {
  allowed: 'allowed',
  allowedBy: 'allowed_by',
  allowedAt: 'allowed_at',
  maxLeashes: 'max_leashes',
  immune: 'immune',
  immuneBy: 'immune_by',
  immuneAt: 'immune_at',
  godmode: 'godmode',
  godmodeBy: 'godmode_by',
  godmodeAt: 'godmode_at',
  admin: 'is_admin',
  adminBy: 'admin_by',
  adminAt: 'admin_at',
};

const bool = (value) => Boolean(Number(value));

/**
 * État du module Laisse par serveur (réglages, statuts des membres, laisses), mis en cache
 * mémoire pour que les déplacements vocaux soient instantanés. Toute écriture invalide le cache.
 */
class LeashService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.cache = new Map();
  }

  async state(guildId) {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    const [settingsRow, memberRows, linkRows] = await Promise.all([
      this.db.one('SELECT global_limit, leash_leashers, log_channel_id FROM leash_settings WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT * FROM leash_members WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT leashed_id, leasher_id, added_by, created_at FROM leash_links WHERE guild_id = ?', [guildId]),
    ]);

    const settings = settingsRow
      ? {
          globalLimit: Number(settingsRow.global_limit),
          leashLeashers: bool(settingsRow.leash_leashers),
          logChannelId: settingsRow.log_channel_id ?? null,
        }
      : { ...DEFAULT_SETTINGS };

    const members = new Map();
    for (const row of memberRows) {
      members.set(row.user_id, {
        allowed: bool(row.allowed),
        allowedBy: row.allowed_by,
        allowedAt: row.allowed_at,
        maxLeashes: row.max_leashes === null ? null : Number(row.max_leashes),
        immune: bool(row.immune),
        immuneBy: row.immune_by,
        immuneAt: row.immune_at,
        godmode: bool(row.godmode),
        godmodeBy: row.godmode_by,
        godmodeAt: row.godmode_at,
        admin: bool(row.is_admin),
        adminBy: row.admin_by,
        adminAt: row.admin_at,
      });
    }

    const links = new Map();
    const byLeasher = new Map();
    for (const row of linkRows) {
      links.set(row.leashed_id, { leashedId: row.leashed_id, leasherId: row.leasher_id, addedBy: row.added_by, createdAt: row.created_at });
      if (!byLeasher.has(row.leasher_id)) byLeasher.set(row.leasher_id, []);
      byLeasher.get(row.leasher_id).push(row.leashed_id);
    }

    const state = { guildId, settings, members, links, byLeasher };
    this.cache.set(guildId, state);
    return state;
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
  }

  // ── Lecture ───────────────────────────────────────────────────────────────

  member(state, userId) {
    return state.members.get(userId) ?? DEFAULT_MEMBER;
  }

  listOf(state, leasherId) {
    return state.byLeasher.get(leasherId) ?? [];
  }

  limitFor(state, userId) {
    return this.member(state, userId).maxLeashes ?? state.settings.globalLimit;
  }

  /** Peut mettre des gens en laisse : autorisé ou admin du module. */
  canLeash(state, userId) {
    const member = this.member(state, userId);
    return member.allowed || member.admin;
  }

  /** Mettre targetId dans la liste de leasherId créerait-il une boucle (A tient B qui tient A) ? */
  wouldCycle(state, leasherId, targetId) {
    let current = leasherId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      if (current === targetId) return true;
      seen.add(current);
      current = state.links.get(current)?.leasherId;
    }
    return false;
  }

  /**
   * Vérifie qu'un ajout est possible. Renvoie null si oui, sinon le message d'erreur.
   * @param {{ leasherId: string, target: import('discord.js').User, bypassLimit?: boolean }} input
   */
  checkAdd(state, { leasherId, target, bypassLimit = false }) {
    if (target.bot) return 'Les bots ne peuvent pas être mis en laisse.';
    if (target.id === leasherId) return 'Impossible de se mettre soi-même en laisse.';
    const member = this.member(state, target.id);
    if (member.godmode) return `<@${target.id}> est en **god mode** : impossible de l’ajouter à une liste.`;
    const existing = state.links.get(target.id);
    if (existing) {
      return existing.leasherId === leasherId
        ? `<@${target.id}> est déjà dans cette liste.`
        : `<@${target.id}> est déjà en laisse de <@${existing.leasherId}>.`;
    }
    if (!state.settings.leashLeashers && this.canLeash(state, target.id)) {
      return `<@${target.id}> peut lui-même mettre en laisse, et **leash-leasher** est désactivé sur ce serveur.`;
    }
    if (this.wouldCycle(state, leasherId, target.id)) {
      return `Impossible : <@${target.id}> tient déjà <@${leasherId}> en laisse (directement ou indirectement).`;
    }
    if (!bypassLimit) {
      const limit = this.limitFor(state, leasherId);
      const count = this.listOf(state, leasherId).length;
      if (count >= limit) return `Limite atteinte : **${count}/${limit}** membre(s) en laisse.`;
    }
    return null;
  }

  // ── Écriture ──────────────────────────────────────────────────────────────

  async updateSettings(guildId, patch) {
    const current = (await this.state(guildId)).settings;
    const next = { ...current, ...patch };
    await this.db.query(
      `INSERT INTO leash_settings (guild_id, global_limit, leash_leashers, log_channel_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE global_limit = VALUES(global_limit), leash_leashers = VALUES(leash_leashers),
         log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, next.globalLimit, next.leashLeashers ? 1 : 0, next.logChannelId, new Date()],
    );
    this.invalidate(guildId);
    return { previous: current, next };
  }

  async updateMember(guildId, userId, patch) {
    const entries = Object.entries(patch).filter(([key]) => MEMBER_COLUMNS[key]);
    if (!entries.length) return;
    const columns = entries.map(([key]) => MEMBER_COLUMNS[key]);
    const values = entries.map(([, value]) => (typeof value === 'boolean' ? Number(value) : value));
    await this.db.query(
      `INSERT INTO leash_members (guild_id, user_id, ${columns.join(', ')}) VALUES (?, ?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${columns.map((column) => `${column} = VALUES(${column})`).join(', ')}`,
      [guildId, userId, ...values],
    );
    this.invalidate(guildId);
  }

  async addLink(guildId, leashedId, leasherId, addedBy) {
    await this.db.query(
      'INSERT INTO leash_links (guild_id, leashed_id, leasher_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [guildId, leashedId, leasherId, addedBy, new Date()],
    );
    this.invalidate(guildId);
  }

  /** Retire un membre de la liste où il se trouve ; renvoie l'ancienne laisse (ou null). */
  async removeLink(guildId, leashedId) {
    const link = (await this.state(guildId)).links.get(leashedId) ?? null;
    if (!link) return null;
    await this.db.query('DELETE FROM leash_links WHERE guild_id = ? AND leashed_id = ?', [guildId, leashedId]);
    this.invalidate(guildId);
    return link;
  }

  /** Vide la liste d'un membre ; renvoie les IDs retirés. */
  async clearList(guildId, leasherId) {
    const removed = [...this.listOf(await this.state(guildId), leasherId)];
    if (removed.length) {
      await this.db.query('DELETE FROM leash_links WHERE guild_id = ? AND leasher_id = ?', [guildId, leasherId]);
      this.invalidate(guildId);
    }
    return removed;
  }

  async clearAll(guildId) {
    const result = await this.db.query('DELETE FROM leash_links WHERE guild_id = ?', [guildId]);
    this.invalidate(guildId);
    return result.affectedRows ?? 0;
  }

  /** Retire des listes tous les membres qui peuvent eux-mêmes mettre en laisse (leash-leasher désactivé). */
  async removeLeashers(guildId) {
    const state = await this.state(guildId);
    const removed = [...state.links.values()].filter((link) => this.canLeash(state, link.leashedId));
    for (const link of removed) {
      await this.db.query('DELETE FROM leash_links WHERE guild_id = ? AND leashed_id = ?', [guildId, link.leashedId]);
    }
    if (removed.length) this.invalidate(guildId);
    return removed;
  }

  /** Membres ayant un statut donné ('allowed' | 'immune' | 'godmode' | 'admin'), avec qui l'a donné et quand. */
  async withFlag(guildId, flag) {
    const state = await this.state(guildId);
    return [...state.members]
      .filter(([, member]) => member[flag])
      .map(([userId, member]) => ({ userId, by: member[`${flag}By`], at: member[`${flag}At`] }))
      .sort((a, b) => new Date(a.at ?? 0) - new Date(b.at ?? 0));
  }
}

module.exports = { LeashService };
