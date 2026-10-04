'use strict';

const path = require('node:path');
const express = require('express');
const { ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { HttpError, wrap, isSnowflake, hexColor, imageUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess } = require('../../permissions/lib/webAccess');
const { publishPanel, refreshPanelMessage } = require('../lib/panel');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/** Interface web du module Support automatique (/m/support/) : panels, arbre de catégories/réponses. */
module.exports = function registerWeb(router, ctx) {
  const { support, logs } = ctx.services;
  const access = guildAccess(ctx, { module: 'support', category: 'support', label: 'Support automatique' });

  /** Une ligne de journal par modification « finale » faite depuis le panel. */
  function logWeb(req, guild, text) {
    const user = req.session.user;
    return logs.send(guild.id, ui.card({ description: `🌐 **${user.globalName || user.username}** (panel web) — ${text}`, timestamp: true }));
  }

  async function panelOf(guild, panelId) {
    const panel = await support.getPanel(panelId);
    if (!panel || panel.guild_id !== guild.id) throw new HttpError(404, 'Panel introuvable');
    return panel;
  }

  async function nodeOf(guild, nodeId) {
    const node = await support.getNode(nodeId);
    if (!node) throw new HttpError(404, 'Élément introuvable');
    const panel = await panelOf(guild, node.panel_id);
    return { node, panel };
  }

  /** Types de tickets de CE serveur (null si le module Tickets est indisponible ou désactivé ici). */
  async function ticketTypesOf(guild) {
    const ticketsServices = ctx.modules.services('tickets');
    if (!ticketsServices || !ctx.modules.isEnabledFor('tickets', guild.id)) return null;
    return ticketsServices.tickets.listAllTypes(guild.id);
  }

  /** Champs d'embed communs aux panels et aux nœuds, validés (couleur #RRGGBB, images http(s)). */
  function embedPatch(body, patch) {
    if ('embedTitle' in body) patch.embed_title = body.embedTitle ? String(body.embedTitle).slice(0, 256) : null;
    if ('embedDescription' in body) patch.embed_description = body.embedDescription ? String(body.embedDescription).slice(0, 4096) : null;
    if ('embedColor' in body) patch.embed_color = hexColor(body.embedColor);
    if ('embedFooter' in body) patch.embed_footer = body.embedFooter ? String(body.embedFooter).slice(0, 2048) : null;
    if ('embedImage' in body) patch.embed_image = imageUrl(body.embedImage, 'Image');
    if ('embedThumbnail' in body) patch.embed_thumbnail = imageUrl(body.embedThumbnail, 'Miniature');
    return patch;
  }

  function panelJson(panel, nodes, stats) {
    return {
      id: panel.id,
      channelId: panel.channel_id,
      messageId: panel.message_id,
      embedTitle: panel.embed_title,
      embedDescription: panel.embed_description,
      embedColor: panel.embed_color,
      embedFooter: panel.embed_footer,
      embedImage: panel.embed_image,
      embedThumbnail: panel.embed_thumbnail,
      placeholder: panel.placeholder,
      nodes: nodes.map((n) => ({
        id: n.id,
        parentId: n.parent_id,
        kind: n.kind,
        label: n.label,
        emoji: n.emoji,
        selectDescription: n.select_description,
        embedTitle: n.embed_title,
        embedDescription: n.embed_description,
        embedColor: n.embed_color,
        embedFooter: n.embed_footer,
        embedImage: n.embed_image,
        embedThumbnail: n.embed_thumbnail,
        allowTicket: Boolean(n.allow_ticket),
        ticketTypeId: n.ticket_type_id,
        ticketExtraMessage: n.ticket_extra_message,
        allowedRoleIds: n.allowed_role_ids,
        stats: stats.get(String(n.id)) ?? { views: 0, tickets: 0, helpful: 0, unhelpful: 0 },
      })),
    };
  }

  async function stateJson(guild) {
    const [settings, panels, types, stats] = await Promise.all([support.settings(guild.id), support.listPanels(guild.id), ticketTypesOf(guild), support.statsForGuild(guild.id)]);
    const panelsJson = await Promise.all(panels.map(async (panel) => panelJson(panel, await support.listAllNodes(panel.id), stats)));
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      settings: { logChannelId: settings.logChannelId },
      textChannels: [...guild.channels.cache.values()]
        .filter((c) => TEXT_TYPES.has(c.type))
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.id, name: c.name })),
      roles: [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null })),
      ticketTypes: (types ?? []).map((t) => ({ id: t.id, label: t.label })),
      ticketsModuleEnabled: Boolean(types),
      panels: panelsJson,
    };
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'support.html')));

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

  // ── Réglages ──────────────────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const id = textChannelId(guild, req.body?.logChannelId);
      await support.setLogChannel(guild.id, id);
      await logWeb(req, guild, `salon de journal : ${id ? `<#${id}>` : 'aucun'}.`);
      res.json(await stateJson(guild));
    }),
  );

  // ── Panels ────────────────────────────────────────────────────────────────

  router.post(
    '/api/panels',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const created = await support.createPanel(guild.id);
      await logWeb(req, guild, `panel support créé (#${created.id}).`);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/panels/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const panel = await panelOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = embedPatch(body, {});
      if ('placeholder' in body) patch.placeholder = body.placeholder ? String(body.placeholder).slice(0, 150) : null;
      await support.updatePanel(panel.id, patch);
      await refreshPanelMessage(ctx, support, await support.getPanel(panel.id));
      await logWeb(req, guild, `panel support #${panel.id} modifié.`);
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/panels/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const panel = await panelOf(guild, req.params.id);
      if (panel.channel_id && panel.message_id) {
        const channel = guild.channels.cache.get(panel.channel_id);
        if (channel?.isTextBased()) await channel.messages.delete(panel.message_id).catch(() => {});
      }
      await support.deletePanel(panel.id);
      await logWeb(req, guild, `panel support #${panel.id} supprimé.`);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/panels/:id/publish',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const panel = await panelOf(guild, req.params.id);
      const channelId = String(req.body?.channelId ?? '');
      if (!isSnowflake(channelId)) throw new HttpError(400, 'Salon invalide');
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !TEXT_TYPES.has(channel.type)) throw new HttpError(404, 'Salon textuel introuvable');
      const result = await publishPanel(ctx, support, panel, channel);
      if (result.error) throw new HttpError(409, result.error);
      await logWeb(req, guild, `panel support #${panel.id} publié dans <#${channelId}>.`);
      res.json(await stateJson(guild));
    }),
  );

  // ── Nœuds (catégories / réponses) ────────────────────────────────────────

  router.post(
    '/api/nodes',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const panel = await panelOf(guild, req.body?.panelId);
      let parentId = null;
      if (req.body?.parentId) {
        const { node: parent } = await nodeOf(guild, req.body.parentId);
        if (parent.panel_id !== panel.id) throw new HttpError(400, 'Élément parent invalide.');
        if (parent.kind !== 'category') throw new HttpError(400, 'Seule une catégorie peut avoir des sous-éléments.');
        parentId = parent.id;
      }
      const kind = req.body?.kind === 'response' ? 'response' : 'category';
      const label = String(req.body?.label ?? (kind === 'response' ? 'Nouvelle réponse' : 'Nouvelle catégorie')).slice(0, 100) || 'Sans nom';
      await support.createNode(panel.id, parentId, kind, label);
      await refreshPanelMessage(ctx, support, panel);
      await logWeb(req, guild, `${kind === 'response' ? 'réponse' : 'catégorie'} créée : **${label}** (panel #${panel.id}).`);
      res.json(await stateJson(guild));
    }),
  );

  router.post(
    '/api/nodes/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { node, panel } = await nodeOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = embedPatch(body, {});
      if ('label' in body) patch.label = String(body.label || node.label).slice(0, 100);
      if ('emoji' in body) patch.emoji = body.emoji ? String(body.emoji).slice(0, 64) : null;
      if ('selectDescription' in body) patch.select_description = body.selectDescription ? String(body.selectDescription).slice(0, 100) : null;
      if ('allowedRoleIds' in body) {
        patch.allowed_role_ids = Array.isArray(body.allowedRoleIds) ? [...new Set(body.allowedRoleIds.map(String).filter((id) => guild.roles.cache.has(id)))] : [];
      }
      if (node.kind === 'response') {
        if ('allowTicket' in body) patch.allow_ticket = body.allowTicket ? 1 : 0;
        if ('ticketTypeId' in body) {
          // Le type doit appartenir à un panel de tickets de CE serveur.
          const typeId = body.ticketTypeId ? String(body.ticketTypeId) : null;
          if (typeId) {
            const types = (await ticketTypesOf(guild)) ?? [];
            if (!types.some((t) => String(t.id) === typeId)) throw new HttpError(400, 'Type de ticket introuvable sur ce serveur.');
          }
          patch.ticket_type_id = typeId ? Number(typeId) : null;
        }
        if ('ticketExtraMessage' in body) patch.ticket_extra_message = body.ticketExtraMessage ? String(body.ticketExtraMessage).slice(0, 1000) : null;
      }
      await support.updateNode(node.id, patch);
      await refreshPanelMessage(ctx, support, panel);
      await logWeb(req, guild, `${node.kind === 'response' ? 'réponse' : 'catégorie'} modifiée : **${patch.label ?? node.label}** (panel #${panel.id}).`);
      res.json(await stateJson(guild));
    }),
  );

  // Réordonne un nœud parmi ses frères (le menu Discord suit cet ordre).
  router.post(
    '/api/nodes/:id/move',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { node, panel } = await nodeOf(guild, req.params.id);
      const direction = Number(req.body?.direction);
      if (direction !== -1 && direction !== 1) throw new HttpError(400, 'Direction invalide.');
      if (await support.moveNode(node.id, direction)) {
        await refreshPanelMessage(ctx, support, panel);
        await logWeb(req, guild, `${node.kind === 'response' ? 'réponse' : 'catégorie'} déplacée : **${node.label}** (panel #${panel.id}).`);
      }
      res.json(await stateJson(guild));
    }),
  );

  router.delete(
    '/api/nodes/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage');
      const { node, panel } = await nodeOf(guild, req.params.id);
      await support.deleteNode(node.id);
      await refreshPanelMessage(ctx, support, panel);
      await logWeb(req, guild, `${node.kind === 'response' ? 'réponse' : 'catégorie'} supprimée : **${node.label}** (panel #${panel.id}).`);
      res.json(await stateJson(guild));
    }),
  );
};
