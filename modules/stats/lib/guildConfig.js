'use strict';

const DEFAULTS = Object.freeze({
  reportEnabled: false,
  reportChannelId: null,
  reportWeekday: 1,
  reportHour: 9,
  reportTimezone: 'Europe/Paris',
  lastReportAt: null,
  inviteTracking: false,
});

/**
 * Réglages par serveur du module Statistiques (rapport hebdomadaire, suivi des invitations), distincts des
 * réglages globaux lus dans l'environnement (lib/settings.js). Mis en cache, invalidés à l'écriture.
 */
class GuildConfigService {
  constructor({ db }) {
    this.db = db;
    this.cache = new Map();
  }

  async get(guildId) {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    const row = await this.db.one('SELECT * FROM stats_guild_settings WHERE guild_id = ?', [guildId]);
    const config = row
      ? {
          reportEnabled: Boolean(Number(row.report_enabled)),
          reportChannelId: row.report_channel_id ? String(row.report_channel_id) : null,
          reportWeekday: Number(row.report_weekday),
          reportHour: Number(row.report_hour),
          reportTimezone: row.report_timezone || DEFAULTS.reportTimezone,
          lastReportAt: row.last_report_at ? new Date(row.last_report_at) : null,
          inviteTracking: Boolean(Number(row.invite_tracking)),
        }
      : { ...DEFAULTS };
    this.cache.set(guildId, config);
    return config;
  }

  /** `patch` : sous-ensemble des colonnes ci-dessous (noms SQL). */
  async update(guildId, patch) {
    const allowed = ['report_enabled', 'report_channel_id', 'report_weekday', 'report_hour', 'report_timezone', 'last_report_at', 'invite_tracking'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const columns = entries.map(([key]) => key);
    await this.db.query(
      `INSERT INTO stats_guild_settings (guild_id, ${columns.join(', ')}, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_at = VALUES(updated_at)`,
      [guildId, ...entries.map(([, value]) => value), new Date()],
    );
    this.cache.delete(guildId);
  }

  /** Serveurs dont le rapport hebdomadaire est activé. */
  async reportGuildIds() {
    const rows = await this.db.query('SELECT guild_id FROM stats_guild_settings WHERE report_enabled = 1');
    return rows.map((row) => String(row.guild_id));
  }
}

module.exports = { GuildConfigService };
