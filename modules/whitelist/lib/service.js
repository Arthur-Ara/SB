'use strict';

const { isWithinSchedule } = require('../../../src/core/schedule');

const DEFAULT_TIMEZONE = 'Europe/Paris';

function emptyChannel() {
  return {
    enabled: false,
    slotLimit: null,
    users: new Set(), // accès permanents
    temp: new Map(), // accès temporaires : userId → échéance
    roles: new Set(),
    admins: new Set(), // admins de ce salon uniquement
    schedule: { scheduleEnabled: false, scheduleStart: null, scheduleEnd: null, scheduleTimezone: DEFAULT_TIMEZONE },
  };
}

const DEFAULT_CHANNEL = Object.freeze(emptyChannel());

const bool = (value) => Boolean(Number(value));

/**
 * État du module Whitelist Vocal par serveur (réglages, admins, config de chaque salon),
 * mis en cache mémoire — interrogé à chaque connexion vocale, donc pas de DB à chaque fois.
 * Toute écriture invalide le cache du serveur concerné.
 */
class WhitelistService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.cache = new Map();
  }

  async state(guildId) {
    const cached = this.cache.get(guildId);
    // Un accès temporaire échu rend le cache périmé dès son échéance (le balayage supprime ensuite la ligne).
    if (cached && Date.now() < cached.staleAt) return cached;

    const now = new Date();
    const [settingsRow, adminRows, channelRows, userRows, roleRows, channelAdminRows] = await Promise.all([
      this.db.one('SELECT log_channel_id FROM whitelist_settings WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT user_id FROM whitelist_admins WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT * FROM whitelist_channels WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT channel_id, user_id, expires_at FROM whitelist_channel_users WHERE guild_id = ? AND (expires_at IS NULL OR expires_at > ?)', [guildId, now]),
      this.db.query('SELECT channel_id, role_id FROM whitelist_channel_roles WHERE guild_id = ?', [guildId]),
      this.db.query('SELECT channel_id, user_id FROM whitelist_channel_admins WHERE guild_id = ?', [guildId]),
    ]);

    const channels = new Map();
    const ensure = (channelId) => {
      const key = String(channelId);
      if (!channels.has(key)) channels.set(key, emptyChannel());
      return channels.get(key);
    };
    for (const row of channelRows) {
      const entry = ensure(row.channel_id);
      entry.enabled = bool(row.enabled);
      entry.slotLimit = row.slot_limit === null ? null : Number(row.slot_limit);
      entry.schedule = {
        scheduleEnabled: bool(row.schedule_enabled),
        scheduleStart: row.schedule_start ?? null,
        scheduleEnd: row.schedule_end ?? null,
        scheduleTimezone: row.schedule_timezone || DEFAULT_TIMEZONE,
      };
    }
    let staleAt = Infinity;
    for (const row of userRows) {
      const entry = ensure(row.channel_id);
      if (row.expires_at) {
        entry.temp.set(String(row.user_id), new Date(row.expires_at));
        staleAt = Math.min(staleAt, new Date(row.expires_at).getTime());
      } else {
        entry.users.add(String(row.user_id));
      }
    }
    for (const row of roleRows) ensure(row.channel_id).roles.add(String(row.role_id));
    for (const row of channelAdminRows) ensure(row.channel_id).admins.add(String(row.user_id));

    const state = {
      guildId,
      settings: { logChannelId: settingsRow?.log_channel_id ?? null },
      admins: new Set(adminRows.map((row) => String(row.user_id))),
      channels,
      staleAt,
    };
    this.cache.set(guildId, state);
    return state;
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
  }

  // ── Lecture ───────────────────────────────────────────────────────────────

  channelConfig(state, channelId) {
    return state.channels.get(channelId) ?? DEFAULT_CHANNEL;
  }

  /** Configuré = whitelist activée ou limite de slots définie (sinon rien à appliquer). Les admins de salon et accès temporaires seuls ne suffisent pas. */
  isConfigured(config) {
    return config.enabled || config.slotLimit !== null;
  }

  /** Restrictions du salon en vigueur en ce moment (pas de plage horaire = toujours). */
  isActiveNow(config, now = new Date()) {
    return isWithinSchedule(config.schedule, now);
  }

  /** Membre sur la liste (accès permanent ou temporaire non échu), ou possédant un des rôles whitelistés. */
  isWhitelisted(config, member) {
    if (config.users.has(member.id)) return true;
    const until = config.temp.get(member.id);
    if (until && until > new Date()) return true;
    for (const roleId of member.roles.cache.keys()) {
      if (config.roles.has(roleId)) return true;
    }
    return false;
  }

  /** Admin de ce salon précis (en plus des admins du module). */
  isChannelAdmin(config, userId) {
    return config.admins.has(userId);
  }

  configuredChannels(state) {
    return [...state.channels.entries()]
      .filter(([, config]) => this.isConfigured(config))
      .map(([channelId, config]) => ({ channelId, ...config }));
  }

  // ── Écriture (salon) ──────────────────────────────────────────────────────

  async setEnabled(guildId, channelId, enabled, updatedBy) {
    await this.upsertChannel(guildId, channelId, { enabled: enabled ? 1 : 0 }, updatedBy);
  }

  async setSlotLimit(guildId, channelId, slotLimit, updatedBy) {
    await this.upsertChannel(guildId, channelId, { slot_limit: slotLimit }, updatedBy);
  }

  async upsertChannel(guildId, channelId, patch, updatedBy) {
    const columns = Object.keys(patch);
    const values = Object.values(patch);
    await this.db.query(
      `INSERT INTO whitelist_channels (guild_id, channel_id, ${columns.join(', ')}, updated_by, updated_at)
       VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [guildId, channelId, ...values, updatedBy, new Date()],
    );
    this.invalidate(guildId);
  }

  /**
   * Remplace l'ensemble des membres whitelistés **en permanence** d'un salon (sélecteur Discord et panel web).
   * Les accès temporaires en cours sont conservés ; un membre ajouté ici passe en accès permanent.
   */
  async replaceUsers(guildId, channelId, userIds, updatedBy) {
    await this.db.transaction(async (connection) => {
      await connection.query('DELETE FROM whitelist_channel_users WHERE guild_id = ? AND channel_id = ? AND expires_at IS NULL', [guildId, channelId]);
      if (userIds.length) {
        const now = new Date();
        await connection.query(
          `INSERT INTO whitelist_channel_users (guild_id, channel_id, user_id, added_by, added_at) VALUES ?
           ON DUPLICATE KEY UPDATE expires_at = NULL, added_by = VALUES(added_by), added_at = VALUES(added_at)`,
          [userIds.map((userId) => [guildId, channelId, userId, updatedBy, now])],
        );
      }
    });
    this.invalidate(guildId);
  }

  async setSchedule(guildId, channelId, { enabled, start, end, timezone }, updatedBy) {
    await this.upsertChannel(
      guildId,
      channelId,
      { schedule_enabled: enabled ? 1 : 0, schedule_start: start ?? null, schedule_end: end ?? null, schedule_timezone: timezone ?? null },
      updatedBy,
    );
  }

  // ── Accès temporaires ────────────────────────────────────────────────────

  /** Accès temporaire ; renvoie 'permanent' (déjà whitelisté en permanence : rien ne change), 'extended' ou 'added'. */
  async inviteUser(guildId, channelId, userId, expiresAt, addedBy) {
    const existing = await this.db.one('SELECT expires_at FROM whitelist_channel_users WHERE guild_id = ? AND channel_id = ? AND user_id = ?', [
      guildId,
      channelId,
      userId,
    ]);
    if (existing && !existing.expires_at) return 'permanent';
    await this.db.query(
      `INSERT INTO whitelist_channel_users (guild_id, channel_id, user_id, added_by, added_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), added_by = VALUES(added_by), added_at = VALUES(added_at)`,
      [guildId, channelId, userId, addedBy, new Date(), expiresAt],
    );
    this.invalidate(guildId);
    return existing ? 'extended' : 'added';
  }

  /** Retire un accès temporaire (jamais un accès permanent) ; renvoie true s'il existait. */
  async uninviteUser(guildId, channelId, userId) {
    const result = await this.db.query(
      'DELETE FROM whitelist_channel_users WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND expires_at IS NOT NULL',
      [guildId, channelId, userId],
    );
    this.invalidate(guildId);
    return Number(result.affectedRows ?? 0) > 0;
  }

  /** Accès temporaires échus (tous serveurs), supprimés de la base ; renvoie les lignes retirées. */
  async takeExpiredInvites(now = new Date()) {
    const rows = await this.db.query('SELECT guild_id, channel_id, user_id FROM whitelist_channel_users WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
    if (!rows.length) return [];
    await this.db.query('DELETE FROM whitelist_channel_users WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
    for (const guildId of new Set(rows.map((row) => String(row.guild_id)))) this.invalidate(guildId);
    return rows.map((row) => ({ guildId: String(row.guild_id), channelId: String(row.channel_id), userId: String(row.user_id) }));
  }

  // ── Admins d'un salon ────────────────────────────────────────────────────

  async addChannelAdmin(guildId, channelId, userId, addedBy) {
    await this.db.query('INSERT IGNORE INTO whitelist_channel_admins (guild_id, channel_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)', [
      guildId,
      channelId,
      userId,
      addedBy,
      new Date(),
    ]);
    this.invalidate(guildId);
  }

  async removeChannelAdmin(guildId, channelId, userId) {
    await this.db.query('DELETE FROM whitelist_channel_admins WHERE guild_id = ? AND channel_id = ? AND user_id = ?', [guildId, channelId, userId]);
    this.invalidate(guildId);
  }

  /** Remplace les admins d'un salon (panel web). */
  async replaceChannelAdmins(guildId, channelId, userIds, updatedBy) {
    await this.db.transaction(async (connection) => {
      await connection.query('DELETE FROM whitelist_channel_admins WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
      if (userIds.length) {
        const now = new Date();
        await connection.query('INSERT INTO whitelist_channel_admins (guild_id, channel_id, user_id, added_by, added_at) VALUES ?', [
          userIds.map((userId) => [guildId, channelId, userId, updatedBy, now]),
        ]);
      }
    });
    this.invalidate(guildId);
  }

  async replaceRoles(guildId, channelId, roleIds, updatedBy) {
    await this.db.transaction(async (connection) => {
      await connection.query('DELETE FROM whitelist_channel_roles WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
      if (roleIds.length) {
        const now = new Date();
        await connection.query('INSERT INTO whitelist_channel_roles (guild_id, channel_id, role_id, added_by, added_at) VALUES ?', [
          roleIds.map((roleId) => [guildId, channelId, roleId, updatedBy, now]),
        ]);
      }
    });
    this.invalidate(guildId);
  }

  /** Accès permanent (remplace un éventuel accès temporaire en cours). */
  async addUser(guildId, channelId, userId, updatedBy) {
    await this.db.query(
      `INSERT INTO whitelist_channel_users (guild_id, channel_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE expires_at = NULL`,
      [guildId, channelId, userId, updatedBy, new Date()],
    );
    this.invalidate(guildId);
  }

  async removeUser(guildId, channelId, userId) {
    await this.db.query('DELETE FROM whitelist_channel_users WHERE guild_id = ? AND channel_id = ? AND user_id = ?', [
      guildId,
      channelId,
      userId,
    ]);
    this.invalidate(guildId);
  }

  /** Réinitialise entièrement un salon (désactive, retire la limite, vide les listes). */
  async resetChannel(guildId, channelId) {
    await this.db.transaction(async (connection) => {
      await connection.query('DELETE FROM whitelist_channels WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
      await connection.query('DELETE FROM whitelist_channel_users WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
      await connection.query('DELETE FROM whitelist_channel_roles WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
      await connection.query('DELETE FROM whitelist_channel_admins WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
    });
    this.invalidate(guildId);
  }

  // ── Écriture (serveur) ────────────────────────────────────────────────────

  async setLogChannel(guildId, logChannelId, updatedBy) {
    await this.db.query(
      `INSERT INTO whitelist_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), updated_at = VALUES(updated_at)`,
      [guildId, logChannelId, new Date()],
    );
    this.invalidate(guildId);
    void updatedBy; // conservé pour un futur historique ; la table ne l'enregistre pas encore
  }

  async addAdmin(guildId, userId, addedBy) {
    await this.db.query('INSERT IGNORE INTO whitelist_admins (guild_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)', [
      guildId,
      userId,
      addedBy,
      new Date(),
    ]);
    this.invalidate(guildId);
  }

  async removeAdmin(guildId, userId) {
    await this.db.query('DELETE FROM whitelist_admins WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    this.invalidate(guildId);
  }

  async listAdmins(guildId) {
    const rows = await this.db.query(
      'SELECT user_id, added_by, added_at FROM whitelist_admins WHERE guild_id = ? ORDER BY added_at',
      [guildId],
    );
    return rows.map((row) => ({ userId: row.user_id, addedBy: row.added_by, addedAt: row.added_at }));
  }
}

module.exports = { WhitelistService };
