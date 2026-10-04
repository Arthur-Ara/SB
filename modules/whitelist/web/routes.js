'use strict';

const path = require('node:path');
const express = require('express');
const { ChannelType } = require('discord.js');
const { HttpError, wrap, isSnowflake, avatarUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess } = require('../../permissions/lib/webAccess');
const { parseDuration, formatDuration } = require('../../../src/core/duration');
const { isTime, isTimezone } = require('../../../src/core/schedule');

const PUBLIC_DIR = path.join(__dirname, 'public');
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const MAX_INVITE_S = 30 * 86_400;

function setsEqual(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** Résume les changements entre l'état enregistré et le brouillon envoyé par le panel, pour un seul log groupé. */
function describeChannelChanges(before, after) {
  const parts = [];
  if (before.enabled !== after.enabled) parts.push(`whitelist ${after.enabled ? 'activée' : 'désactivée'}`);
  if (before.slotLimit !== after.slotLimit) parts.push(`limite : ${before.slotLimit ?? 'aucune'} → ${after.slotLimit ?? 'aucune'}`);
  const addedUsers = [...after.users].filter((id) => !before.users.has(id));
  const removedUsers = [...before.users].filter((id) => !after.users.has(id));
  if (addedUsers.length) parts.push(`membres ajoutés : ${addedUsers.map((id) => `<@${id}>`).join(', ')}`);
  if (removedUsers.length) parts.push(`membres retirés : ${removedUsers.map((id) => `<@${id}>`).join(', ')}`);
  const addedRoles = [...after.roles].filter((id) => !before.roles.has(id));
  const removedRoles = [...before.roles].filter((id) => !after.roles.has(id));
  if (addedRoles.length) parts.push(`rôles ajoutés : ${addedRoles.map((id) => `<@&${id}>`).join(', ')}`);
  if (removedRoles.length) parts.push(`rôles retirés : ${removedRoles.map((id) => `<@&${id}>`).join(', ')}`);
  return parts;
}

/**
 * Monte l'interface web du module sous /m/whitelist/. Accès : membres du serveur ayant le droit
 * `whitelist` (view / manage) du panel (voir /permission grant-panel).
 */
module.exports = function registerWeb(router, ctx) {
  const { whitelist, logs, enforcer } = ctx.services;
  const access = guildAccess(ctx, { module: 'whitelist', category: 'whitelist', label: 'Whitelist Vocal' });

  function webUserOf(req) {
    const user = req.session.user;
    return { id: user.id, name: user.globalName || user.username };
  }

  function person(guild, userId) {
    if (!userId) return null;
    const member = guild.members.cache.get(userId);
    const user = member?.user ?? ctx.client.users.cache.get(userId);
    return {
      id: userId,
      name: member?.nickname || user?.globalName || user?.username || userId,
      username: user?.username ?? null,
      avatar: avatarUrl(userId, user?.avatar ?? null),
      inGuild: Boolean(member),
    };
  }

  async function stateJson(guild) {
    const state = await whitelist.state(guild.id);

    const channels = [...guild.channels.cache.values()]
      .filter((c) => VOICE_TYPES.has(c.type))
      .sort((a, b) => a.position - b.position)
      .map((channel) => {
        const config = whitelist.channelConfig(state, channel.id);
        return {
          id: channel.id,
          name: channel.name,
          memberCount: channel.members.size,
          enabled: config.enabled,
          slotLimit: config.slotLimit,
          users: [...config.users].map((userId) => person(guild, userId)),
          roleIds: [...config.roles],
          temp: [...config.temp.entries()].map(([userId, expiresAt]) => ({ person: person(guild, userId), expiresAt })),
          admins: [...config.admins].map((userId) => person(guild, userId)),
          schedule: {
            enabled: config.schedule.scheduleEnabled,
            start: config.schedule.scheduleStart,
            end: config.schedule.scheduleEnd,
            timezone: config.schedule.scheduleTimezone,
            activeNow: whitelist.isActiveNow(config),
          },
        };
      });

    const roles = [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, color: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : null }));

    const textChannels = [...guild.channels.cache.values()]
      .filter((c) => c.isTextBased() && !c.isThread() && !c.isVoiceBased() && c.viewable)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name }));

    const admins = await whitelist.listAdmins(guild.id);

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      settings: { logChannelId: state.settings.logChannelId },
      channels,
      roles,
      textChannels,
      admins: admins.map((row) => ({
        userId: row.userId,
        person: person(guild, row.userId),
        addedBy: row.addedBy,
        addedByPerson: row.addedBy ? person(guild, row.addedBy) : null,
        addedAt: row.addedAt,
      })),
    };
  }

  function channelOf(guild, channelId) {
    if (!isSnowflake(channelId)) throw new HttpError(400, 'Salon invalide');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !VOICE_TYPES.has(channel.type)) throw new HttpError(404, 'Salon vocal introuvable');
    return channel;
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'whitelist.html')));

  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      res.json(await access.guilds(req));
    }),
  );

  router.get(
    '/api/state',
    wrap(async (req, res) => {
      res.json(await stateJson(await access.guild(req, 'view')));
    }),
  );

  // ── Configuration d'un salon ──────────────────────────────────────────────
  // Le panel envoie l'état complet du brouillon en un seul appel (au clic sur « Enregistrer »,
  // jamais à chaque coche) : seuls les champs qui ont changé sont écrits, et un seul log groupé
  // résume tout, à l'image de l'embed interactif Discord (/whitelist channel).

  router.post(
    '/api/channels/:channelId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const webUser = webUserOf(req);

      const state = await whitelist.state(guild.id);
      const before = whitelist.channelConfig(state, channel.id);

      const enabled = Boolean(req.body.enabled);
      let slotLimit = null;
      if (req.body.slotLimit !== null && req.body.slotLimit !== undefined && req.body.slotLimit !== '') {
        const n = Number(req.body.slotLimit);
        if (!Number.isInteger(n) || n < 0 || n > 500) throw new HttpError(400, 'Limite invalide (0 à 500, ou vide)');
        slotLimit = n;
      }
      const userIds = Array.isArray(req.body.userIds) ? [...new Set(req.body.userIds.map(String).filter(isSnowflake))] : [];
      const roleIds = Array.isArray(req.body.roleIds) ? [...new Set(req.body.roleIds.map(String).filter(isSnowflake))] : [];
      const after = { enabled, slotLimit, users: new Set(userIds), roles: new Set(roleIds) };

      const changes = describeChannelChanges(before, after);
      if (changes.length) {
        if (before.enabled !== enabled) await whitelist.setEnabled(guild.id, channel.id, enabled, webUser.id);
        if (before.slotLimit !== slotLimit) await whitelist.setSlotLimit(guild.id, channel.id, slotLimit, webUser.id);
        if (!setsEqual(before.users, after.users)) await whitelist.replaceUsers(guild.id, channel.id, userIds, webUser.id);
        if (!setsEqual(before.roles, after.roles)) await whitelist.replaceRoles(guild.id, channel.id, roleIds, webUser.id);
        await logs.webAction(guild.id, webUser, `<#${channel.id}> — ${changes.join(' · ')}.`);
      }
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/channels/:channelId/reset',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      await whitelist.resetChannel(guild.id, channel.id);
      const webUser = webUserOf(req);
      await logs.webAction(guild.id, webUser, `configuration de <#${channel.id}> réinitialisée.`);
      res.json(await stateJson(guild));
    }),
  );

  // ── Plage horaire, accès temporaires et admins d'un salon ────────────────

  router.post(
    '/api/channels/:channelId/schedule',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const webUser = webUserOf(req);
      const enabled = req.body?.enabled === true;
      const start = String(req.body?.start ?? '');
      const end = String(req.body?.end ?? '');
      const timezone = String(req.body?.timezone || 'Europe/Paris');
      if (enabled && (!isTime(start) || !isTime(end))) throw new HttpError(400, 'Heures invalides (format HH:MM).');
      if (enabled && !isTimezone(timezone)) throw new HttpError(400, 'Fuseau horaire inconnu (ex. Europe/Paris).');
      await whitelist.setSchedule(guild.id, channel.id, enabled ? { enabled, start, end, timezone } : { enabled: false }, webUser.id);
      await logs.webAction(guild.id, webUser, enabled ? `restrictions de <#${channel.id}> actives de ${start} à ${end} (${timezone}).` : `plage horaire de <#${channel.id}> retirée.`);
      await enforcer.enforceChannel(guild, channel.id);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/channels/:channelId/invites',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres).');
      const seconds = parseDuration(req.body?.duration);
      if (!seconds || seconds > MAX_INVITE_S) throw new HttpError(400, 'Durée invalide : par exemple 30m, 2h ou 3j (30 jours maximum).');
      const expiresAt = new Date(Date.now() + seconds * 1000);
      const webUser = webUserOf(req);
      const result = await whitelist.inviteUser(guild.id, channel.id, userId, expiresAt, webUser.id);
      if (result === 'permanent') throw new HttpError(409, 'Ce membre est déjà whitelisté en permanence sur ce salon.');
      await logs.webAction(guild.id, webUser, `accès temporaire de <@${userId}> à <#${channel.id}> pendant ${formatDuration(seconds)}.`);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/channels/:channelId/invites/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      if (!(await whitelist.uninviteUser(guild.id, channel.id, userId))) throw new HttpError(404, 'Aucun accès temporaire pour ce membre.');
      const webUser = webUserOf(req);
      await logs.webAction(guild.id, webUser, `accès temporaire de <@${userId}> à <#${channel.id}> retiré.`);
      await enforcer.enforceChannel(guild, channel.id);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/channels/:channelId/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const webUser = webUserOf(req);
      await whitelist.addChannelAdmin(guild.id, channel.id, userId, webUser.id);
      await logs.webAction(guild.id, webUser, `<@${userId}> est maintenant admin de <#${channel.id}>.`);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/channels/:channelId/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const channel = channelOf(guild, req.params.channelId);
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const webUser = webUserOf(req);
      await whitelist.removeChannelAdmin(guild.id, channel.id, userId);
      await logs.webAction(guild.id, webUser, `<@${userId}> n’est plus admin de <#${channel.id}>.`);
      res.json(await stateJson(guild));
    }),
  );

  // ── Réglages du serveur ──────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const id = textChannelId(guild, req.body?.logChannelId);
      const webUser = webUserOf(req);
      await whitelist.setLogChannel(guild.id, id, webUser.id);
      await logs.webAction(guild.id, webUser, `salon de journal : ${id ? `<#${id}>` : 'aucun'}.`);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      const webUser = webUserOf(req);
      await whitelist.addAdmin(guild.id, userId, webUser.id);
      await logs.webAction(guild.id, webUser, `<@${userId}> est maintenant admin du module.`);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      await whitelist.removeAdmin(guild.id, userId);
      const webUser = webUserOf(req);
      await logs.webAction(guild.id, webUser, `<@${userId}> n’est plus admin du module.`);
      res.json(await stateJson(guild));
    }),
  );
};
