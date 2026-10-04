'use strict';

const path = require('node:path');
const express = require('express');
const { ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { HttpError, wrap, isSnowflake, avatarUrl, hexColor, imageUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess, memberOf } = require('../../permissions/lib/webAccess');
const { claimBlock, isTicketAdmin, roleAccess } = require('../lib/guard');
const { publishPanel, refreshPanelMessage, setClaim, closeTicket, reopenTicket, deleteTicket, grantAdminAccess, revokeAdminAccess, sendAsWebUser } = require('../lib/lifecycle');
const { isWithinSchedule, computeTimers, panelSchedule } = require('../lib/schedule');
const { normalizeQuestions } = require('../lib/form');
const { staffReply, closeModmail } = require('../lib/modmail');
const { fillSnippet } = require('../lib/snippets');
const { applyTicketTag } = require('../lib/tags');
const { priorityOf, waitingFor } = require('../lib/autolist');
const { cleanPrefix } = require('../lib/channelName');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_PAGE_SIZE = 50;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const MAX_MENTIONED_USERS = 200;

/**
 * Types de fichiers affichables tels quels dans le navigateur. Tout le reste (HTML, SVG, scripts…) est servi en
 * téléchargement et en `application/octet-stream` : un fichier joint par un membre ne doit jamais pouvoir
 * s'exécuter sur l'origine du dashboard (XSS stocké).
 */
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|x-m4a))\s*(;|$)/i;

function roleIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(isSnowflake))] : [];
}

/** Délai en heures (1 à 8760 = un an), ou null si vide (option désactivée). */
function hoursOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8760) throw new HttpError(400, `${label} : délai invalide (1 à 8760 heures, ou vide).`);
  return n;
}

/** Interface web du module Tickets (/m/tickets/) : panels multi-types, réglages, tickets, transcripts. */
module.exports = function registerWeb(router, ctx) {
  const { tickets, logs } = ctx.services;
  const access = guildAccess(ctx, { module: 'tickets', category: 'tickets', label: 'Tickets' });

  function webUserOf(req) {
    const user = req.session.user;
    return { id: user.id, name: user.globalName || user.username, avatar: avatarUrl(user.id, user.avatar ?? null) };
  }

  /** Une ligne de journal par modification « finale » faite depuis le panel. */
  function logWeb(req, guild, text) {
    return logs.send(guild.id, ui.card({ description: `🌐 **${webUserOf(req).name}** (panel web) — ${text}`, timestamp: true }));
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

  async function panelOf(guild, panelId) {
    const panel = await tickets.getPanel(panelId);
    if (!panel || panel.guild_id !== guild.id) throw new HttpError(404, 'Panel introuvable');
    return panel;
  }

  async function typeOf(guild, typeId) {
    const type = await tickets.getType(typeId);
    if (!type) throw new HttpError(404, 'Type de ticket introuvable');
    const panel = await panelOf(guild, type.panel_id);
    return { type, panel };
  }

  // ── Portée de lecture ─────────────────────────────────────────────────────
  // Le droit du panel (« voir les tickets »…) ouvre l'onglet ; il ne donne pas accès à tous les tickets. Comme sur
  // Discord, un membre du staff ne voit que les tickets des types dont il a un rôle (mod/helper), ceux qu'il a ouverts,
  // pris en charge ou auxquels il a été ajouté, et les fils modmail des catégories dont il est staff. Les admins
  // (propriétaire du bot/serveur, administrateur Discord, admin du module) voient tout.
  const NOT_VISIBLE = 'Ce ticket ne fait pas partie de ceux que tu peux voir (rôles staff de son type requis).';

  /** Compte connecté sur ce serveur : { member, admin, userId }, calculé une fois par requête. */
  async function viewerOf(req, guild) {
    if (req.ticketViewer?.guildId === guild.id) return req.ticketViewer;
    const userId = req.session.user.id;
    const member = await memberOf(guild, userId);
    const admin = ctx.config.owners.has(userId) || (member ? await isTicketAdmin(ctx, member) : false);
    req.ticketViewer = { guildId: guild.id, userId, member, admin };
    return req.ticketViewer;
  }

  /** Visibilité « sans base de données » : admin, rôle du type, ouvreur ou staff qui l'a pris en charge. */
  function quickVisible(viewer, ticket, type) {
    if (viewer.admin) return true;
    if (String(ticket.opener_id) === viewer.userId || String(ticket.claimed_by ?? '') === viewer.userId) return true;
    return Boolean(type && viewer.member && roleAccess(type, viewer.member));
  }

  async function canViewTicket(viewer, ticket, type) {
    if (quickVisible(viewer, ticket, type)) return true;
    return tickets.isMember(ticket.id, viewer.userId); // ajouté au ticket (/ticket add)
  }

  /** Garde seulement les tickets visibles (liste), dans le même ordre. */
  async function visibleTickets(viewer, rows, typeOfRow) {
    if (viewer.admin) return rows;
    const keep = await Promise.all(rows.map((row) => canViewTicket(viewer, row, typeOfRow(row))));
    return rows.filter((row, index) => keep[index]);
  }

  /** Fil modmail : admin, ou rôle staff de sa catégorie (rôles figés à l'ouverture ou rôles actuels de la catégorie). */
  function canViewThread(viewer, thread, categoriesById) {
    if (viewer.admin) return true;
    if (!viewer.member) return false;
    const current = categoriesById?.get(String(thread.category_id))?.staff_role_ids ?? [];
    return [...(thread.staff_role_ids ?? []), ...current].some((id) => viewer.member.roles.cache.has(String(id)));
  }

  async function modmailCategoriesIndex(guild) {
    return new Map((await tickets.listModmailCategories(guild.id)).map((c) => [String(c.id), c]));
  }

  async function assertTicketVisible(req, guild, ticket) {
    const viewer = await viewerOf(req, guild);
    if (viewer.admin) return;
    const type = await tickets.getType(ticket.type_id);
    if (!(await canViewTicket(viewer, ticket, type))) throw new HttpError(403, NOT_VISIBLE);
  }

  async function assertThreadVisible(req, guild, thread) {
    const viewer = await viewerOf(req, guild);
    if (viewer.admin) return;
    if (!canViewThread(viewer, thread, await modmailCategoriesIndex(guild))) throw new HttpError(403, 'Ce fil modmail ne fait pas partie de ceux que tu peux voir (rôle staff de sa catégorie requis).');
  }

  /** Ticket du serveur, visible par ce compte (actions du panel). */
  async function ticketOf(req, guild, ticketId) {
    const ticket = await tickets.getTicket(ticketId);
    if (!ticket || ticket.guild_id !== guild.id) throw new HttpError(404, 'Ticket introuvable');
    await assertTicketVisible(req, guild, ticket);
    return ticket;
  }

  /** Ticket + serveur sans dépendre de `?guild=` (page transcript ouverte par lien direct), droit et visibilité vérifiés. */
  async function ticketWithGuild(req, ticketId, right) {
    const ticket = await tickets.getTicket(ticketId);
    if (!ticket) throw new HttpError(404, 'Ticket introuvable');
    const guild = ctx.client.guilds.cache.get(ticket.guild_id);
    if (!guild) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    await access.check(req, guild, right);
    await assertTicketVisible(req, guild, ticket);
    return { guild, ticket };
  }

  async function modmailCategoryOf(guild, id) {
    const category = await tickets.getModmailCategory(id);
    if (!category || category.guild_id !== guild.id) throw new HttpError(404, 'Catégorie de modmail introuvable');
    return category;
  }

  /** Fil modmail + serveur (lien direct), droit vérifié. */
  async function modmailWithGuild(req, threadId, right) {
    const thread = await tickets.getModmailThread(threadId);
    if (!thread) throw new HttpError(404, 'Fil modmail introuvable');
    const guild = ctx.client.guilds.cache.get(thread.guild_id);
    if (!guild) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    await access.check(req, guild, right);
    await assertThreadVisible(req, guild, thread);
    return { guild, thread };
  }

  function modmailThreadJson(guild, thread) {
    return {
      id: thread.id,
      status: thread.status,
      user: person(guild, thread.user_id),
      categoryName: thread.category_name,
      panelOnly: !thread.channel_id, // traité uniquement depuis le panel (aucun salon Discord)
      openedBy: thread.opened_by ? person(guild, thread.opened_by) : null,
      closedBy: thread.closed_by ? person(guild, thread.closed_by) : null,
      closeReason: thread.close_reason,
      createdAt: thread.created_at,
      closedAt: thread.closed_at,
    };
  }

  function typeJson(type) {
    return {
      id: type.id,
      label: type.label,
      emoji: type.emoji,
      buttonStyle: type.button_style,
      selectDescription: type.select_description,
      channelNamePattern: type.channel_name_pattern,
      categoryId: type.category_id,
      maxOpen: type.max_open,
      modRoleIds: type.mod_role_ids,
      notifyRoleIds: type.notify_role_ids,
      helperRoleIds: type.helper_role_ids,
      repingRoleIds: type.reping_role_ids,
      repingSameAsNotify: Boolean(type.reping_same_as_notify),
      repingMessage: type.reping_message,
      claimedChannelNamePattern: type.claimed_channel_name_pattern,
      closedChannelNamePattern: type.closed_channel_name_pattern,
      closeOnLeave: Boolean(type.close_on_leave),
      openedTitle: type.opened_title,
      openedDescription: type.opened_description,
      openedColor: type.opened_color,
      openedFooter: type.opened_footer,
      openedImage: type.opened_image,
      openedThumbnail: type.opened_thumbnail,
      autoTranscript: Boolean(type.auto_transcript),
      transcriptPrompt: Boolean(type.transcript_prompt),
      liveTranscript: Boolean(type.live_transcript),
      userCanClose: Boolean(type.user_can_close),
      ratingEnabled: Boolean(type.rating_enabled),
      claimRequired: Boolean(Number(type.claim_required)),
      autoCloseMinutes: type.auto_close_minutes,
      repingMinutes: type.reping_minutes,
      formEnabled: Boolean(Number(type.form_enabled)),
      formTitle: type.form_title,
      formQuestions: normalizeQuestions(type.form_questions),
      autoDeleteHours: type.auto_delete_hours,
    };
  }

  function tagJson(tag) {
    return {
      id: tag.id,
      name: tag.name,
      emoji: tag.emoji,
      color: tag.color,
      position: Number(tag.position ?? 0),
      categoryId: tag.category_id ? String(tag.category_id) : null,
      mentionRoleIds: (tag.mention_role_ids ?? []).map(String),
      channelPrefix: tag.channel_prefix ?? null,
    };
  }

  function panelJson(panel, types) {
    return {
      id: panel.id,
      channelId: panel.channel_id,
      messageId: panel.message_id,
      style: panel.style,
      openTitle: panel.open_title,
      openDescription: panel.open_description,
      openColor: panel.open_color,
      openFooter: panel.open_footer,
      openImage: panel.open_image,
      openThumbnail: panel.open_thumbnail,
      scheduleEnabled: Boolean(Number(panel.schedule_enabled)),
      scheduleStart: panel.schedule_start,
      scheduleEnd: panel.schedule_end,
      scheduleTimezone: panel.schedule_timezone,
      types: types.map(typeJson),
    };
  }

  /** `type` / `panel` : lignes brutes déjà chargées (pas de requête par ticket) ; `tags` : étiquettes du ticket. */
  function ticketJson(guild, ticket, type, panel, tags = []) {
    const open = ticket.status === 'open';
    const timers = open ? computeTimers(ticket, type) : { repingAt: null, autoCloseAt: null };
    const schedule = open ? panelSchedule(panel) : null;
    return {
      id: ticket.id,
      channelId: ticket.channel_id,
      status: ticket.status,
      subject: ticket.subject,
      opener: person(guild, ticket.opener_id),
      claimedBy: ticket.claimed_by ? person(guild, ticket.claimed_by) : null,
      typeLabel: type?.label ?? ticket.subject,
      typeId: ticket.type_id,
      closeReason: ticket.close_reason,
      closedBy: ticket.closed_by ? person(guild, ticket.closed_by) : null,
      closedAt: ticket.closed_at,
      createdAt: ticket.created_at,
      transcriptGenerated: Boolean(ticket.transcript_generated),
      channelExists: guild.channels.cache.has(String(ticket.channel_id)), // faux une fois le salon supprimé : plus de réouverture ni de suppression possibles
      ratingStars: ticket.rating_stars ?? null,
      repingAt: timers.repingAt,
      autoCloseAt: timers.autoCloseAt,
      scheduleActive: schedule ? !schedule.scheduleEnabled || isWithinSchedule(schedule) : true,
      tags,
      formAnswers: ticket.form_answers ?? [],
      guildId: guild.id,
      claimRequired: Boolean(Number(type?.claim_required ?? 0)),
      waitingFor: open ? waitingFor(ticket) : null, // 'staff' | 'member' | 'new' : qui doit répondre
    };
  }

  /** Ticket isolé (page transcript) : charge son type, son panel et ses étiquettes. */
  async function singleTicketJson(guild, ticket) {
    const [type, panel, tagMap] = await Promise.all([tickets.getType(ticket.type_id), tickets.getPanel(ticket.panel_id), tickets.tagsForTickets([ticket.id])]);
    return { json: ticketJson(guild, ticket, type, panel, tagMap.get(String(ticket.id)) ?? []), type };
  }

  /** Types de tous les panels du serveur en une requête : Map(id → type brut). */
  async function typesIndex(guild) {
    const all = await tickets.listAllTypes(guild.id);
    return new Map(all.map((type) => [String(type.id), type]));
  }

  async function stateJson(req, guild) {
    const [
      settings,
      modmailEnabled,
      modmailCategories,
      admins,
      panelsRows,
      allTypes,
      openTickets,
      openModmailThreads,
      ratingStats,
      ratingsByStaffRows,
      ratingsByTypeRows,
      ratedRows,
      snippets,
      tags,
      blacklist,
      prefixes,
      staffIds,
    ] = await Promise.all([
        tickets.settings(guild.id),
        tickets.modmailEnabled(guild.id),
        tickets.listModmailCategories(guild.id),
        tickets.listAdmins(guild.id),
        tickets.listPanels(guild.id),
        tickets.listAllTypes(guild.id),
        tickets.listOpenTickets(guild.id),
        tickets.listModmailThreads(guild.id, { status: 'open' }),
        tickets.ratingStats(guild.id),
        tickets.ratingsByStaff(guild.id),
        tickets.ratingsByType(guild.id),
        tickets.listRatedTickets(guild.id),
        tickets.listSnippets(guild.id),
        tickets.listTags(guild.id),
        tickets.listBlacklist(guild.id),
        tickets.rolePrefixes(guild.id),
        tickets.staffWhoClaimed(guild.id),
      ]);
    const openTags = await tickets.tagsForTickets(openTickets.map((t) => t.id));

    const typesById = new Map(allTypes.map((type) => [String(type.id), type]));
    const panelsById = new Map(panelsRows.map((panel) => [String(panel.id), panel]));

    // Uniquement ce que ce compte peut voir (voir « Portée de lecture »).
    const viewer = await viewerOf(req, guild);
    const modmailById = new Map(modmailCategories.map((c) => [String(c.id), c]));
    const visibleOpen = await visibleTickets(viewer, openTickets, (t) => typesById.get(String(t.type_id)) ?? null);
    const visibleThreads = openModmailThreads.filter((t) => canViewThread(viewer, t, modmailById));
    const visibleRated = viewer.admin ? ratedRows : ratedRows.filter((r) => quickVisible(viewer, r, typesById.get(String(r.type_id)) ?? null));
    // Blocs de l'onglet « Tickets ouverts » : une catégorie (type) par bloc, même vide — les types dont ce compte est
    // staff (tous pour un admin), plus ceux d'un ticket qu'il voit à un autre titre ; ordre des panels puis des types.
    const shownTypeIds = new Set(visibleOpen.map((t) => String(t.type_id)));
    const panelOrder = new Map(panelsRows.map((panel, index) => [String(panel.id), index]));
    const openTicketTypes = allTypes
      .filter((type) => viewer.admin || shownTypeIds.has(String(type.id)) || (viewer.member && roleAccess(type, viewer.member)))
      .sort((a, b) => (panelOrder.get(String(a.panel_id)) ?? 0) - (panelOrder.get(String(b.panel_id)) ?? 0) || (a.position ?? 0) - (b.position ?? 0) || Number(a.id) - Number(b.id))
      .map((type) => ({ id: type.id, label: type.label, emoji: type.emoji ?? null, panelId: type.panel_id, claimRequired: Boolean(Number(type.claim_required)) }));
    const typesByPanel = new Map();
    for (const type of allTypes) {
      const key = String(type.panel_id);
      if (!typesByPanel.has(key)) typesByPanel.set(key, []);
      typesByPanel.get(key).push(type);
    }
    const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || Number(a.id) - Number(b.id);
    const panels = panelsRows.map((panel) => panelJson(panel, (typesByPanel.get(String(panel.id)) ?? []).sort(byPosition)));

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      settings: { logChannelId: settings.logChannelId },
      modmail: {
        enabled: modmailEnabled,
        categories: modmailCategories.map((c) => ({
          id: c.id,
          name: c.name,
          categoryId: c.category_id,
          staffRoleIds: c.staff_role_ids,
          welcomeMessage: c.welcome_message,
          autoCloseHours: c.auto_close_hours,
          panelOnly: Boolean(Number(c.panel_only)),
        })),
        prefixes: [...prefixes.entries()].map(([roleId, prefix]) => ({ roleId, prefix, roleName: guild.roles.cache.get(roleId)?.name ?? `Rôle supprimé (${roleId})` })),
      },
      snippets: snippets.map((s) => ({ id: s.id, name: s.name, content: s.content })),
      tags: tags.map(tagJson),
      blacklist: blacklist.map((b) => ({ userId: String(b.user_id), person: person(guild, String(b.user_id)), reason: b.reason, addedBy: b.added_by ? person(guild, String(b.added_by)) : null, addedAt: b.added_at })),
      staffChoices: staffIds.map((id) => person(guild, id)).sort((a, b) => a.name.localeCompare(b.name)),
      types: allTypes.map((t) => ({ id: t.id, label: t.label, panelId: t.panel_id })),
      openModmailThreads: visibleThreads.map((t) => modmailThreadJson(guild, t)),
      ratingStats,
      ratingsByStaff: ratingsByStaffRows.map((r) => ({ person: person(guild, r.userId), count: r.count, average: r.average })),
      ratingsByType: ratingsByTypeRows.map((r) => ({ typeLabel: typesById.get(r.typeId)?.label ?? 'Type supprimé', count: r.count, average: r.average })),
      ratingReviews: visibleRated.map((r) => ({
        ticketId: r.id,
        typeLabel: typesById.get(String(r.type_id))?.label ?? 'Type supprimé',
        opener: person(guild, r.opener_id),
        staff: r.claimed_by ? person(guild, r.claimed_by) : null,
        stars: r.rating_stars,
        at: r.rating_at,
      })),
      admins: admins.map((row) => ({ userId: row.user_id, person: person(guild, row.user_id), addedByPerson: row.added_by ? person(guild, row.added_by) : null, addedAt: row.added_at })),
      textChannels: [...guild.channels.cache.values()].filter((c) => TEXT_TYPES.has(c.type)).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name })),
      categories: [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name })),
      roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null })),
      panels,
      // Même ordre que /ticket list : priorité des étiquettes, puis du plus ancien au plus récent.
      viewerAdmin: viewer.admin,
      openTicketTypes,
      openTickets: visibleOpen
        .map((t) => ({ t, tags: openTags.get(String(t.id)) ?? [] }))
        .sort((a, b) => priorityOf(a.tags) - priorityOf(b.tags) || new Date(a.t.created_at) - new Date(b.t.created_at))
        .map(({ t, tags: ticketTags }) => ticketJson(guild, t, typesById.get(String(t.type_id)) ?? null, panelsById.get(String(t.panel_id)) ?? null, ticketTags)),
    };
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tickets.html')));
  router.get('/transcript', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'transcript.html')));

  router.get(
    '/api/guilds',
    wrap(async (req, res) => {
      res.json(await access.guilds(req));
    }),
  );

  router.get(
    '/api/state',
    wrap(async (req, res) => {
      res.json(await stateJson(req, await access.guild(req)));
    }),
  );

  // ── Réglages & admins ────────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const id = textChannelId(guild, req.body?.logChannelId);
      await tickets.setLogChannel(guild.id, id);
      await logWeb(req, guild, `salon de journal : ${id ? `<#${id}>` : 'aucun'}.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/modmail',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const enabled = Boolean(req.body?.enabled);
      await tickets.setModmailEnabled(guild.id, enabled);
      await logWeb(req, guild, `modmail : ${enabled ? 'activé' : 'désactivé'}.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/modmail-categories',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const name = String(req.body?.name ?? 'Nouvelle catégorie').slice(0, 100) || 'Nouvelle catégorie';
      const created = await tickets.createModmailCategory(guild.id, name);
      await logWeb(req, guild, `catégorie de modmail créée : **${created.name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/modmail-categories/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const category = await modmailCategoryOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = {};
      if ('name' in body) patch.name = String(body.name || category.name).slice(0, 100);
      if ('categoryId' in body) {
        const id = body.categoryId ? String(body.categoryId) : null;
        if (id && guild.channels.cache.get(id)?.type !== ChannelType.GuildCategory) throw new HttpError(400, 'Catégorie Discord introuvable sur ce serveur.');
        patch.categoryId = id;
      }
      if ('staffRoleIds' in body) patch.staffRoleIds = roleIds(body.staffRoleIds);
      if ('welcomeMessage' in body) patch.welcomeMessage = body.welcomeMessage ? String(body.welcomeMessage).slice(0, 2000) : null;
      if ('autoCloseHours' in body) patch.autoCloseHours = hoursOrNull(body.autoCloseHours, 'Fermeture automatique');
      if ('panelOnly' in body) patch.panelOnly = body.panelOnly === true;
      await tickets.updateModmailCategory(category.id, patch);
      await logWeb(req, guild, `catégorie de modmail modifiée : **${patch.name ?? category.name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/modmail-categories/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const category = await modmailCategoryOf(guild, req.params.id);
      await tickets.deleteModmailCategory(category.id);
      await logWeb(req, guild, `catégorie de modmail supprimée : **${category.name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      await tickets.addAdmin(guild.id, userId, webUserOf(req).id);
      await grantAdminAccess(ctx, guild, userId);
      await logWeb(req, guild, `admin du module ajouté : <@${userId}>.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/admins/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      await tickets.removeAdmin(guild.id, userId);
      await revokeAdminAccess(ctx, guild, userId);
      await logWeb(req, guild, `admin du module retiré : <@${userId}>.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Réponses prédéfinies ─────────────────────────────────────────────────

  router.post(
    '/api/snippets',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const body = req.body ?? {};
      const name = String(body.name ?? '').trim().slice(0, 50);
      const content = String(body.content ?? '').trim().slice(0, 2000);
      if (!name || !content) throw new HttpError(400, 'Nom et contenu obligatoires.');
      const id = body.id ? Number(body.id) : null;
      if (id) {
        const existing = await tickets.getSnippet(id);
        if (!existing || String(existing.guild_id) !== guild.id) throw new HttpError(404, 'Réponse prédéfinie introuvable');
      }
      const clash = await tickets.snippetByName(guild.id, name);
      if (clash && Number(clash.id) !== id) throw new HttpError(409, `Une réponse prédéfinie s’appelle déjà « ${name} ».`);
      await tickets.saveSnippet(guild.id, { id, name, content, by: req.session.user.id });
      await logWeb(req, guild, `réponse prédéfinie ${id ? 'modifiée' : 'créée'} : **${name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/snippets/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const snippet = await tickets.getSnippet(req.params.id);
      if (!snippet || String(snippet.guild_id) !== guild.id) throw new HttpError(404, 'Réponse prédéfinie introuvable');
      await tickets.deleteSnippet(guild.id, snippet.id);
      await logWeb(req, guild, `réponse prédéfinie supprimée : **${snippet.name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Étiquettes ───────────────────────────────────────────────────────────

  router.post(
    '/api/tags',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const body = req.body ?? {};
      const name = String(body.name ?? '').trim().slice(0, 50);
      if (!name) throw new HttpError(400, 'Nom de l’étiquette obligatoire.');
      const id = body.id ? Number(body.id) : null;
      if (id) {
        const existing = await tickets.getTag(id);
        if (!existing || String(existing.guild_id) !== guild.id) throw new HttpError(404, 'Étiquette introuvable');
      }
      const clash = (await tickets.listTags(guild.id)).find((t) => t.name.toLowerCase() === name.toLowerCase() && Number(t.id) !== id);
      if (clash) throw new HttpError(409, `L’étiquette « ${name} » existe déjà.`);
      const categoryId = body.categoryId ? String(body.categoryId) : null;
      if (categoryId && guild.channels.cache.get(categoryId)?.type !== ChannelType.GuildCategory) throw new HttpError(400, 'Catégorie Discord introuvable sur ce serveur.');
      await tickets.saveTag(guild.id, {
        id,
        name,
        emoji: body.emoji ? String(body.emoji).trim().slice(0, 64) : null,
        color: hexColor(body.color),
        categoryId,
        mentionRoleIds: roleIds(body.mentionRoleIds).filter((roleId) => guild.roles.cache.has(roleId)),
        channelPrefix: body.channelPrefix ? cleanPrefix(body.channelPrefix) || null : null,
      });
      await logWeb(req, guild, `étiquette ${id ? 'modifiée' : 'créée'} : **${name}**.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // Ordre de priorité des étiquettes (la première est la plus prioritaire : listes de tickets, /ticket list).
  router.post(
    '/api/tags/:id/move',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const tag = await tickets.getTag(req.params.id);
      if (!tag || String(tag.guild_id) !== guild.id) throw new HttpError(404, 'Étiquette introuvable');
      await tickets.moveTag(guild.id, tag.id, req.body?.direction === 'up' ? -1 : 1);
      ctx.services.autolist?.refresh(guild.id);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/tags/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const tag = await tickets.getTag(req.params.id);
      if (!tag || String(tag.guild_id) !== guild.id) throw new HttpError(404, 'Étiquette introuvable');
      await tickets.deleteTag(guild.id, tag.id);
      await logWeb(req, guild, `étiquette supprimée : **${tag.name}** (retirée de tous les tickets).`);
      res.json(await stateJson(req, guild));
    }),
  );

  // Pose / retire une étiquette sur un ticket ouvert (comme /ticket tag).
  router.post(
    '/api/tickets/:id/tags',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-tickets');
      const ticket = await ticketOf(req, guild, req.params.id);
      const tag = await tickets.getTag(req.body?.tagId);
      if (!tag || String(tag.guild_id) !== guild.id) throw new HttpError(404, 'Étiquette introuvable');
      const type = await tickets.getType(ticket.type_id);
      // Mêmes effets que /ticket tag : catégorie, préfixe du salon, mention des rôles, listes automatiques.
      await applyTicketTag(ctx, { guild, ticket, type, tag, on: req.body?.on !== false, executorId: req.session.user.id, viaWeb: true });
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Liste noire (ouverture de tickets et modmail) ────────────────────────

  router.post(
    '/api/blacklist',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const userId = String(req.body?.userId ?? '');
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 300) : null;
      await tickets.addBlacklist(guild.id, userId, reason, req.session.user.id);
      await logWeb(req, guild, `liste noire des tickets : <@${userId}> ajouté${reason ? ` (${reason})` : ''}.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/blacklist/:userId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const { userId } = req.params;
      if (!isSnowflake(userId)) throw new HttpError(400, 'ID invalide');
      await tickets.removeBlacklist(guild.id, userId);
      await logWeb(req, guild, `liste noire des tickets : <@${userId}> retiré.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Préfixes de grade du modmail ─────────────────────────────────────────

  router.post(
    '/api/modmail-prefixes',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const roleId = String(req.body?.roleId ?? '');
      if (!isSnowflake(roleId) || !guild.roles.cache.has(roleId)) throw new HttpError(404, 'Rôle introuvable sur ce serveur.');
      const prefix = String(req.body?.prefix ?? '').trim().slice(0, 32);
      if (!prefix) throw new HttpError(400, 'Préfixe vide.');
      await tickets.setRolePrefix(guild.id, roleId, prefix);
      await logWeb(req, guild, `préfixe de grade du modmail : <@&${roleId}> → « ${prefix} ».`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/modmail-prefixes/:roleId',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const { roleId } = req.params;
      if (!isSnowflake(roleId)) throw new HttpError(400, 'Rôle invalide');
      await tickets.deleteRolePrefix(guild.id, roleId);
      await logWeb(req, guild, `préfixe de grade du modmail retiré pour <@&${roleId}>.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Panels ────────────────────────────────────────────────────────────────

  router.post(
    '/api/panels',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const created = await tickets.createPanel(guild.id, webUserOf(req).id);
      await logWeb(req, guild, `panel créé (#${created.id}).`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/panels/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const panel = await panelOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = {};
      if ('style' in body) patch.style = body.style === 'select' ? 'select' : 'buttons';
      if ('openTitle' in body) patch.open_title = body.openTitle ? String(body.openTitle).slice(0, 256) : null;
      if ('openDescription' in body) patch.open_description = body.openDescription ? String(body.openDescription).slice(0, 4096) : null;
      if ('openColor' in body) patch.open_color = hexColor(body.openColor);
      if ('openFooter' in body) patch.open_footer = body.openFooter ? String(body.openFooter).slice(0, 2048) : null;
      if ('openImage' in body) patch.open_image = imageUrl(body.openImage, 'Image');
      if ('openThumbnail' in body) patch.open_thumbnail = imageUrl(body.openThumbnail, 'Miniature');
      if ('scheduleEnabled' in body) patch.schedule_enabled = body.scheduleEnabled ? 1 : 0;
      const timePattern = /^\d{2}:\d{2}$/;
      if ('scheduleStart' in body) patch.schedule_start = body.scheduleStart && timePattern.test(body.scheduleStart) ? `${body.scheduleStart}:00` : null;
      if ('scheduleEnd' in body) patch.schedule_end = body.scheduleEnd && timePattern.test(body.scheduleEnd) ? `${body.scheduleEnd}:00` : null;
      if ('scheduleTimezone' in body) patch.schedule_timezone = body.scheduleTimezone ? String(body.scheduleTimezone).slice(0, 64) : 'Europe/Paris';
      await tickets.updatePanel(panel.id, patch);
      await refreshPanelMessage(ctx, await tickets.getPanel(panel.id));
      await logWeb(req, guild, `panel #${panel.id} modifié.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/panels/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const panel = await panelOf(guild, req.params.id);
      if (panel.channel_id && panel.message_id) {
        const channel = guild.channels.cache.get(panel.channel_id);
        if (channel?.isTextBased()) await channel.messages.delete(panel.message_id).catch(() => {});
      }
      await tickets.deletePanel(panel.id);
      await logWeb(req, guild, `panel #${panel.id} supprimé.`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/panels/:id/publish',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const panel = await panelOf(guild, req.params.id);
      const channelId = String(req.body?.channelId ?? '');
      if (!isSnowflake(channelId)) throw new HttpError(400, 'Salon invalide');
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !TEXT_TYPES.has(channel.type)) throw new HttpError(404, 'Salon textuel introuvable');
      const result = await publishPanel(ctx, panel, channel);
      if (result.error) throw new HttpError(409, result.error);
      await logWeb(req, guild, `panel #${panel.id} publié dans <#${channelId}>.`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Types (boutons / options d'un panel) ─────────────────────────────────

  router.post(
    '/api/panels/:id/types',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const panel = await panelOf(guild, req.params.id);
      const label = String(req.body?.label ?? 'Nouveau type').slice(0, 80) || 'Nouveau type';
      await tickets.createType(panel.id, label);
      await logWeb(req, guild, `type créé : **${label}** (panel #${panel.id}).`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/types/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const { type, panel } = await typeOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = {};
      const str = (key, column, max) => {
        if (key in body) patch[column] = body[key] ? String(body[key]).slice(0, max ?? 4096) : null;
      };
      str('label', 'label', 80);
      str('emoji', 'emoji', 64);
      str('selectDescription', 'select_description', 100);
      str('channelNamePattern', 'channel_name_pattern', 100);
      str('claimedChannelNamePattern', 'claimed_channel_name_pattern', 100);
      str('closedChannelNamePattern', 'closed_channel_name_pattern', 100);
      str('repingMessage', 'reping_message', 1000);
      if ('closeOnLeave' in body) patch.close_on_leave = body.closeOnLeave ? 1 : 0;
      str('openedTitle', 'opened_title', 256);
      str('openedDescription', 'opened_description');
      if ('openedColor' in body) patch.opened_color = hexColor(body.openedColor);
      str('openedFooter', 'opened_footer', 2048);
      if ('openedImage' in body) patch.opened_image = imageUrl(body.openedImage, 'Image');
      if ('openedThumbnail' in body) patch.opened_thumbnail = imageUrl(body.openedThumbnail, 'Miniature');
      if ('buttonStyle' in body) patch.button_style = ['primary', 'secondary', 'success', 'danger'].includes(body.buttonStyle) ? body.buttonStyle : 'primary';
      if ('categoryId' in body) {
        const id = body.categoryId ? String(body.categoryId) : null;
        if (id && guild.channels.cache.get(id)?.type !== ChannelType.GuildCategory) throw new HttpError(400, 'Catégorie Discord introuvable sur ce serveur.');
        patch.category_id = id;
      }
      if ('maxOpen' in body) {
        const n = body.maxOpen === null || body.maxOpen === '' ? null : Number(body.maxOpen);
        if (n !== null && (!Number.isInteger(n) || n < 1 || n > 1000)) throw new HttpError(400, 'Limite invalide (1 à 1000, ou vide)');
        patch.max_open = n;
      }
      if ('modRoleIds' in body) patch.mod_role_ids = roleIds(body.modRoleIds);
      if ('notifyRoleIds' in body) patch.notify_role_ids = roleIds(body.notifyRoleIds);
      if ('helperRoleIds' in body) patch.helper_role_ids = roleIds(body.helperRoleIds);
      if ('repingRoleIds' in body) patch.reping_role_ids = roleIds(body.repingRoleIds);
      if ('repingSameAsNotify' in body) patch.reping_same_as_notify = body.repingSameAsNotify ? 1 : 0;
      if ('autoTranscript' in body) patch.auto_transcript = body.autoTranscript ? 1 : 0;
      if ('transcriptPrompt' in body) patch.transcript_prompt = body.transcriptPrompt ? 1 : 0;
      if ('liveTranscript' in body) patch.live_transcript = body.liveTranscript ? 1 : 0;
      if ('userCanClose' in body) patch.user_can_close = body.userCanClose ? 1 : 0;
      if ('ratingEnabled' in body) patch.rating_enabled = body.ratingEnabled ? 1 : 0;
      if ('claimRequired' in body) patch.claim_required = body.claimRequired ? 1 : 0;
      const minutes = (key, column) => {
        if (!(key in body)) return;
        const n = body[key] === null || body[key] === '' ? null : Number(body[key]);
        if (n !== null && (!Number.isInteger(n) || n < 1 || n > 43200)) throw new HttpError(400, 'Délai invalide (1 à 43200 minutes, ou vide)');
        patch[column] = n;
      };
      minutes('autoCloseMinutes', 'auto_close_minutes');
      minutes('repingMinutes', 'reping_minutes');
      if ('autoDeleteHours' in body) patch.auto_delete_hours = hoursOrNull(body.autoDeleteHours, 'Suppression automatique');
      if ('formEnabled' in body) patch.form_enabled = body.formEnabled ? 1 : 0;
      if ('formTitle' in body) patch.form_title = body.formTitle ? String(body.formTitle).trim().slice(0, 45) : null;
      if ('formQuestions' in body) patch.form_questions = normalizeQuestions(body.formQuestions);
      if (patch.form_enabled && !(patch.form_questions ?? type.form_questions ?? []).length) {
        throw new HttpError(400, 'Ajoute au moins une question pour activer le formulaire.');
      }

      await tickets.updateType(type.id, patch);
      await refreshPanelMessage(ctx, panel);
      await logWeb(req, guild, `type modifié : **${patch.label ?? type.label}** (panel #${panel.id}).`);
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/types/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-panels');
      const { type, panel } = await typeOf(guild, req.params.id);
      await tickets.deleteType(type.id);
      await refreshPanelMessage(ctx, panel);
      await logWeb(req, guild, `type supprimé : **${type.label}** (panel #${panel.id}).`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Tickets ───────────────────────────────────────────────────────────────

  /** Date d'un filtre (AAAA-MM-JJ) ; `endOfDay` : le lendemain à minuit (borne exclue). */
  function dayParam(value, endOfDay = false) {
    if (!value) return null;
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new HttpError(400, `Date invalide : ${value}`);
    if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  // Historique : recherche (texte, ouvreur, staff qui l'a pris en charge, type, étiquette, période) et pagination.
  router.get(
    '/api/tickets/closed',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view-tickets');
      const idParam = (key) => {
        const value = req.query[key] ? String(req.query[key]) : null;
        if (value && !isSnowflake(value)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
        return value;
      };
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const filters = {
        q: req.query.q ? String(req.query.q).trim().slice(0, 100) || null : null,
        openerId: idParam('opener'),
        staffId: idParam('staff'),
        typeId: req.query.type ? Number(req.query.type) || null : null,
        tagId: req.query.tag ? Number(req.query.tag) || null : null,
        from: dayParam(req.query.from),
        to: dayParam(req.query.to, true),
        limit: HISTORY_PAGE_SIZE,
        offset: (page - 1) * HISTORY_PAGE_SIZE,
      };
      const viewer = await viewerOf(req, guild);
      if (!viewer.admin) {
        const staffTypeIds = viewer.member ? [...(await typesIndex(guild)).values()].filter((type) => roleAccess(type, viewer.member)).map((type) => String(type.id)) : [];
        filters.visibleTo = { typeIds: staffTypeIds, userId: viewer.userId };
      }
      const [{ rows, total }, types] = await Promise.all([tickets.searchClosedTickets(guild.id, filters), typesIndex(guild)]);
      const tagMap = await tickets.tagsForTickets(rows.map((t) => t.id));
      res.json({
        page,
        pages: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
        total,
        rows: rows.map((t) => ticketJson(guild, t, types.get(String(t.type_id)) ?? null, null, tagMap.get(String(t.id)) ?? [])),
      });
    }),
  );

  /**
   * Mentions de plusieurs messages résolues en une passe (chaque membre n'est récupéré qu'une fois) :
   * { users, roles, channels } → noms et couleurs actuels, y compris pour les anciens messages.
   */
  async function resolveMentions(guild, messages) {
    const text = messages.map((m) => [m.content ?? '', ...(m.embeds ?? []).map((e) => e?.description ?? '')].join('\n')).join('\n');
    const out = { users: {}, roles: {}, channels: {} };
    const userIds = [...new Set([...text.matchAll(/<@!?(\d{15,25})>/g)].map((x) => x[1]))].slice(0, MAX_MENTIONED_USERS);
    await Promise.all(
      userIds.map(async (id) => {
        const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
        const user = member?.user ?? ctx.client.users.cache.get(id) ?? (await ctx.client.users.fetch(id).catch(() => null));
        if (!user) return;
        const color = member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : null;
        out.users[id] = { name: member?.displayName ?? user.globalName ?? user.username, color };
      }),
    );
    for (const [, id] of text.matchAll(/<@&(\d{15,25})>/g)) {
      const role = guild.roles.cache.get(id);
      if (role) out.roles[id] = { name: role.name, color: role.hexColor !== '#000000' ? role.hexColor : null };
    }
    for (const [, id] of text.matchAll(/<#(\d{15,25})>/g)) {
      const channel = guild.channels.cache.get(id);
      if (channel) out.channels[id] = { name: channel.name };
    }
    return out;
  }

  function messageJson(m) {
    return {
      id: m.id,
      messageId: m.message_id,
      authorId: m.author_id,
      authorName: m.author_name,
      authorAvatar: m.author_avatar,
      authorRoleColor: m.author_role_color,
      authorBot: Boolean(m.author_bot),
      content: m.content,
      embeds: m.embeds,
      attachments: m.attachments,
      viaWeb: Boolean(m.via_web),
      createdAt: m.created_at,
    };
  }

  function modmailMessageJson(m) {
    return {
      id: m.id,
      messageId: m.message_id,
      authorId: m.author_id,
      authorName: m.author_name,
      authorAvatar: m.author_avatar,
      authorBot: Boolean(m.author_bot),
      kind: m.kind,
      badge:
        m.kind === 'note'
          ? '🔒 note interne'
          : m.kind === 'system'
            ? 'ℹ️ système'
            : [Number(m.anonymous) ? '🕶️ anonyme' : null, Number(m.via_web) ? '🌐 panel web' : null].filter(Boolean).join(' · ') || null,
      content: m.content,
      embeds: m.embeds,
      attachments: m.attachments,
      createdAt: m.created_at,
    };
  }

  /**
   * Réponses prédéfinies proposées dans la zone de réponse du transcript : uniquement si le compte peut répondre
   * depuis le panel (droit « reply-live ») ; null sinon.
   */
  async function snippetsFor(req, guild) {
    const allowed = await access.check(req, guild, 'reply-live').then(() => true, () => false);
    if (!allowed) return null;
    return (await tickets.listSnippets(guild.id)).map((s) => ({ name: s.name, content: s.content }));
  }

  /** Pièce jointe : 404 si inconnue, puis même droit que le transcript sur le serveur auquel elle appartient. */
  async function checkAttachment(req, attachment) {
    if (!attachment) throw new HttpError(404, 'Pièce jointe introuvable (peut-être trop volumineuse pour avoir été conservée).');
    const guild = ctx.client.guilds.cache.get(String(attachment.guild_id));
    if (!guild) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    await access.check(req, guild, 'view-transcripts');
    // Même portée que le transcript : pas de pièce jointe d'un ticket / fil que ce compte ne peut pas voir.
    if (attachment.ticket_id) {
      const ticket = await tickets.getTicket(attachment.ticket_id);
      if (!ticket) throw new HttpError(404, 'Ticket introuvable');
      await assertTicketVisible(req, guild, ticket);
    } else if (attachment.thread_id) {
      const thread = await tickets.getModmailThread(attachment.thread_id);
      if (!thread) throw new HttpError(404, 'Fil modmail introuvable');
      await assertThreadVisible(req, guild, thread);
    }
  }

  function sendAttachment(req, res, attachment) {
    const data = attachment.data;
    const type = String(attachment.content_type || '').trim();
    const inline = INLINE_TYPES.test(type);
    const asciiName = String(attachment.name || 'fichier').replace(/[^\w.-]+/g, '_');
    res.set('Content-Type', inline ? type : 'application/octet-stream');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name || 'fichier')}`);
    // Même affiché, le fichier est isolé : aucun script, aucune requête vers le dashboard.
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');
    // Les lecteurs vidéo demandent des plages d'octets (Range) : sans réponse 206, la lecture ne démarre pas.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      if (start > end || start >= data.length) {
        res.status(416).set('Content-Range', `bytes */${data.length}`).end();
        return;
      }
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1) });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.send(data);
  }

  router.get(
    '/api/attachments/:id',
    wrap(async (req, res) => {
      const attachment = await tickets.getAttachment(req.params.id);
      await checkAttachment(req, attachment);
      sendAttachment(req, res, attachment);
    }),
  );

  router.get(
    '/api/modmail-attachments/:id',
    wrap(async (req, res) => {
      const attachment = await tickets.getModmailAttachment(req.params.id);
      await checkAttachment(req, attachment);
      sendAttachment(req, res, attachment);
    }),
  );

  router.get(
    '/api/tickets/:id',
    wrap(async (req, res) => {
      const { guild, ticket } = await ticketWithGuild(req, req.params.id, 'view-transcripts');
      const [{ json, type }, messages, snippets, canManage] = await Promise.all([
        singleTicketJson(guild, ticket),
        tickets.listMessages(ticket.id),
        snippetsFor(req, guild),
        access.check(req, guild, 'manage-tickets').then(() => true, () => false),
      ]);
      res.json({
        ticket: json,
        canManage, // boutons prendre en charge / fermer de la page transcript
        liveTranscript: Boolean(type?.live_transcript),
        messages: messages.map(messageJson),
        mentions: await resolveMentions(guild, messages),
        snippets,
        serverTime: new Date().toISOString(),
      });
    }),
  );

  // Transcript live : uniquement les messages nouveaux (id > after) ou modifiés depuis `since`.
  router.get(
    '/api/tickets/:id/messages',
    wrap(async (req, res) => {
      const serverTime = new Date();
      const { guild, ticket } = await ticketWithGuild(req, req.params.id, 'view-transcripts');
      const after = Number(req.query.after ?? 0) || 0;
      const since = req.query.since ? new Date(String(req.query.since)) : null;
      const messages = await tickets.listMessages(ticket.id, { after, since: since && !Number.isNaN(since.getTime()) ? since : null });
      const { json } = await singleTicketJson(guild, ticket);
      res.json({ ticket: json, messages: messages.map(messageJson), mentions: await resolveMentions(guild, messages), serverTime: serverTime.toISOString() });
    }),
  );

  router.post(
    '/api/tickets/:id/messages',
    wrap(async (req, res) => {
      const { guild, ticket } = await ticketWithGuild(req, req.params.id, 'reply-live');
      if (ticket.status !== 'open') throw new HttpError(409, 'Ce ticket est fermé.');
      const type = await tickets.getType(ticket.type_id);
      if (!type?.live_transcript) throw new HttpError(409, 'Le transcript live n’est pas activé pour ce type de ticket.');
      const raw = String(req.body?.content ?? '').trim();
      if (!raw) throw new HttpError(400, 'Message vide.');
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (!channel?.isTextBased()) throw new HttpError(404, 'Salon introuvable.');

      const webUser = webUserOf(req);
      const blocked = claimBlock(type, ticket, webUser.id);
      if (blocked) throw new HttpError(409, blocked.replace(/<@(\d+)>/, (_, id) => person(guild, id).name));
      // Une réponse prédéfinie insérée depuis le panel garde ses placeholders ({user}, {ticket}…) jusqu'ici.
      const content = fillSnippet(raw, { ticket, type, staffId: webUser.id }).slice(0, 1900);
      const sent = await sendAsWebUser(ctx, ticket, channel, webUser, content);
      await tickets.appendMessage({
        ticketId: ticket.id,
        messageId: sent.id,
        authorId: webUser.id,
        authorName: webUser.name,
        authorAvatar: webUser.avatar,
        authorBot: false,
        content,
        viaWeb: true,
        createdAt: new Date(),
      });
      // Envoyé par webhook (ignoré par l'écouteur de messages) : compte ici comme réponse du staff (reping, clôture).
      await tickets.touchActivity(ticket.id, { isStaff: true, isOpener: false });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/api/tickets/:id/close',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-tickets');
      const ticket = await ticketOf(req, guild, req.params.id);
      if (ticket.status !== 'open') throw new HttpError(409, 'Ce ticket est déjà fermé.');
      const type = await tickets.getType(ticket.type_id);
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (!channel) throw new HttpError(404, 'Salon introuvable.');
      const webUser = webUserOf(req);
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : `Fermé depuis le panel web par ${webUser.name}`;
      await closeTicket(ctx, { ticket, type, channel, closedBy: webUser.id, reason });
      res.json(await stateJson(req, guild));
    }),
  );

  // Prendre en charge / relâcher (mêmes effets que les boutons Discord : nom du salon, journal, boutons du message).
  router.post(
    '/api/tickets/:id/claim',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-tickets');
      const ticket = await ticketOf(req, guild, req.params.id);
      if (ticket.status !== 'open') throw new HttpError(409, 'Ce ticket n’est plus ouvert.');
      const claiming = req.body?.claiming !== false;
      if (claiming && ticket.claimed_by) throw new HttpError(409, 'Ce ticket est déjà pris en charge : relâche-le d’abord.');
      if (!claiming && !ticket.claimed_by) throw new HttpError(409, 'Ce ticket n’est pas pris en charge.');
      const type = await tickets.getType(ticket.type_id);
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (!channel?.isTextBased()) throw new HttpError(404, 'Salon introuvable.');
      await setClaim(ctx, { ticket, type, channel, userId: webUserOf(req).id, claiming });
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/tickets/:id/reopen',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-tickets');
      const ticket = await ticketOf(req, guild, req.params.id);
      if (ticket.status !== 'closed') throw new HttpError(409, 'Ce ticket n’est pas fermé.');
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (!channel) throw new HttpError(404, 'Salon introuvable.');
      await reopenTicket(ctx, { ticket, channel, executorId: webUserOf(req).id });
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/tickets/:id/channel',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-tickets');
      const ticket = await ticketOf(req, guild, req.params.id);
      if (ticket.status !== 'closed') throw new HttpError(409, 'Ferme d’abord ce ticket avant de supprimer son salon.');
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (channel) {
        const type = await tickets.getType(ticket.type_id);
        await deleteTicket(ctx, { ticket, type, channel, executorId: webUserOf(req).id });
      }
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Modmail : fils + transcript ─────────────────────────────────────────

  router.get(
    '/api/modmail/closed',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view-tickets');
      const rows = await tickets.listModmailThreads(guild.id, { status: 'closed', limit: 100 });
      const viewer = await viewerOf(req, guild);
      const categories = viewer.admin ? null : await modmailCategoriesIndex(guild);
      res.json(rows.filter((t) => canViewThread(viewer, t, categories)).map((t) => modmailThreadJson(guild, t)));
    }),
  );

  router.get(
    '/api/modmail/:id',
    wrap(async (req, res) => {
      const { guild, thread } = await modmailWithGuild(req, req.params.id, 'view-transcripts');
      const [messages, snippets] = await Promise.all([tickets.listModmailMessages(thread.id), snippetsFor(req, guild)]);
      res.json({
        thread: modmailThreadJson(guild, thread),
        messages: messages.map(modmailMessageJson),
        mentions: await resolveMentions(guild, messages),
        // Réponse depuis le panel possible tant que le fil est ouvert, avec le droit « répondre depuis le panel ».
        canReply: thread.status === 'open' && Boolean(snippets),
        snippets: snippets ?? [],
        serverTime: new Date().toISOString(),
      });
    }),
  );

  // Réponse au membre depuis le panel web (MP, copie dans le salon du fil, transcript), anonyme ou non.
  router.post(
    '/api/modmail/:id/messages',
    wrap(async (req, res) => {
      const { guild, thread } = await modmailWithGuild(req, req.params.id, 'reply-live');
      if (thread.status !== 'open') throw new HttpError(409, 'Ce fil est fermé.');
      const content = String(req.body?.content ?? '').trim().slice(0, 2000);
      if (!content) throw new HttpError(400, 'Message vide.');
      const webUser = webUserOf(req);
      const member = guild.members.cache.get(webUser.id) ?? (await guild.members.fetch(webUser.id).catch(() => null));
      const { delivered, error } = await staffReply(ctx, thread, {
        authorId: webUser.id,
        authorName: member?.displayName ?? webUser.name,
        authorAvatar: webUser.avatar,
        member,
        content: fillSnippet(content, { staffId: webUser.id, userId: String(thread.user_id) }),
        anonymous: req.body?.anonymous === true,
        viaWeb: true,
      });
      if (error) throw new HttpError(409, error);
      res.json({ ok: true, delivered });
    }),
  );

  // Fermeture d'un fil depuis le panel (indispensable pour les catégories « panel uniquement », sans salon Discord).
  router.post(
    '/api/modmail/:id/close',
    wrap(async (req, res) => {
      const { thread } = await modmailWithGuild(req, req.params.id, 'manage-tickets');
      if (thread.status !== 'open') throw new HttpError(409, 'Ce fil est déjà fermé.');
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 512) : null;
      await closeModmail(ctx, thread, { closedBy: req.session.user.id, reason: reason ? `${reason} (panel web)` : 'Fermé depuis le panel web', notifyUser: true });
      res.json({ ok: true });
    }),
  );

  router.get(
    '/api/modmail/:id/messages',
    wrap(async (req, res) => {
      const serverTime = new Date();
      const { guild, thread } = await modmailWithGuild(req, req.params.id, 'view-transcripts');
      const after = Number(req.query.after ?? 0) || 0;
      const messages = await tickets.listModmailMessages(thread.id, { after });
      res.json({ thread: modmailThreadJson(guild, thread), messages: messages.map(modmailMessageJson), mentions: await resolveMentions(guild, messages), serverTime: serverTime.toISOString() });
    }),
  );
};
