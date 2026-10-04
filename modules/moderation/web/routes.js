'use strict';

const path = require('node:path');
const express = require('express');
const { AuditLogEvent, ChannelType, PermissionFlagsBits } = require('discord.js');
const { HttpError, wrap, isSnowflake, avatarUrl, textChannelId } = require('../../../src/web/helpers');
const { chunk } = require('../../../src/core/database');
const { guildAccess } = require('../../permissions/lib/webAccess');
const { checkSafety } = require('../lib/guard');
const { notifyTarget, meta } = require('../lib/format');
const { proofUrl } = require('../lib/proofs');
const { isChannelLocked, lockChannel, unlockChannel } = require('../lib/channelLock');
const { ensurePrisonCategory, slugifyChannelName, denyChannelAccess, restoreChannelAccess } = require('../lib/prison');
const { WARN_RULE_ACTIONS, DURATION_ACTIONS, isActive, applyTempBan, applyWarnRules, editSanction, revokeSanction } = require('../lib/sanctions');
const { normalizeWord, scan } = require('../lib/automod');
const ui = require('../../../src/bot/ui');
const { parseDuration, formatDuration } = require('../../../src/core/duration');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const BANS_TTL_MS = 60_000;
const AUDIT_TTL_MS = 5 * 60_000;
const AUDIT_PAGES = 10; // 100 entrées par page

/** Catégories de l'historique : onglet → types d'actions enregistrés (moderation_actions.action). */
const CATEGORIES = {
  ban: ['ban', 'unban', 'tempban', 'untempban'],
  kick: ['kick'],
  warn: ['warn', 'removewarn'],
  mute: ['tempmute', 'unmute'],
  vocmute: ['tempvocmute', 'untempvocmute'],
  shadowban: ['shadowban', 'unshadowban'],
  channels: ['lock', 'unlock', 'lockall', 'unlockall', 'slowmode', 'clear', 'purge'],
  blacklist: ['blacklist', 'unblacklist'],
  automod: ['automod'],
};

/** Sanctions annulables depuis l'historique (voir lib/sanctions.js#revokeSanction). */
const REVOCABLE = new Set(['warn', 'tempmute', 'tempvocmute', 'ban', 'tempban']);
const MAX_TEMPBAN_S = 365 * 86_400;
const MAX_LOCK_S = 30 * 86_400;

/** Durée saisie sur le panel (« 2h », « 7j »…) : null si vide, HttpError si invalide ou au-delà de `max`. */
function durationOf(value, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const seconds = parseDuration(value);
  if (!seconds || seconds > max) throw new HttpError(400, `Durée invalide : par exemple 30m, 12h ou 7j (${formatDuration(max)} maximum).`);
  return seconds;
}

/**
 * Interface web du module Modération (/m/moderation/) : bannis, avertissements, salons verrouillés,
 * shadow-bans et mutes vocaux temporaires actifs, avec les actions correspondantes. Toute action génère
 * un log Discord (salon défini par /modlogs), attribué à l'auteur connecté au dashboard. Accès : membres du
 * serveur ayant le droit `moderation` (view / manage) du panel (voir /permission grant-panel).
 */
module.exports = function registerWeb(router, ctx) {
  const { moderation, logs } = ctx.services;
  const access = guildAccess(ctx, { module: 'moderation', category: 'moderation', label: 'Modération' });

  function webUserOf(req) {
    const user = req.session.user;
    return { id: user.id, name: user.globalName || user.username };
  }

  function safetyOf(guild, actorId, targetId) {
    return checkSafety(ctx.client, guild, actorId, targetId, { owners: ctx.config.owners });
  }

  function person(guild, userId, fallbackUser = null) {
    if (!userId) return null;
    const member = guild.members.cache.get(userId);
    const user = member?.user ?? ctx.client.users.cache.get(userId) ?? fallbackUser;
    return {
      id: userId,
      name: member?.nickname || user?.globalName || user?.username || userId,
      username: user?.username ?? null,
      avatar: avatarUrl(userId, user?.avatar ?? null),
      inGuild: Boolean(member),
    };
  }

  function textChannelOf(guild, channelId) {
    if (!isSnowflake(channelId)) throw new HttpError(400, 'Salon invalide');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !TEXT_TYPES.has(channel.type)) throw new HttpError(404, 'Salon textuel introuvable');
    return channel;
  }

  async function resolveUser(userId) {
    return ctx.client.users.cache.get(userId) ?? (await ctx.client.users.fetch(userId).catch(() => null));
  }

  // ── Bannis : la liste complète vient de Discord (coûteuse) → cache court, tenu à jour par nos propres actions ──

  const banCache = new Map(); // guildId → { at, map: Map(userId → { user, reason }) }

  /** Tous les bannissements Discord : l'API plafonne chaque requête à 1000, on pagine jusqu'à épuisement. */
  async function fetchAllBans(guild) {
    const all = new Map();
    let after;
    for (;;) {
      const page = await guild.bans.fetch({ limit: 1000, after, cache: false });
      for (const ban of page.values()) all.set(ban.user.id, { user: ban.user, reason: ban.reason ?? null });
      if (page.size < 1000) break;
      after = page.lastKey();
    }
    return all;
  }

  async function bansOf(guild, { fresh = false } = {}) {
    const cached = banCache.get(guild.id);
    if (!fresh && cached && Date.now() - cached.at < BANS_TTL_MS) return cached.map;
    const map = await fetchAllBans(guild);
    banCache.set(guild.id, { at: Date.now(), map });
    return map;
  }

  /** Après un ban/déban fait par le panel : on corrige le cache au lieu de tout relire. */
  function patchBanCache(guildId, userId, entry) {
    const cached = banCache.get(guildId);
    if (!cached) return;
    if (entry) cached.map.set(userId, entry);
    else cached.map.delete(userId);
  }

  /** Identité d'un membre, même absent du cache (récupéré une fois par requête). */
  async function personFor(guild, userId, cache) {
    if (!userId) return null;
    if (!cache.has(userId)) {
      if (!guild.members.cache.has(userId) && !ctx.client.users.cache.has(userId)) await resolveUser(userId);
      cache.set(userId, person(guild, userId));
    }
    return cache.get(userId);
  }

  async function historyJson(guild, { category, userId, page }) {
    const pageSize = 25;
    const actions = category === 'all' ? null : CATEGORIES[category];
    const { rows, total } = await moderation.historyPage(guild.id, { actions, userId, limit: pageSize, offset: (page - 1) * pageSize });
    const proofs = await moderation.proofsForActions(guild.id, rows.map((row) => row.id));
    const cache = new Map();
    const entries = [];
    for (const row of rows) {
      const { emoji, label } = meta(row.action);
      entries.push({
        id: row.id,
        action: row.action,
        emoji,
        label,
        target: await personFor(guild, row.target_id, cache),
        executor: await personFor(guild, row.executor_id, cache),
        channel: row.channel_id ? { id: row.channel_id, name: guild.channels.cache.get(row.channel_id)?.name ?? null } : null,
        reason: row.reason,
        durationS: row.duration_s,
        expiresAt: row.expires_at,
        active: isActive(row),
        createdAt: row.created_at,
        editedAt: row.edited_at ?? null,
        editedBy: row.edited_by ? await personFor(guild, String(row.edited_by), cache) : null,
        revocable: REVOCABLE.has(row.action) && (row.action === 'ban' || isActive(row)),
        durationEditable: DURATION_ACTIONS.has(row.action) && isActive(row),
        proofs: (proofs.get(Number(row.id)) ?? []).map((p) => ({
          id: p.id,
          url: proofUrl(guild.id, p),
          authorId: p.author_id,
          content: p.content,
          attachments: p.attachments ? (typeof p.attachments === 'string' ? JSON.parse(p.attachments) : p.attachments) : [],
        })),
      });
    }
    return { category, userId, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), entries };
  }

  const auditCache = new Map(); // guildId → { at, map } (le journal d'audit est coûteux : au plus un rafraîchissement / 5 min)

  /** Bannissements du journal d'audit Discord (45 jours d'historique au plus) : targetId → { executorId, createdAt, reason }. */
  async function auditBans(guild) {
    const cached = auditCache.get(guild.id);
    if (cached && Date.now() - cached.at < AUDIT_TTL_MS) return cached.map;
    const map = new Map();
    if (guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      let before;
      for (let page = 0; page < AUDIT_PAGES; page += 1) {
        const entries = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 100, before }).catch(() => null);
        if (!entries?.entries.size) break;
        for (const entry of entries.entries.values()) {
          if (entry.targetId && !map.has(entry.targetId)) map.set(entry.targetId, { executorId: entry.executorId, createdAt: entry.createdAt, reason: entry.reason });
        }
        if (entries.entries.size < 100) break;
        before = entries.entries.last().id;
      }
    }
    auditCache.set(guild.id, { at: Date.now(), map });
    return map;
  }

  /**
   * Bannissements connus du module Statistiques (journal d'audit synchronisé, y compris l'historique rétroactif),
   * uniquement pour les bannis que la base du bot ne connaît pas. Table absente : aucun résultat.
   */
  async function statsBans(guild, userIds) {
    const map = new Map();
    if (!userIds.length) return map;
    try {
      for (const part of chunk(userIds, 1000)) {
        const rows = await ctx.db.query(
          `SELECT target_id, executor_id, created_at, reason FROM stats_moderation_actions
            WHERE guild_id = ? AND action = 'ban' AND target_id IN (?) ORDER BY created_at ASC`,
          [guild.id, part],
        );
        for (const row of rows) map.set(String(row.target_id), { executorId: row.executor_id ? String(row.executor_id) : null, createdAt: row.created_at, reason: row.reason });
      }
    } catch {
      // module Statistiques absent : pas d'information supplémentaire
    }
    return map;
  }

  /** Types de tickets du serveur (contestations) : vide si le module Tickets est absent ou désactivé. */
  async function appealTicketTypes(guild) {
    if (!ctx.modules.isEnabledFor('tickets', guild.id)) return [];
    const tickets = ctx.modules.services('tickets')?.tickets;
    if (!tickets) return [];
    return (await tickets.listAllTypes(guild.id)).map((type) => ({ id: String(type.id), label: type.label, emoji: type.emoji ?? null }));
  }

  function rolesOf(guild) {
    return [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }));
  }

  async function automodJson(guild) {
    const [settings, lists, hits] = await Promise.all([moderation.settings(guild.id), moderation.automodLists(guild.id), moderation.listAutomodHits(guild.id)]);
    const cache = new Map();
    const hitRows = [];
    for (const hit of hits) {
      hitRows.push({
        id: hit.id,
        user: await personFor(guild, String(hit.user_id), cache),
        channel: { id: String(hit.channel_id), name: guild.channels.cache.get(String(hit.channel_id))?.name ?? null },
        content: hit.content,
        word: hit.matched_word,
        token: hit.token,
        score: hit.score,
        action: hit.action,
        falsePositive: Boolean(Number(hit.false_positive)),
        allowed: lists.allowSet.has(hit.token),
        reviewedBy: hit.reviewed_by ? await personFor(guild, String(hit.reviewed_by), cache) : null,
        createdAt: hit.created_at,
      });
    }
    return {
      settings: settings.automod,
      words: lists.words.map((row) => ({ id: row.id, word: row.word, createdAt: row.created_at })),
      allow: lists.allow.map((row) => ({ token: row.token, createdAt: row.created_at })),
      hits: hitRows,
      roles: rolesOf(guild),
      channels: [...guild.channels.cache.values()]
        .filter((c) => TEXT_TYPES.has(c.type) || c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, category: c.type === ChannelType.GuildCategory })),
    };
  }

  async function notesJson(guild, userId) {
    const cache = new Map();
    const notes = [];
    for (const note of await moderation.listNotes(guild.id, userId)) {
      notes.push({ id: note.id, content: note.content, author: await personFor(guild, String(note.author_id), cache), createdAt: note.created_at });
    }
    return { userId, notes };
  }

  async function stateJson(guild, { fresh = false } = {}) {
    const [bans, banRecords, warns, lockInfo, shadowbans, tempVocMutes, settings, tempBans, warnRules, ticketTypes] = await Promise.all([
      bansOf(guild, { fresh }),
      moderation.banRecords(guild.id),
      moderation.activeWarnsForGuild(guild.id),
      moderation.lockInfo(guild.id),
      moderation.listShadowbans(guild.id),
      moderation.activeTempVocMutesForGuild(guild.id),
      moderation.settings(guild.id),
      moderation.activeTempBansForGuild(guild.id),
      moderation.listWarnRules(guild.id),
      appealTicketTypes(guild),
    ]);
    const lockedChannelIds = [...lockInfo.keys()];
    const unknown = [...bans.keys()].filter((id) => !banRecords.has(id));
    const [fromStats, fromAudit] = unknown.length ? await Promise.all([statsBans(guild, unknown), auditBans(guild)]) : [new Map(), new Map()];

    const textChannels = [...guild.channels.cache.values()]
      .filter((c) => TEXT_TYPES.has(c.type))
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name }));
    const lockedSet = new Set(lockedChannelIds.map(String));

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      settings: {
        logChannelId: settings.logChannelId,
        appealEnabled: settings.appealEnabled,
        appealTicketTypeId: settings.appealTicketTypeId,
      },
      ticketTypes,
      warnRules: warnRules.map((rule) => ({ id: rule.id, warnCount: rule.warn_count, action: rule.action, durationMinutes: rule.duration_minutes })),
      textChannels,
      // Tous les bannis du serveur (la liste vient de Discord, sans limite de date). Date et auteur : base du bot,
      // sinon base Statistiques, sinon journal d'audit (45 jours) ; inconnus au-delà (ban fait hors du bot et ancien).
      bans: [...bans.entries()].map(([id, ban]) => {
        const record = banRecords.get(id);
        const known = record
          ? { executorId: record.executor_id, createdAt: record.created_at, reason: record.reason }
          : fromStats.get(id) ?? fromAudit.get(id) ?? null;
        return {
          userId: id,
          person: person(guild, id, ban.user),
          reason: ban.reason ?? known?.reason ?? null,
          executorId: known?.executorId ?? null,
          executorPerson: known?.executorId ? person(guild, known.executorId) : null,
          bannedAt: known?.createdAt ?? null,
          expiresAt: tempBans.get(id)?.expires_at ?? null,
        };
      }),
      warns: warns.map((row) => ({
        id: row.id,
        userId: row.target_id,
        person: person(guild, row.target_id),
        reason: row.reason,
        createdAt: row.created_at,
        executorId: row.executor_id,
        executorPerson: person(guild, row.executor_id),
      })),
      lockedChannels: textChannels.filter((c) => lockedSet.has(c.id)).map((c) => ({ ...c, unlockAt: lockInfo.get(c.id) ?? null })),
      lockableChannels: textChannels.filter((c) => !lockedSet.has(c.id)),
      shadowbans: shadowbans.map((row) => ({
        userId: row.user_id,
        person: person(guild, row.user_id),
        prisonChannelId: row.prison_channel_id,
        prisonChannelName: guild.channels.cache.get(row.prison_channel_id)?.name ?? null,
        reason: row.reason,
        createdAt: row.created_at,
        executorId: row.executor_id,
        executorPerson: row.executor_id ? person(guild, row.executor_id) : null,
      })),
      tempVocMutes: tempVocMutes.map((row) => ({
        id: row.id,
        userId: row.target_id,
        person: person(guild, row.target_id),
        reason: row.reason,
        expiresAt: row.expires_at,
        executorId: row.executor_id,
        executorPerson: person(guild, row.executor_id),
      })),
    };
  }

  // Les données de l'API reflètent l'état Discord du moment : jamais de cache navigateur/proxy.
  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'moderation.html')));

  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      res.json(await access.guilds(req));
    }),
  );

  // `?fresh=1` (bouton « Actualiser ») : relit la liste des bannis auprès de Discord.
  router.get(
    '/api/state',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      res.json(await stateJson(guild, { fresh: req.query.fresh === '1' }));
    }),
  );

  // Historique complet par catégorie (ban, kick, warn…) ou par joueur (category=all&user=ID).
  router.get(
    '/api/history',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const category = String(req.query.category ?? 'all');
      if (category !== 'all' && !CATEGORIES[category]) throw new HttpError(400, 'Catégorie inconnue');
      const userId = req.query.user ? String(req.query.user) : null;
      if (userId && !isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      res.json(await historyJson(guild, { category, userId, page }));
    }),
  );

  // ── Réglages ──────────────────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const id = textChannelId(guild, req.body?.logChannelId);
      const webUser = webUserOf(req);
      await moderation.setLogChannel(guild.id, id);
      await logs.action({ guildId: guild.id, action: 'modlogs', executorId: webUser.id, reason: id ? `<#${id}>` : 'aucun', viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );

  // Contestations : activées uniquement avec un type de ticket du serveur.
  router.post(
    '/api/appeal',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const enabled = req.body?.enabled === true;
      const typeId = req.body?.ticketTypeId ? String(req.body.ticketTypeId) : null;
      if (typeId && !(await appealTicketTypes(guild)).some((type) => type.id === typeId)) throw new HttpError(400, 'Type de ticket introuvable sur ce serveur.');
      if (enabled && !typeId) throw new HttpError(400, 'Choisis le type de ticket qui recevra les contestations.');
      await moderation.updateSettings(guild.id, { appeal_enabled: enabled ? 1 : 0, appeal_ticket_type_id: typeId });
      res.json(await stateJson(guild));
    }),
  );

  // ── Sanctions automatiques au cumul d'avertissements ─────────────────────

  router.post(
    '/api/warn-rules',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const warnCount = Number(req.body?.warnCount);
      if (!Number.isInteger(warnCount) || warnCount < 1 || warnCount > 50) throw new HttpError(400, 'Nombre d’avertissements invalide (1 à 50).');
      const action = String(req.body?.action ?? '');
      if (!WARN_RULE_ACTIONS.includes(action)) throw new HttpError(400, 'Sanction inconnue.');
      let durationMinutes = null;
      if (action === 'tempmute' || action === 'tempban') {
        const seconds = durationOf(req.body?.duration, action === 'tempmute' ? 28 * 86_400 : MAX_TEMPBAN_S);
        if (!seconds) throw new HttpError(400, 'Indique une durée pour cette sanction.');
        durationMinutes = Math.max(1, Math.round(seconds / 60));
      }
      await moderation.saveWarnRule(guild.id, { warnCount, action, durationMinutes });
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/warn-rules/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      await moderation.deleteWarnRule(guild.id, Number(req.params.id) || 0);
      res.json(await stateJson(guild));
    }),
  );

  // ── Sanctions publiées : modification et annulation ──────────────────────

  async function actionOf(guild, rawId) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identifiant invalide');
    const row = await moderation.get(guild.id, id);
    if (!row) throw new HttpError(404, 'Sanction introuvable');
    return row;
  }

  router.post(
    '/api/actions/:id/edit',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const row = await actionOf(guild, req.params.id);
      const webUser = webUserOf(req);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 512) : undefined;
      const durationS = req.body?.duration ? durationOf(req.body.duration, MAX_TEMPBAN_S) : undefined;
      const result = await editSanction(ctx.services, guild, row, { reason, durationS }, webUser.id);
      if (result.error) throw new HttpError(409, result.error);
      await logs.send(guild.id, ui.card({ description: `✏️ <@${webUser.id}> a modifié la sanction \`#${row.id}\` — 🌐 depuis le panel web\n${result.changes.join('\n')}`, timestamp: true }));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/api/actions/:id/revoke',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const row = await actionOf(guild, req.params.id);
      const webUser = webUserOf(req);
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : null;
      const result = await revokeSanction(ctx.services, guild, row, webUser.id, reason);
      if (result.error) throw new HttpError(409, result.error);
      if (result.inverse === 'unban' || result.inverse === 'untempban') patchBanCache(guild.id, String(row.target_id), null);
      await logs.action({
        guildId: guild.id,
        action: result.inverse,
        targetId: row.target_id,
        executorId: webUser.id,
        reason: `Annulation de la sanction #${row.id}${reason ? ` : ${reason}` : ''}`,
        viaWeb: true,
      });
      res.json({ ok: true });
    }),
  );

  // ── Notes internes ───────────────────────────────────────────────────────

  router.get(
    '/api/notes',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const userId = String(req.query.user ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      res.json(await notesJson(guild, userId));
    }),
  );

  router.post(
    '/api/notes',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const content = String(req.body?.content ?? '').trim();
      if (!content) throw new HttpError(400, 'La note est vide.');
      const webUser = webUserOf(req);
      const id = await moderation.addNote(guild.id, userId, webUser.id, content.slice(0, 2000));
      await logs.send(guild.id, ui.card({ description: `🗒️ <@${webUser.id}> a ajouté la note n°${id} sur <@${userId}> — 🌐 depuis le panel web`, timestamp: true }));
      res.json(await notesJson(guild, userId));
    }),
  );

  router.delete(
    '/api/notes/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const note = await moderation.getNote(guild.id, Number(req.params.id) || 0);
      if (!note) throw new HttpError(404, 'Note introuvable');
      const webUser = webUserOf(req);
      await moderation.deleteNote(guild.id, note.id);
      await logs.send(guild.id, ui.card({ description: `🗒️ <@${webUser.id}> a supprimé la note n°${note.id} sur <@${note.user_id}> — 🌐 depuis le panel web`, timestamp: true }));
      res.json(await notesJson(guild, String(note.user_id)));
    }),
  );

  // ── Automod ──────────────────────────────────────────────────────────────

  router.get(
    '/api/automod',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      res.json(await automodJson(guild));
    }),
  );

  router.post(
    '/api/automod/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const body = req.body ?? {};
      const action = String(body.action ?? 'delete');
      if (!['delete', 'warn', 'mute'].includes(action)) throw new HttpError(400, 'Action inconnue.');
      const threshold = Number(body.threshold);
      if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100) throw new HttpError(400, 'Seuil de similarité invalide (50 à 100 %).');
      const muteMinutes = Number(body.muteMinutes);
      if (!Number.isInteger(muteMinutes) || muteMinutes < 1 || muteMinutes > 40_320) throw new HttpError(400, 'Durée d’exclusion invalide (1 à 40 320 minutes).');
      const ids = (list, valid) => (Array.isArray(list) ? [...new Set(list.map(String))].filter(valid).slice(0, 100) : []);
      await moderation.updateSettings(guild.id, {
        automod_enabled: body.enabled === true ? 1 : 0,
        automod_action: action,
        automod_threshold: threshold,
        automod_mute_minutes: muteMinutes,
        automod_exempt_role_ids: ids(body.exemptRoleIds, (id) => guild.roles.cache.has(id)),
        automod_exempt_channel_ids: ids(body.exemptChannelIds, (id) => guild.channels.cache.has(id)),
      });
      res.json(await automodJson(guild));
    }),
  );

  // Ajout groupé : un mot par ligne ou séparés par des virgules.
  router.post(
    '/api/automod/words',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const words = [
        ...new Set(
          String(req.body?.words ?? '')
            .split(/[\n,;]+/)
            .map((word) => word.trim().toLowerCase().slice(0, 100))
            .filter((word) => normalizeWord(word).length >= 2),
        ),
      ].slice(0, 500);
      if (!words.length) throw new HttpError(400, 'Aucun mot valide (2 lettres minimum).');
      await moderation.addAutomodWords(guild.id, words, webUserOf(req).id);
      res.json(await automodJson(guild));
    }),
  );

  router.delete(
    '/api/automod/words/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      await moderation.deleteAutomodWord(guild.id, Number(req.params.id) || 0);
      res.json(await automodJson(guild));
    }),
  );

  // Faux positif : le mot détecté est ajouté aux mots autorisés (plus jamais sanctionné) ; annulable.
  router.post(
    '/api/automod/hits/:id/false-positive',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const hit = await moderation.getAutomodHit(guild.id, Number(req.params.id) || 0);
      if (!hit) throw new HttpError(404, 'Détection introuvable');
      const value = req.body?.value !== false;
      const webUser = webUserOf(req);
      await moderation.markFalsePositive(guild.id, hit.id, webUser.id, value);
      if (value) await moderation.allowToken(guild.id, hit.token, webUser.id);
      else await moderation.disallowToken(guild.id, hit.token);
      res.json(await automodJson(guild));
    }),
  );

  router.delete(
    '/api/automod/allow/:token',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      await moderation.disallowToken(guild.id, String(req.params.token).slice(0, 100));
      res.json(await automodJson(guild));
    }),
  );

  // Essai sans effet : ce que l'automod ferait d'un texte avec les réglages actuels.
  router.post(
    '/api/automod/test',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view');
      const settings = await moderation.settings(guild.id);
      const hit = scan(String(req.body?.content ?? '').slice(0, 2000), await moderation.automodLists(guild.id), settings.automod.threshold);
      res.json({ hit });
    }),
  );

  // ── Bannis ────────────────────────────────────────────────────────────────

  router.post(
    '/api/bans',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : null;
      const days = Number(req.body?.deleteMessageDays ?? 0);
      if (!Number.isInteger(days) || days < 0 || days > 7) throw new HttpError(400, 'Jours de messages invalides (0 à 7)');
      // Durée facultative : ban temporaire, levé automatiquement à l'échéance.
      const seconds = durationOf(req.body?.duration, MAX_TEMPBAN_S);
      const webUser = webUserOf(req);

      const safety = await safetyOf(guild, webUser.id, userId);
      if (!safety.allowed) throw new HttpError(409, safety.reason);
      const already = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
      if (already) throw new HttpError(409, 'Ce membre est déjà banni.');

      const target = await resolveUser(userId);
      const action = seconds ? 'tempban' : 'ban';
      const shownReason = seconds ? `${reason ?? '—'} (${formatDuration(seconds)})` : reason;
      if (target && req.body?.dm === true) await notifyTarget(target, guild.name, action, shownReason);
      let id;
      if (seconds) {
        ({ id } = await applyTempBan(ctx.services, guild, userId, { seconds, reason, executorId: webUser.id, deleteDays: days }));
      } else {
        await guild.members.ban(userId, { reason: reason ?? undefined, deleteMessageSeconds: days * 86400 });
        id = await moderation.record({ guildId: guild.id, action: 'ban', targetId: userId, executorId: webUser.id, reason });
      }
      patchBanCache(guild.id, userId, { user: target ?? { id: userId }, reason });
      await logs.action({ guildId: guild.id, action, targetId: userId, executorId: webUser.id, reason: shownReason, viaWeb: true, id });
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/bans/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const reason = req.query.reason ? String(req.query.reason).slice(0, 512) : null;
      const ban = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
      if (!ban) {
        patchBanCache(guild.id, userId, null);
        throw new HttpError(404, 'Ce membre n’est pas banni.');
      }
      if (await moderation.blacklistEntry(userId)) throw new HttpError(409, 'Ce membre est blacklisté : utilise /unblacklist pour lever le bannissement.');
      const webUser = webUserOf(req);

      await guild.members.unban(userId, reason ?? undefined);
      patchBanCache(guild.id, userId, null);
      await moderation.resolveBans(guild.id, userId, webUser.id);
      await moderation.record({ guildId: guild.id, action: 'unban', targetId: userId, executorId: webUser.id, reason });
      await logs.action({ guildId: guild.id, action: 'unban', targetId: userId, executorId: webUser.id, reason, viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );

  // ── Avertissements ───────────────────────────────────────────────────────

  router.post(
    '/api/warns',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : '';
      if (!reason) throw new HttpError(400, 'La raison est obligatoire pour un avertissement.');
      const webUser = webUserOf(req);

      const safety = await safetyOf(guild, webUser.id, userId);
      if (!safety.allowed) throw new HttpError(409, safety.reason);

      const target = await resolveUser(userId);
      if (target && req.body?.dm === true) await notifyTarget(target, guild.name, 'warn', reason);
      const id = await moderation.record({ guildId: guild.id, action: 'warn', targetId: userId, executorId: webUser.id, reason });
      await logs.action({ guildId: guild.id, action: 'warn', targetId: userId, executorId: webUser.id, reason, viaWeb: true, id });
      await applyWarnRules(ctx.services, guild, userId, ctx.client);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/warns/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identifiant invalide');
      const row = await moderation.get(guild.id, id);
      if (!row || row.action !== 'warn' || !row.active) throw new HttpError(404, 'Avertissement introuvable ou déjà retiré');
      const webUser = webUserOf(req);

      await moderation.resolve(id, webUser.id);
      await moderation.record({ guildId: guild.id, action: 'removewarn', targetId: row.target_id, executorId: webUser.id, reason: `Avertissement #${id} retiré`, metadata: { warnId: id } });
      await logs.action({ guildId: guild.id, action: 'removewarn', targetId: row.target_id, executorId: webUser.id, reason: `Avertissement #${id} retiré`, viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );

  // ── Salons verrouillés ───────────────────────────────────────────────────

  router.post(
    '/api/locks/:channelId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = textChannelOf(guild, req.params.channelId);
      if (isChannelLocked(channel)) throw new HttpError(409, 'Ce salon est déjà verrouillé.');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : null;
      const seconds = durationOf(req.body?.duration, MAX_LOCK_S);
      const webUser = webUserOf(req);

      await lockChannel(moderation, channel, webUser.id, reason);
      const unlockAt = seconds ? new Date(Date.now() + seconds * 1000) : null;
      if (unlockAt) await moderation.setUnlockAt(guild.id, channel.id, unlockAt);
      await moderation.record({ guildId: guild.id, action: 'lock', channelId: channel.id, executorId: webUser.id, reason, durationS: seconds, expiresAt: unlockAt });
      await logs.action({ guildId: guild.id, action: 'lock', channelId: channel.id, executorId: webUser.id, reason: seconds ? `${reason ?? '—'} (${formatDuration(seconds)})` : reason, viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/locks/:channelId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = textChannelOf(guild, req.params.channelId);
      if (!isChannelLocked(channel)) throw new HttpError(409, 'Ce salon n’est pas verrouillé.');
      const reason = req.query.reason ? String(req.query.reason).slice(0, 512) : null;
      const webUser = webUserOf(req);

      await unlockChannel(moderation, channel, webUser.id, reason);
      await moderation.record({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: webUser.id, reason });
      await logs.action({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: webUser.id, reason, viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );

  // ── Shadow-bans (même logique que /shadow-ban et /unshadow-ban : état des salons mémorisé puis restauré) ──

  router.post(
    '/api/shadowbans',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : null;
      const webUser = webUserOf(req);

      const safety = await safetyOf(guild, webUser.id, userId);
      if (!safety.allowed) throw new HttpError(409, safety.reason);
      const existing = await moderation.shadowban(guild.id, userId);
      if (existing) throw new HttpError(409, 'Ce membre est déjà shadow-ban.');
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) throw new HttpError(404, 'Ce membre n’est pas sur le serveur.');

      const auditReason = reason ?? 'Shadow-ban (panel web)';
      const category = await ensurePrisonCategory(moderation, guild);
      const prisonChannel = await guild.channels.create({
        name: `prison-de-${slugifyChannelName(member.user.username)}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
        reason: auditReason,
      });

      const { previousState, denied } = await denyChannelAccess(guild, userId, { prisonChannelId: prisonChannel.id, categoryId: category.id, reason: auditReason });
      await moderation.addShadowban(guild.id, userId, prisonChannel.id, previousState, webUser.id, reason);
      if (req.body?.dm === true) await notifyTarget(member.user, guild.name, 'shadowban', reason);
      const id = await moderation.record({
        guildId: guild.id,
        action: 'shadowban',
        targetId: userId,
        channelId: prisonChannel.id,
        executorId: webUser.id,
        reason,
        metadata: { deniedChannels: denied },
      });
      await logs.action({ guildId: guild.id, action: 'shadowban', targetId: userId, channelId: prisonChannel.id, executorId: webUser.id, reason, viaWeb: true, id });
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/shadowbans/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const existing = await moderation.shadowban(guild.id, userId);
      if (!existing) throw new HttpError(404, 'Ce membre n’est pas shadow-ban.');
      const reason = req.query.reason ? String(req.query.reason).slice(0, 512) : null;
      const webUser = webUserOf(req);

      const auditReason = reason ?? 'Fin du shadow-ban (panel web)';
      const restored = await restoreChannelAccess(guild, userId, existing.previous_state, { prisonChannelId: existing.prison_channel_id, reason: auditReason });
      const prisonChannel = guild.channels.cache.get(existing.prison_channel_id);
      if (prisonChannel) await prisonChannel.delete(auditReason).catch(() => {});

      await moderation.removeShadowban(guild.id, userId);
      await moderation.record({ guildId: guild.id, action: 'unshadowban', targetId: userId, executorId: webUser.id, reason });
      await logs.action({
        guildId: guild.id,
        action: 'unshadowban',
        targetId: userId,
        executorId: webUser.id,
        reason,
        viaWeb: true,
        extra: { stats: [['Salons restaurés', String(restored)]] },
      });
      res.json(await stateJson(guild));
    }),
  );

  // ── Mutes vocaux temporaires ─────────────────────────────────────────────

  router.delete(
    '/api/tempvocmutes/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const row = await moderation.activeTempVocMute(guild.id, userId);
      if (!row) throw new HttpError(404, 'Aucun mute vocal temporaire actif pour ce membre.');
      const reason = req.query.reason ? String(req.query.reason).slice(0, 512) : null;
      const webUser = webUserOf(req);

      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (member?.voice?.serverMute) await member.voice.setMute(false, reason ?? 'Levée manuelle (panel web)').catch(() => {});
      await moderation.resolve(row.id, webUser.id);
      await moderation.record({ guildId: guild.id, action: 'untempvocmute', targetId: userId, executorId: webUser.id, reason });
      await logs.action({ guildId: guild.id, action: 'untempvocmute', targetId: userId, executorId: webUser.id, reason, viaWeb: true });
      res.json(await stateJson(guild));
    }),
  );
};
