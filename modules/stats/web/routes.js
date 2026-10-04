'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, wrap, textChannelId } = require('../../../src/web/helpers');
const { guildAccess } = require('../../permissions/lib/webAccess');
const { isTimezone } = require('../../../src/core/schedule');
const { createScope } = require('../lib/queries');
const { isSnowflake } = require('../lib/discordUtils');
const { sanitizeOffset } = require('../lib/buckets');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPAN_MS = 5 * 366 * DAY_MS;
const INTERVALS = new Set(['auto', 'minute', 'hour', 'day', 'week', 'month']);
const SERIES_GROUPS = new Set(['messages', 'members', 'events', 'deletions', 'voice', 'moderation']);

function parseDate(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Date invalide : ${value}`);
  return date;
}

/**
 * Monte l'interface web du module sous /m/stats/. Accès : membres du serveur ayant le droit `stats` (view) du
 * panel ; les informations d'autres serveurs (fiche membre) ne sont montrées que pour les serveurs accessibles.
 */
module.exports = function registerWeb(router, ctx) {
  const { queries, guildConfig, reports, invites } = ctx.services;
  const access = guildAccess(ctx, { module: 'stats', category: 'stats', label: 'Statistiques' });

  /** Totaux de la période précédente de même durée (comparaison sur les tuiles du dashboard). */
  async function previousTotals(scope) {
    const span = scope.to.getTime() - scope.from.getTime();
    const previous = createScope({ guildId: scope.guildId, from: new Date(scope.from.getTime() - span), to: scope.from, interval: 'day', offset: scope.offset });
    const [totals, voice] = await Promise.all([queries.periodTotals(previous), queries.voiceTotals(previous)]);
    return { ...totals, voiceSeconds: voice.seconds, voiceUsers: voice.users, from: previous.from, to: previous.to };
  }

  function textChannelsOf(guild) {
    return [...guild.channels.cache.values()]
      .filter((c) => c.isTextBased() && !c.isThread() && !c.isVoiceBased() && c.viewable)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  async function configJson(guild) {
    const config = await guildConfig.get(guild.id);
    return {
      ...config,
      canReadInvites: invites.canRead(guild),
      textChannels: textChannelsOf(guild),
    };
  }

  async function scopeFrom(req) {
    const guild = await access.guild(req, 'view');
    if (!(await queries.guildExists(guild.id))) throw new HttpError(404, 'Aucune statistique pour ce serveur');
    const to = parseDate(req.query.to, new Date());
    const from = parseDate(req.query.from, new Date(to.getTime() - 7 * DAY_MS));
    if (from >= to) throw new HttpError(400, 'La date de début doit précéder la date de fin');
    if (to - from > MAX_SPAN_MS) throw new HttpError(400, 'Période trop longue (5 ans maximum)');
    const interval = INTERVALS.has(req.query.interval) ? req.query.interval : 'auto';
    return createScope({ guildId: guild.id, from, to, interval, offset: sanitizeOffset(req.query.tz) });
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // maxAge: 0 (revalidation systématique) — évite de servir un .js périmé après un redéploiement.
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
  router.get('/membre', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'member.html')));
  router.get('/rapports', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reports.html')));

  // Serveurs suivis (base) ET accessibles à ce compte (bot présent, module activé, droit du panel).
  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      const [tracked, allowed] = await Promise.all([queries.guilds(), access.guilds(req)]);
      const allowedIds = new Set(allowed.map((g) => g.id));
      res.json(tracked.filter((g) => allowedIds.has(String(g.id))));
    }),
  );

  // `compare=1` : ajoute les totaux de la période précédente de même durée.
  router.get(
    '/api/overview',
    wrap(async (req, res) => {
      const scope = await scopeFrom(req);
      const [overview, previous] = await Promise.all([queries.overview(scope), req.query.compare === '1' ? previousTotals(scope) : null]);
      res.json(previous ? { ...overview, previous } : overview);
    }),
  );

  // ── Invitations ──────────────────────────────────────────────────────────

  router.get(
    '/api/invites',
    wrap(async (req, res) => {
      const scope = await scopeFrom(req);
      const config = await guildConfig.get(scope.guildId);
      if (!config.inviteTracking) return res.json({ enabled: false });
      const [leaderboard, sources, codes] = await Promise.all([
        invites.leaderboard(scope.guildId, scope.from, scope.to, 15),
        invites.sources(scope.guildId, scope.from, scope.to),
        invites.topCodes(scope.guildId, scope.from, scope.to, 10),
      ]);
      const people = await queries.resolveUsers(scope.guildId, [...leaderboard.map((r) => r.userId), ...codes.map((c) => c.inviterId)]);
      res.json({
        enabled: true,
        leaderboard: leaderboard.map((row) => ({ ...row, user: people.get(row.userId) })),
        sources,
        codes: codes.map((row) => ({ ...row, inviter: row.inviterId ? people.get(row.inviterId) : null })),
      });
    }),
  );

  // ── Réglages par serveur et rapports hebdomadaires ───────────────────────

  router.get(
    '/api/config',
    wrap(async (req, res) => {
      res.json(await configJson(await access.guild(req, 'view')));
    }),
  );

  router.post(
    '/api/config',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const body = req.body ?? {};
      const weekday = Number(body.reportWeekday);
      const hour = Number(body.reportHour);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new HttpError(400, 'Jour invalide.');
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new HttpError(400, 'Heure invalide (0 à 23).');
      const timezone = String(body.reportTimezone || 'Europe/Paris');
      if (!isTimezone(timezone)) throw new HttpError(400, 'Fuseau horaire inconnu (ex. Europe/Paris).');
      const channelId = textChannelId(guild, body.reportChannelId);
      if (body.reportEnabled === true && !channelId) throw new HttpError(400, 'Choisis le salon où publier le rapport.');
      const before = await guildConfig.get(guild.id);
      const inviteTracking = body.inviteTracking === true;
      if (inviteTracking && !invites.canRead(guild)) throw new HttpError(409, 'Le bot a besoin de la permission « Gérer le serveur » pour lire les invitations.');
      await guildConfig.update(guild.id, {
        report_enabled: body.reportEnabled === true ? 1 : 0,
        report_channel_id: channelId,
        report_weekday: weekday,
        report_hour: hour,
        report_timezone: timezone,
        invite_tracking: inviteTracking ? 1 : 0,
      });
      // Activation du suivi : état de référence des invitations, sinon la première arrivée resterait « inconnue ».
      if (inviteTracking && !before.inviteTracking) await invites.snapshot(guild);
      res.json(await configJson(guild));
    }),
  );

  router.get(
    '/api/reports',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const rows = await reports.list(guild.id);
      res.json(
        rows.map((row) => ({
          id: row.id,
          from: row.period_from,
          to: row.period_to,
          origin: row.origin,
          createdAt: row.created_at,
          posted: Boolean(row.message_id),
          url: row.message_id ? `https://discord.com/channels/${guild.id}/${row.channel_id}/${row.message_id}` : null,
        })),
      );
    }),
  );

  router.get(
    '/api/reports/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const report = await reports.get(guild.id, Number(req.params.id) || 0);
      if (!report) throw new HttpError(404, 'Rapport introuvable');
      res.json({ id: report.id, origin: report.origin, createdAt: report.created_at, data: report.data });
    }),
  );

  router.post(
    '/api/reports',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const result = await reports.generate(guild, { origin: 'manual', createdBy: req.session.user.id });
      res.json(result);
    }),
  );

  router.delete(
    '/api/reports/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      if (!(await reports.remove(guild.id, Number(req.params.id) || 0))) throw new HttpError(404, 'Rapport introuvable');
      res.json({ ok: true });
    }),
  );

  // Séries d'un seul groupe : graphique avec sa propre période.
  router.get(
    '/api/series',
    wrap(async (req, res) => {
      const group = String(req.query.group ?? '');
      if (!SERIES_GROUPS.has(group)) throw new HttpError(400, 'Groupe de séries inconnu');
      res.json(await queries.series(await scopeFrom(req), group));
    }),
  );

  router.get(
    '/api/leaderboards',
    wrap(async (req, res) => {
      res.json(await queries.leaderboards(await scopeFrom(req)));
    }),
  );

  router.get(
    '/api/roles',
    wrap(async (req, res) => {
      res.json(await queries.roles(await scopeFrom(req)));
    }),
  );

  router.get(
    '/api/role-ranking',
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 15);
      res.json(await queries.roleMentionRanking(await scopeFrom(req), limit));
    }),
  );

  router.get(
    '/api/role-mentions',
    wrap(async (req, res) => {
      const roleId = String(req.query.role ?? '');
      if (!isSnowflake(roleId)) throw new HttpError(400, 'Rôle invalide');
      res.json(await queries.roleMentionSeries(await scopeFrom(req), roleId));
    }),
  );

  router.get(
    '/api/member/:userId',
    wrap(async (req, res) => {
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres attendus)');
      const scope = await scopeFrom(req);
      const [profile, allowed] = await Promise.all([queries.memberProfile(scope, userId), access.guilds(req)]);
      if (!profile) throw new HttpError(404, 'Aucune donnée pour cet utilisateur');
      // Pas de fuite inter-serveurs : seuls les serveurs que ce compte peut consulter apparaissent dans la fiche.
      const allowedIds = new Set(allowed.map((g) => g.id));
      profile.guilds = profile.guilds.filter((g) => allowedIds.has(String(g.id)));
      profile.names = profile.names.filter((n) => !n.guildId || allowedIds.has(String(n.guildId)));
      res.json(profile);
    }),
  );
};
