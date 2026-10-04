'use strict';

const ui = require('../../../src/bot/ui');
const { createScope } = require('./queries');
const { formatDuration } = require('../../../src/core/duration');

const DAY_MS = 86_400_000;
const CHECK_MS = 5 * 60_000;
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Jour de la semaine (1 = lundi) et heure courants dans un fuseau donné. */
function zonedNow(timezone, now = new Date()) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    return { weekday: WEEKDAYS[parts.weekday] ?? 1, hour: Number(parts.hour) };
  } catch {
    return { weekday: ((now.getUTCDay() + 6) % 7) + 1, hour: now.getUTCHours() };
  }
}

/** « ▲ 12 % » / « ▼ 4 % » / « = » par rapport à la période précédente (rien si pas de référence). */
function delta(current, previous) {
  if (previous === null || previous === undefined) return '';
  if (!previous) return current ? ' (nouveau)' : '';
  const change = Math.round(((current - previous) / previous) * 100);
  if (!change) return ' (=)';
  return ` (${change > 0 ? '▲' : '▼'} ${Math.abs(change)} %)`;
}

/**
 * Rapport hebdomadaire (désactivé par défaut, par serveur) : résumé des 7 derniers jours comparé aux 7 jours
 * précédents, publié dans le salon choisi au jour et à l'heure réglés, et conservé (onglet Rapports du panel).
 */
class ReportService {
  constructor({ db, client, queries, config, invites, logger, enabledFor }) {
    this.db = db;
    this.client = client;
    this.queries = queries;
    this.config = config;
    this.invites = invites;
    this.logger = logger;
    this.enabledFor = enabledFor;
    this.timer = null;
  }

  async totals(guildId, from, to) {
    const scope = createScope({ guildId, from, to, interval: 'day' });
    const [period, voice] = await Promise.all([this.queries.periodTotals(scope), this.queries.voiceTotals(scope)]);
    return {
      messages: period.messages,
      authors: period.authors,
      joins: period.joins,
      leaves: period.leaves,
      deletions: period.deletions,
      sanctions: period.bans + period.kicks + period.timeouts,
      voiceSeconds: voice.seconds,
      voiceUsers: voice.users,
    };
  }

  /** Données figées du rapport (enregistrées telles quelles en base). */
  async build(guild, to = new Date()) {
    const from = new Date(to.getTime() - 7 * DAY_MS);
    const previousFrom = new Date(from.getTime() - 7 * DAY_MS);
    const scope = createScope({ guildId: guild.id, from, to, interval: 'day' });
    const config = await this.config.get(guild.id);
    const [totals, previous, senders, channels, voice, invites] = await Promise.all([
      this.totals(guild.id, from, to),
      this.totals(guild.id, previousFrom, from),
      this.queries.topSenders(scope, 3),
      this.queries.topChannels(scope, 3),
      this.queries.topVoice(scope, 3),
      config.inviteTracking ? this.invites.leaderboard(guild.id, from, to, 3) : Promise.resolve(null),
    ]);
    const people = await this.queries.resolveUsers(guild.id, [...senders, ...voice, ...(invites ?? [])].map((row) => row.userId));
    const name = (id) => people.get(id)?.name ?? id;
    return {
      guild: { id: guild.id, name: guild.name },
      from,
      to,
      memberCount: guild.memberCount,
      totals,
      previous,
      senders: senders.map((row) => ({ userId: row.userId, name: name(row.userId), messages: row.messages })),
      channels: channels.map((row) => ({ channelId: row.channelId, name: row.name, messages: row.messages })),
      voice: voice.map((row) => ({ userId: row.userId, name: name(row.userId), seconds: row.seconds })),
      inviters: invites ? invites.map((row) => ({ userId: row.userId, name: name(row.userId), joins: row.joins, stayed: row.stayed })) : null,
    };
  }

  /** Carte Discord du rapport (style commun du bot, sombre). */
  card(data) {
    const t = data.totals;
    const p = data.previous;
    const medal = (i) => ['🥇', '🥈', '🥉'][i] ?? '•';
    const body = [
      {
        stats: [
          ['Messages', `${t.messages}${delta(t.messages, p?.messages)}`],
          ['Membres actifs (écrit)', `${t.authors}${delta(t.authors, p?.authors)}`],
          ['Temps vocal', `${formatDuration(t.voiceSeconds)}${delta(t.voiceSeconds, p?.voiceSeconds)}`],
          ['Arrivées / départs', `+${t.joins} / -${t.leaves}`],
          ['Messages supprimés', `${t.deletions}${delta(t.deletions, p?.deletions)}`],
          ['Sanctions', `${t.sanctions}${delta(t.sanctions, p?.sanctions)}`],
          ['Membres', String(data.memberCount ?? '—')],
        ],
      },
      data.senders.length ? { item: { emoji: '💬', title: 'Les plus bavards', lines: data.senders.map((r, i) => `${medal(i)} <@${r.userId}> — ${r.messages} messages`) } } : null,
      data.channels.length ? { item: { emoji: '📍', title: 'Salons les plus actifs', lines: data.channels.map((r, i) => `${medal(i)} <#${r.channelId}> — ${r.messages} messages`) } } : null,
      data.voice.length ? { item: { emoji: '🎙️', title: 'Les plus présents en vocal', lines: data.voice.map((r, i) => `${medal(i)} <@${r.userId}> — ${formatDuration(r.seconds)}`) } } : null,
      data.inviters?.length
        ? { item: { emoji: '📨', title: 'Meilleurs parrains', lines: data.inviters.map((r, i) => `${medal(i)} <@${r.userId}> — ${r.joins} arrivée(s), ${r.stayed} restée(s)`) } }
        : null,
    ];
    return ui.card({
      title: `Rapport hebdomadaire — ${data.guild.name}`,
      description: `📊 Du ${ui.ts(data.from, 'D')} au ${ui.ts(data.to, 'D')} · comparé aux 7 jours précédents`,
      body,
      footer: 'Détails et historique des rapports : panel web, Statistiques → Rapports',
      timestamp: true,
    });
  }

  /** Génère, enregistre et publie (si un salon est réglé) un rapport ; renvoie { id, posted, error? }. */
  async generate(guild, { origin = 'auto', createdBy = null } = {}) {
    const data = await this.build(guild);
    const config = await this.config.get(guild.id);
    let channelId = null;
    let messageId = null;
    let error = null;
    if (config.reportChannelId) {
      try {
        const channel = guild.channels.cache.get(config.reportChannelId) ?? (await guild.channels.fetch(config.reportChannelId));
        if (!channel?.isTextBased()) throw new Error('salon introuvable ou non textuel');
        const message = await channel.send({ ...ui.payload(this.card(data)), allowedMentions: { parse: [] } });
        channelId = channel.id;
        messageId = message.id;
      } catch (err) {
        error = `Publication impossible : ${err.message}`;
        this.logger.warn(`Rapport hebdomadaire de « ${guild.name} » non publié`, err.message);
      }
    }
    const result = await this.db.query(
      `INSERT INTO stats_reports (guild_id, period_from, period_to, data, channel_id, message_id, origin, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guild.id, data.from, data.to, JSON.stringify(data), channelId, messageId, origin, createdBy, new Date()],
    );
    if (origin === 'auto') await this.config.update(guild.id, { last_report_at: new Date() });
    return { id: result.insertId, posted: Boolean(messageId), error };
  }

  async list(guildId, limit = 52) {
    const rows = await this.db.query(
      'SELECT id, period_from, period_to, channel_id, message_id, origin, created_by, created_at FROM stats_reports WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?',
      [guildId, limit],
    );
    return rows;
  }

  async get(guildId, id) {
    const row = await this.db.one('SELECT * FROM stats_reports WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!row) return null;
    return { ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data };
  }

  async remove(guildId, id) {
    const result = await this.db.query('DELETE FROM stats_reports WHERE guild_id = ? AND id = ?', [guildId, id]);
    return Number(result.affectedRows ?? 0) > 0;
  }

  // ── Planification ────────────────────────────────────────────────────────

  /** Le jour réglé, à partir de l'heure réglée (fuseau du serveur), si aucun rapport auto depuis 6 jours. */
  isDue(config, now = new Date()) {
    if (!config.reportEnabled) return false;
    const { weekday, hour } = zonedNow(config.reportTimezone, now);
    if (weekday !== config.reportWeekday || hour < config.reportHour) return false;
    return !config.lastReportAt || now - config.lastReportAt >= 6 * DAY_MS;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const guildId of await this.config.reportGuildIds()) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild || !this.enabledFor(guildId)) continue;
        if (!this.isDue(await this.config.get(guildId))) continue;
        await this.generate(guild).catch((err) => this.logger.error(`Rapport hebdomadaire de « ${guild.name} » impossible`, err));
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    const run = () => this.tick().catch((err) => this.logger.error('Planification des rapports impossible', err));
    run();
    this.timer = setInterval(run, CHECK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ReportService, zonedNow };
