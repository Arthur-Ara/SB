'use strict';

const path = require('node:path');
const express = require('express');
const { ChannelType } = require('discord.js');
const { HttpError, wrap, isSnowflake, avatarUrl, hexColor, imageUrl, textChannelId } = require('../../../src/web/helpers');
const { guildAccess, memberOf } = require('../../permissions/lib/webAccess');
const { STATUSES, RECRUITER_STATUSES, FINAL_STATUSES, isFinal, statusLabel } = require('../lib/statuses');
const { normalizeQuestions, MAX_QUESTIONS } = require('../lib/form');
const { normalizeCriteria } = require('../lib/criteria');
const { isAdmin } = require('../lib/guard');
const { publishPanel, setStatus, changeCategory, deleteChannel, sendLog } = require('../lib/lifecycle');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGE_SIZE = 50;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);
const MAX_AUTO_REPLY = 1500;

function roleIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(isSnowflake))] : [];
}

function intOrNull(value, label, max = 36500) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${label} : nombre entier de 1 à ${max} attendu (ou vide).`);
  return n;
}

/** Interface web du module Candidature (/m/candidature/) : candidatures en cours, historique, catégories, réglages. */
module.exports = function registerWeb(router, ctx) {
  const { candidatures } = ctx.services;
  const access = guildAccess(ctx, { module: 'candidature', category: 'candidature', label: 'Candidatures' });

  function webUserOf(req) {
    const user = req.session.user;
    return { id: user.id, name: user.globalName || user.username };
  }

  function person(guild, userId) {
    if (!userId) return null;
    const member = guild.members.cache.get(String(userId));
    const user = member?.user ?? ctx.client.users.cache.get(String(userId));
    return {
      id: String(userId),
      name: member?.nickname || user?.globalName || user?.username || String(userId),
      username: user?.username ?? null,
      avatar: avatarUrl(String(userId), user?.avatar ?? null),
      inGuild: Boolean(member),
    };
  }

  // ── Portée de lecture : un recruteur ne voit que les catégories dont il est recruteur (admin : tout) ──
  async function viewerOf(req, guild, categories) {
    const userId = req.session.user.id;
    const member = await memberOf(guild, userId);
    const admin = ctx.config.owners.has(userId) || isAdmin(ctx, member);
    const visible = categories.filter((c) => admin || (member && c.recruiter_role_ids.some((id) => member.roles.cache.has(id))));
    return { userId, member, admin, categoryIds: new Set(visible.map((c) => String(c.id))) };
  }

  const canSee = (viewer, candidature) => viewer.admin || viewer.categoryIds.has(String(candidature.category_id));

  async function categoryOf(guild, id) {
    const category = await candidatures.getCategory(id);
    if (!category || String(category.guild_id) !== guild.id) throw new HttpError(404, 'Catégorie introuvable');
    return category;
  }

  /** Candidature du serveur visible par ce compte. */
  async function candidatureOf(req, guild, id) {
    const candidature = await candidatures.getCandidature(id);
    if (!candidature || String(candidature.guild_id) !== guild.id) throw new HttpError(404, 'Candidature introuvable');
    const viewer = await viewerOf(req, guild, await candidatures.listCategories(guild.id));
    if (!canSee(viewer, candidature)) throw new HttpError(403, 'Cette candidature ne fait pas partie de celles que tu peux voir (recruteur de sa catégorie requis).');
    return candidature;
  }

  /** Candidature + serveur sans `?guild=` (page transcription ouverte par lien direct), droit et portée vérifiés. */
  async function candidatureWithGuild(req, id, right) {
    const candidature = await candidatures.getCandidature(id);
    if (!candidature) throw new HttpError(404, 'Candidature introuvable');
    const guild = ctx.client.guilds.cache.get(String(candidature.guild_id));
    if (!guild) throw new HttpError(404, 'Serveur inconnu (le bot n’y est plus)');
    await access.check(req, guild, right);
    const viewer = await viewerOf(req, guild, await candidatures.listCategories(guild.id));
    if (!canSee(viewer, candidature)) throw new HttpError(403, 'Cette candidature ne fait pas partie de celles que tu peux voir (recruteur de sa catégorie requis).');
    return { guild, candidature };
  }

  function categoryJson(c) {
    return {
      id: c.id,
      label: c.label,
      emoji: c.emoji,
      buttonStyle: c.button_style,
      selectDescription: c.select_description,
      categoryId: c.category_id ? String(c.category_id) : null,
      recruiterRoleIds: c.recruiter_role_ids,
      notifyRoleIds: c.notify_role_ids,
      maxOpen: c.max_open,
      cooldownDays: c.cooldown_days,
      acceptRoleId: c.accept_role_id ? String(c.accept_role_id) : null,
      channelNamePattern: c.channel_name_pattern,
      autoCheck: Boolean(Number(c.auto_check)),
      criteria: c.criteria,
      formEnabled: Boolean(Number(c.form_enabled)),
      formTitle: c.form_title,
      formQuestions: c.form_questions,
      openedTitle: c.opened_title,
      openedDescription: c.opened_description,
      openedColor: c.opened_color,
      openedFooter: c.opened_footer,
      openedImage: c.opened_image,
      openedThumbnail: c.opened_thumbnail,
    };
  }

  function candidatureJson(guild, c, categoriesById) {
    return {
      id: c.id,
      categoryId: c.category_id,
      categoryLabel: categoriesById.get(String(c.category_id))?.label ?? 'Catégorie supprimée',
      applicant: person(guild, c.applicant_id),
      status: c.status,
      statusLabel: statusLabel(c.status),
      final: isFinal(c.status),
      reason: c.status_reason,
      statusBy: c.status_by ? person(guild, c.status_by) : null,
      auto: !c.status_by && isFinal(c.status) && c.status !== 'withdrawn',
      statusAt: c.status_at,
      createdAt: c.created_at,
      submittedAt: c.submitted_at,
      closedAt: c.closed_at,
      channelId: String(c.channel_id),
      channelExists: !Number(c.channel_deleted) && guild.channels.cache.has(String(c.channel_id)),
      failures: c.check_failures,
    };
  }

  async function stateJson(req, guild) {
    const [settings, categories, active] = await Promise.all([candidatures.settings(guild.id), candidatures.listCategories(guild.id), candidatures.listActive(guild.id)]);
    const viewer = await viewerOf(req, guild, categories);
    const byId = new Map(categories.map((c) => [String(c.id), c]));
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      viewerAdmin: viewer.admin,
      statuses: Object.entries(STATUSES).map(([key, def]) => ({ key, label: def.label, emoji: def.emoji, final: def.final, recruiter: RECRUITER_STATUSES.includes(key) })),
      settings,
      categories: categories.map(categoryJson),
      // Un bloc par catégorie visible (même vide), puis les candidatures en cours de ces catégories.
      visibleCategoryIds: [...viewer.categoryIds].map(Number),
      candidatures: active.filter((c) => canSee(viewer, c)).map((c) => candidatureJson(guild, c, byId)),
      maxQuestions: MAX_QUESTIONS,
      textChannels: [...guild.channels.cache.values()].filter((c) => TEXT_TYPES.has(c.type)).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name })),
      discordCategories: [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name })),
      roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null })),
    };
  }

  function logWeb(req, guild, text) {
    return sendLog(ctx, guild, [`🌐 **${webUserOf(req).name}** (panel web) — ${text}`]);
  }

  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'candidature.html')));
  router.get('/transcript', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'transcript.html')));

  router.get('/api/guilds', wrap(async (req, res) => res.json(await access.guilds(req))));
  router.get('/api/state', wrap(async (req, res) => res.json(await stateJson(req, await access.guild(req, 'view-candidatures')))));

  // ── Réglages ─────────────────────────────────────────────────────────────

  router.post(
    '/api/settings',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const body = req.body ?? {};
      const patch = {};
      if ('logChannelId' in body) patch.log_channel_id = textChannelId(guild, body.logChannelId);
      if ('refusalReasonRequired' in body) patch.refusal_reason_required = body.refusalReasonRequired ? 1 : 0;
      if ('autoReplies' in body) {
        const replies = {};
        for (const key of RECRUITER_STATUSES.concat(['withdrawn'])) {
          const entry = body.autoReplies?.[key];
          const message = String(entry?.message ?? '').trim().slice(0, MAX_AUTO_REPLY);
          if (message) replies[key] = { message, dm: Boolean(entry?.dm) };
        }
        patch.auto_replies = replies;
      }
      await candidatures.updateSettings(guild.id, patch);
      await logWeb(req, guild, 'réglages des candidatures modifiés');
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/panel',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const body = req.body ?? {};
      const patch = {};
      if ('style' in body) patch.panel_style = body.style === 'select' ? 'select' : 'buttons';
      if ('title' in body) patch.panel_title = body.title ? String(body.title).slice(0, 256) : null;
      if ('description' in body) patch.panel_description = body.description ? String(body.description).slice(0, 4096) : null;
      if ('color' in body) patch.panel_color = hexColor(body.color);
      if ('footer' in body) patch.panel_footer = body.footer ? String(body.footer).slice(0, 2048) : null;
      if ('image' in body) patch.panel_image = imageUrl(body.image, 'Image');
      if ('thumbnail' in body) patch.panel_thumbnail = imageUrl(body.thumbnail, 'Vignette');
      await candidatures.updateSettings(guild.id, patch);
      ctx.services.refreshPanel(guild).catch(() => {});
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/panel/publish',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const channelId = textChannelId(guild, req.body?.channelId);
      if (!channelId) throw new HttpError(400, 'Choisis un salon.');
      const result = await publishPanel(ctx, guild, guild.channels.cache.get(channelId)).catch((err) => ({ error: err.message }));
      if (result.error) throw new HttpError(400, result.error);
      await logWeb(req, guild, `panel de candidatures publié dans <#${channelId}>`);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Catégories ───────────────────────────────────────────────────────────

  router.post(
    '/api/categories',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const label = String(req.body?.label ?? 'Nouvelle catégorie').trim().slice(0, 80) || 'Nouvelle catégorie';
      await candidatures.createCategory(guild.id, label);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/categories/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const category = await categoryOf(guild, req.params.id);
      const body = req.body ?? {};
      const patch = {};
      const text = (key, column, max) => {
        if (key in body) patch[column] = body[key] ? String(body[key]).trim().slice(0, max) || null : null;
      };
      if ('label' in body) {
        const label = String(body.label ?? '').trim().slice(0, 80);
        if (!label) throw new HttpError(400, 'Le nom de la catégorie est obligatoire.');
        patch.label = label;
      }
      text('emoji', 'emoji', 64);
      text('selectDescription', 'select_description', 100);
      text('channelNamePattern', 'channel_name_pattern', 100);
      text('formTitle', 'form_title', 45);
      text('openedTitle', 'opened_title', 256);
      text('openedDescription', 'opened_description', 4096);
      text('openedFooter', 'opened_footer', 2048);
      if ('buttonStyle' in body) patch.button_style = BUTTON_STYLES.has(body.buttonStyle) ? body.buttonStyle : 'primary';
      if ('categoryId' in body) {
        const id = body.categoryId ? String(body.categoryId) : null;
        if (id && guild.channels.cache.get(id)?.type !== ChannelType.GuildCategory) throw new HttpError(400, 'Catégorie Discord introuvable.');
        patch.category_id = id;
      }
      if ('recruiterRoleIds' in body) patch.recruiter_role_ids = roleIds(body.recruiterRoleIds).filter((id) => guild.roles.cache.has(id));
      if ('notifyRoleIds' in body) patch.notify_role_ids = roleIds(body.notifyRoleIds).filter((id) => guild.roles.cache.has(id));
      if ('acceptRoleId' in body) {
        const id = body.acceptRoleId ? String(body.acceptRoleId) : null;
        if (id && !guild.roles.cache.has(id)) throw new HttpError(400, 'Rôle d’acceptation introuvable.');
        patch.accept_role_id = id;
      }
      if ('maxOpen' in body) patch.max_open = intOrNull(body.maxOpen, 'Maximum de candidatures en cours', 1000);
      if ('cooldownDays' in body) patch.cooldown_days = intOrNull(body.cooldownDays, 'Délai de représentation (jours)');
      if ('autoCheck' in body) patch.auto_check = body.autoCheck ? 1 : 0;
      if ('criteria' in body) patch.criteria = normalizeCriteria(body.criteria);
      if ('formEnabled' in body) patch.form_enabled = body.formEnabled ? 1 : 0;
      if ('formQuestions' in body) patch.form_questions = normalizeQuestions(body.formQuestions);
      if ('openedColor' in body) patch.opened_color = hexColor(body.openedColor);
      if ('openedImage' in body) patch.opened_image = imageUrl(body.openedImage, 'Image');
      if ('openedThumbnail' in body) patch.opened_thumbnail = imageUrl(body.openedThumbnail, 'Vignette');
      await candidatures.updateCategory(category.id, patch);
      await logWeb(req, guild, `catégorie de candidature **${patch.label ?? category.label}** modifiée`);
      ctx.services.refreshPanel(guild).catch(() => {});
      res.json(await stateJson(req, guild));
    }),
  );

  router.delete(
    '/api/categories/:id',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-settings');
      const category = await categoryOf(guild, req.params.id);
      if ((await candidatures.activeCountForCategory(category.id)) > 0) throw new HttpError(409, 'Des candidatures sont encore en cours dans cette catégorie : clôture-les ou déplace-les d’abord.');
      await candidatures.deleteCategory(category.id);
      await logWeb(req, guild, `catégorie de candidature **${category.label}** supprimée`);
      ctx.services.refreshPanel(guild).catch(() => {});
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Candidatures ─────────────────────────────────────────────────────────

  // Historique / recherche : toutes les candidatures (ou seulement les clôturées) avec leurs issues et motifs.
  router.get(
    '/api/candidatures/search',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'view-candidatures');
      const idParam = (key) => {
        const value = req.query[key] ? String(req.query[key]).trim() : null;
        if (value && !isSnowflake(value)) throw new HttpError(400, 'ID Discord invalide (17 à 20 chiffres)');
        return value;
      };
      const categories = await candidatures.listCategories(guild.id);
      const viewer = await viewerOf(req, guild, categories);
      const status = req.query.status && STATUSES[req.query.status] ? String(req.query.status) : null;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const { rows, total } = await candidatures.search(guild.id, {
        scope: req.query.scope === 'all' ? 'all' : 'closed',
        applicantId: idParam('applicant'),
        status,
        categoryId: req.query.category ? Number(req.query.category) || null : null,
        categoryIds: viewer.admin ? null : [...viewer.categoryIds].map(Number),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      const byId = new Map(categories.map((c) => [String(c.id), c]));
      res.json({ page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, rows: rows.map((c) => candidatureJson(guild, c, byId)) });
    }),
  );

  router.get(
    '/api/candidatures/:id',
    wrap(async (req, res) => {
      const { guild, candidature } = await candidatureWithGuild(req, req.params.id, 'view-transcripts');
      const [messages, events, categories, canManage] = await Promise.all([
        candidatures.listMessages(candidature.id),
        candidatures.listEvents(candidature.id),
        candidatures.listCategories(guild.id),
        access.check(req, guild, 'manage-candidatures').then(() => true, () => false),
      ]);
      const byId = new Map(categories.map((c) => [String(c.id), c]));
      res.json({
        candidature: candidatureJson(guild, candidature, byId),
        formAnswers: candidature.form_answers,
        events: events.map((e) => ({ id: e.id, kind: e.kind, status: e.status, statusLabel: e.status ? statusLabel(e.status) : null, actor: e.actor_id ? person(guild, e.actor_id) : null, detail: e.detail, at: e.created_at })),
        messages: messages.map((m) => ({
          id: m.id,
          authorId: String(m.author_id),
          authorName: m.author_name,
          authorAvatar: m.author_avatar,
          authorColor: m.author_role_color,
          bot: Boolean(Number(m.author_bot)),
          content: m.content,
          embeds: m.embeds,
          attachments: m.attachments,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        })),
        canManage,
        categories: canManage ? categories.filter((c) => c.id !== candidature.category_id).map((c) => ({ id: c.id, label: c.label })) : [],
        statuses: RECRUITER_STATUSES.map((key) => ({ key, label: STATUSES[key].label, emoji: STATUSES[key].emoji })),
        guildId: guild.id,
      });
    }),
  );

  router.post(
    '/api/candidatures/:id/status',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-candidatures');
      const candidature = await candidatureOf(req, guild, req.params.id);
      const status = String(req.body?.status ?? '');
      if (!RECRUITER_STATUSES.includes(status)) throw new HttpError(400, 'Statut inconnu.');
      const category = await candidatures.getCategory(candidature.category_id);
      const channel = guild.channels.cache.get(String(candidature.channel_id)) ?? null;
      const result = await setStatus(ctx, { candidature, category, guild, channel: Number(candidature.channel_deleted) ? null : channel, status, reason: req.body?.reason, by: req.session.user.id });
      if (result.error) throw new HttpError(400, result.error);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/candidatures/:id/category',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-candidatures');
      const candidature = await candidatureOf(req, guild, req.params.id);
      const target = await categoryOf(guild, req.body?.categoryId);
      const from = await candidatures.getCategory(candidature.category_id);
      const channel = guild.channels.cache.get(String(candidature.channel_id)) ?? null;
      const result = await changeCategory(ctx, { candidature, fromCategory: from, toCategory: target, guild, channel: Number(candidature.channel_deleted) ? null : channel, by: req.session.user.id });
      if (result.error) throw new HttpError(400, result.error);
      res.json(await stateJson(req, guild));
    }),
  );

  router.post(
    '/api/candidatures/:id/delete-channel',
    wrap(async (req, res) => {
      const guild = await access.guild(req, 'manage-candidatures');
      const candidature = await candidatureOf(req, guild, req.params.id);
      if (Number(candidature.channel_deleted)) throw new HttpError(409, 'Le salon est déjà supprimé.');
      const channel = guild.channels.cache.get(String(candidature.channel_id)) ?? null;
      const result = await deleteChannel(ctx, { candidature, channel, executorId: req.session.user.id });
      if (result.error) throw new HttpError(400, result.error);
      res.json(await stateJson(req, guild));
    }),
  );

  // ── Pièces jointes (copies conservées en base) ───────────────────────────

  const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|x-m4a))\s*(;|$)/i;

  router.get(
    '/api/attachments/:id',
    wrap(async (req, res) => {
      const attachment = await candidatures.getAttachment(req.params.id);
      if (!attachment) throw new HttpError(404, 'Pièce jointe introuvable (peut-être trop volumineuse pour avoir été conservée).');
      await candidatureWithGuild(req, attachment.candidature_id, 'view-transcripts');
      const type = String(attachment.content_type || '').trim();
      const inline = INLINE_TYPES.test(type);
      const asciiName = String(attachment.name || 'fichier').replace(/[^\w.-]+/g, '_');
      res.set('Content-Type', inline ? type : 'application/octet-stream');
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name || 'fichier')}`);
      // Même affiché, le fichier est isolé : aucun script, aucune requête vers le dashboard.
      res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(attachment.data);
    }),
  );
};
