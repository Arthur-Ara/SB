'use strict';

const HEARTBEAT_MS = 60_000;

/**
 * Suivi du temps passé en vocal : une session est ouverte à la connexion à un salon
 * et fermée à la déconnexion (ou au changement de salon). Un battement de cœur
 * périodique permet, après un arrêt brutal, de refermer les sessions orphelines
 * à la dernière heure où le bot était vivant.
 */
class VoiceTracker {
  constructor({ db, store, logger, settings, client }) {
    this.db = db;
    this.store = store;
    this.logger = logger;
    this.settings = settings;
    this.client = client;
    this.timer = null;
  }

  /** À appeler au démarrage, avant tout nouvel enregistrement. */
  async recoverOrphans() {
    const last = await this.store.getMeta('heartbeat_at');
    const closeAt = last ? new Date(last) : null;
    const result = await this.db.query(
      `UPDATE stats_voice_sessions
          SET left_at = GREATEST(joined_at, COALESCE(CAST(? AS DATETIME(3)), joined_at)),
              duration_seconds = TIMESTAMPDIFF(SECOND, joined_at, GREATEST(joined_at, COALESCE(CAST(? AS DATETIME(3)), joined_at)))
        WHERE left_at IS NULL`,
      [closeAt, closeAt],
    );
    if (result.affectedRows) {
      this.logger.info(`${result.affectedRows} session(s) vocale(s) interrompue(s) refermée(s) au dernier signe de vie`);
    }
  }

  startHeartbeat() {
    const beat = () =>
      this.store.setMeta('heartbeat_at', new Date().toISOString()).catch((err) => this.logger.warn('Heartbeat', err.message));
    beat();
    this.timer = setInterval(beat, HEARTBEAT_MS);
    this.timer.unref();
  }

  isBot(state) {
    return Boolean(state.member?.user?.bot ?? this.client.users.cache.get(state.id)?.bot);
  }

  /** Salon comptabilisé (le salon AFK peut être exclu). */
  trackedChannel(state) {
    const channelId = state.channelId;
    if (!channelId) return null;
    if (this.settings.voiceExcludeAfk && channelId === state.guild.afkChannelId) return null;
    return channelId;
  }

  async handleUpdate(oldState, newState) {
    if (this.isBot(newState)) return;
    const before = this.trackedChannel(oldState);
    const after = this.trackedChannel(newState);
    if (before === after) return; // micro coupé, caméra, stream… : pas de changement de salon

    const now = new Date();
    await this.close(newState.guild.id, newState.id, now);
    if (after) await this.open(newState.guild.id, newState.id, after, now);
  }

  async open(guildId, userId, channelId, at) {
    await this.db.query(
      'INSERT INTO stats_voice_sessions (guild_id, user_id, channel_id, joined_at) VALUES (?, ?, ?, ?)',
      [guildId, userId, channelId, at],
    );
  }

  async close(guildId, userId, at) {
    await this.db.query(
      `UPDATE stats_voice_sessions
          SET left_at = GREATEST(joined_at, CAST(? AS DATETIME(3))), duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, joined_at, CAST(? AS DATETIME(3))))
        WHERE guild_id = ? AND user_id = ? AND left_at IS NULL`,
      [at, at, guildId, userId],
    );
  }

  async closeGuild(guildId, at = new Date()) {
    await this.db.query(
      `UPDATE stats_voice_sessions
          SET left_at = GREATEST(joined_at, CAST(? AS DATETIME(3))), duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, joined_at, CAST(? AS DATETIME(3))))
        WHERE guild_id = ? AND left_at IS NULL`,
      [at, at, guildId],
    );
  }

  /** Ouvre une session pour chaque membre déjà en vocal au démarrage du bot. */
  async scanActive(guilds) {
    const now = new Date();
    const open = await this.db.query('SELECT guild_id, user_id, channel_id FROM stats_voice_sessions WHERE left_at IS NULL');
    const openByKey = new Map(open.map((row) => [`${row.guild_id}:${row.user_id}`, row.channel_id]));
    let opened = 0;

    for (const guild of guilds) {
      for (const state of guild.voiceStates.cache.values()) {
        if (this.isBot(state)) continue;
        const channelId = this.trackedChannel(state);
        if (!channelId) continue;
        const key = `${guild.id}:${state.id}`;
        if (openByKey.get(key) === channelId) continue;
        if (openByKey.has(key)) await this.close(guild.id, state.id, now);
        await this.open(guild.id, state.id, channelId, now);
        opened += 1;
      }
    }
    if (opened) this.logger.info(`${opened} membre(s) déjà en vocal : sessions ouvertes`);
  }

  async shutdown() {
    clearInterval(this.timer);
    const now = new Date();
    await this.db.query(
      `UPDATE stats_voice_sessions
          SET left_at = GREATEST(joined_at, CAST(? AS DATETIME(3))), duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, joined_at, CAST(? AS DATETIME(3))))
        WHERE left_at IS NULL`,
      [now, now],
    );
    await this.store.setMeta('heartbeat_at', now.toISOString());
  }
}

module.exports = { VoiceTracker };
