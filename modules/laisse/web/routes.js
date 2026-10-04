'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, wrap, isSnowflake, avatarUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess } = require('../../permissions/lib/webAccess');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FLAGS = new Set(['allowed', 'immune', 'godmode', 'admin']);

/**
 * Interface web du module Laisse (/m/laisse/) : qui est en laisse, réglages, listes
 * (autorisés, immunisés, god mode, admins). Toute modification génère un message dans
 * le salon de journal du module (comme depuis Discord), attribué à l'auteur connecté au
 * dashboard. Accès : membres du serveur ayant le droit `laisse` (view / manage) du panel.
 */
module.exports = function registerWeb(router, ctx) {
  const { leash, logs, mover } = ctx.services;
  const access = guildAccess(ctx, { module: 'laisse', category: 'laisse', label: 'Laisse' });

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

  function voiceOf(guild, userId) {
    const channelId = guild.voiceStates.cache.get(userId)?.channelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    return channel ? { id: channel.id, name: channel.name, members: channel.members.size } : null;
  }

  async function stateJson(guild) {
    const state = await leash.state(guild.id);

    const links = [...state.links.values()].map((link) => ({
      leashedId: link.leashedId,
      leasherId: link.leasherId,
      addedBy: link.addedBy,
      createdAt: link.createdAt,
      leashed: person(guild, link.leashedId),
      leasher: person(guild, link.leasherId),
      addedByPerson: link.addedBy && link.addedBy !== link.leasherId ? person(guild, link.addedBy) : null,
      leashedVoice: voiceOf(guild, link.leashedId),
      leasherVoice: voiceOf(guild, link.leasherId),
      immune: leash.member(state, link.leashedId).immune,
    }));

    const flags = {};
    for (const flag of FLAGS) {
      const rows = await leash.withFlag(guild.id, flag);
      flags[flag] = rows.map((row) => ({
        userId: row.userId,
        person: person(guild, row.userId),
        by: row.by,
        byPerson: row.by ? person(guild, row.by) : null,
        at: row.at,
      }));
    }

    const channels = [...guild.channels.cache.values()]
      .filter((c) => c.isTextBased() && !c.isThread() && !c.isVoiceBased() && c.viewable)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name }));

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount },
      settings: {
        globalLimit: state.settings.globalLimit,
        leashLeashers: state.settings.leashLeashers,
        logChannelId: state.settings.logChannelId,
      },
      channels,
      links,
      flags,
    };
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // maxAge: 0 (revalidation systématique) — évite de servir un .js périmé après un redéploiement.
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'leash.html')));

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

  // ── Laisses (liens maître ↔ membre) ────────────────────────────────────────

  router.post(
    '/api/links',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const leasherId = String(req.body.leasherId ?? '');
      const leashedId = String(req.body.leashedId ?? '');
      if (!isSnowflake(leasherId) || !isSnowflake(leashedId)) throw new HttpError(400, 'IDs Discord invalides (17 à 20 chiffres)');

      // Les deux doivent être membres de CE serveur (une laisse ne concerne que ses salons vocaux).
      const fetchMember = async (id) => guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      const [targetMember, leasherMember] = await Promise.all([fetchMember(leashedId), fetchMember(leasherId)]);
      if (!targetMember) throw new HttpError(404, 'Membre introuvable sur ce serveur');
      if (!leasherMember || leasherMember.user.bot) throw new HttpError(404, 'Maître introuvable sur ce serveur ou invalide');
      const target = targetMember.user;

      const state = await leash.state(guild.id);
      const error = leash.checkAdd(state, { leasherId, target, bypassLimit: true });
      if (error) throw new HttpError(409, error.replace(/<@(\d+)>/g, '$1').replace(/\*\*/g, ''));

      const webUser = webUserOf(req);
      await leash.addLink(guild.id, leashedId, leasherId, webUser.id);
      await logs.webAction(guild.id, webUser, `<@${leashedId}> ajouté à la laisse de <@${leasherId}>.`);
      await mover.syncPair(guild, leashedId, leasherId);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/links/:leashedId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { leashedId } = req.params;
      if (!isSnowflake(leashedId)) throw new HttpError(400, 'ID invalide');
      const link = await leash.removeLink(guild.id, leashedId);
      if (!link) throw new HttpError(404, 'Ce membre n’est dans aucune laisse');
      const webUser = webUserOf(req);
      await logs.webAction(guild.id, webUser, `<@${leashedId}> retiré de la laisse de <@${link.leasherId}>.`);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/leashers/:leasherId/clear',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { leasherId } = req.params;
      if (!isSnowflake(leasherId)) throw new HttpError(400, 'ID invalide');
      const released = await leash.clearList(guild.id, leasherId);
      if (released.length) {
        const webUser = webUserOf(req);
        await logs.webAction(guild.id, webUser, `laisse de <@${leasherId}> vidée (${released.map((id) => `<@${id}>`).join(', ')}).`);
      }
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/clear-all',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const count = await leash.clearAll(guild.id);
      const webUser = webUserOf(req);
      await logs.webAction(guild.id, webUser, `toutes les laisses ont été vidées (${count} membre(s) libéré(s)).`);
      res.json(await stateJson(guild));
    }),
  );

  // ── Statuts individuels (autorisé, immunisé, god mode, admin) ──────────────

  router.post(
    '/api/members/:userId/:flag',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { userId, flag } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      if (!FLAGS.has(flag)) throw new HttpError(400, 'Statut inconnu');
      const value = Boolean(req.body.value);
      const webUser = webUserOf(req);
      const now = new Date();

      if (flag === 'admin') {
        await leash.updateMember(guild.id, userId, { admin: value, adminBy: webUser.id, adminAt: now });
        await logs.webAction(guild.id, webUser, `<@${userId}> ${value ? 'est maintenant admin du module laisse' : 'n’est plus admin du module laisse'}.`);
      } else if (flag === 'allowed') {
        await leash.updateMember(guild.id, userId, { allowed: value, allowedBy: webUser.id, allowedAt: now });
        let note = '';
        if (!value) {
          const released = await leash.clearList(guild.id, userId);
          if (released.length) note = ` Sa laisse a été vidée (${released.map((id) => `<@${id}>`).join(', ')}).`;
        }
        await logs.webAction(guild.id, webUser, `<@${userId}> ${value ? 'est autorisé' : 'n’est plus autorisé'} à utiliser le mode laisse.${note}`);
      } else if (flag === 'immune') {
        await leash.updateMember(guild.id, userId, { immune: value, immuneBy: webUser.id, immuneAt: now });
        await logs.webAction(guild.id, webUser, `immunité de <@${userId}> : ${value ? 'activée' : 'désactivée'}.`);
        if (!value) {
          const state = await leash.state(guild.id);
          const link = state.links.get(userId);
          if (link) await mover.syncPair(guild, userId, link.leasherId);
        }
      } else if (flag === 'godmode') {
        await leash.updateMember(guild.id, userId, { godmode: value, godmodeBy: webUser.id, godmodeAt: now });
        let note = '';
        if (value) {
          const link = await leash.removeLink(guild.id, userId);
          if (link) note = ` Retiré de la laisse de <@${link.leasherId}>.`;
        }
        await logs.webAction(guild.id, webUser, `god mode de <@${userId}> : ${value ? 'activé' : 'désactivé'}.${note}`);
      }
      res.json(await stateJson(guild));
    }),
  );

  // ── Réglages du serveur ──────────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const patch = {};

      if (req.body.globalLimit !== undefined) {
        const n = Number(req.body.globalLimit);
        if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, 'Limite invalide (0 à 100)');
        patch.globalLimit = n;
      }
      if (req.body.leashLeashers !== undefined) patch.leashLeashers = Boolean(req.body.leashLeashers);
      if (req.body.logChannelId !== undefined) patch.logChannelId = textChannelId(guild, req.body.logChannelId);

      const { previous, next } = await leash.updateSettings(guild.id, patch);
      const webUser = webUserOf(req);
      const changes = [];
      if (patch.globalLimit !== undefined && patch.globalLimit !== previous.globalLimit) {
        changes.push(`limite par défaut : ${previous.globalLimit} → ${next.globalLimit}`);
      }
      if (patch.leashLeashers !== undefined && patch.leashLeashers !== previous.leashLeashers) {
        changes.push(`leash-leasher : ${next.leashLeashers ? 'activé' : 'désactivé'}`);
      }
      if (patch.logChannelId !== undefined && patch.logChannelId !== previous.logChannelId) {
        changes.push(`salon de journal : ${next.logChannelId ? `<#${next.logChannelId}>` : 'aucun'}`);
      }
      if (patch.leashLeashers === false) {
        const removed = await leash.removeLeashers(guild.id);
        if (removed.length) changes.push(`retiré(s) des laisses : ${removed.map((l) => `<@${l.leashedId}>`).join(', ')}`);
      }
      if (changes.length) await logs.webAction(guild.id, webUser, `réglages modifiés — ${changes.join(' · ')}.`);
      res.json(await stateJson(guild));
    }),
  );
};
