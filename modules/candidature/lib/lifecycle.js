'use strict';

const { ChannelType, Routes } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { KeyedMutex } = require('../../../src/core/keyedMutex');
const { webUrl } = require('../../../src/web/url');
const { buildEmbed } = require('../../tickets/lib/embed');
const { ticketChannelName } = require('../../tickets/lib/channelName');
const { STATUSES, isFinal, statusLabel, timeline } = require('./statuses');
const { createSingleUseInvite, giveAcceptRoles } = require('./acceptance');
const { panelComponents, controls, categorySelect } = require('./components');

const DAY_MS = 24 * 60 * 60 * 1000;
const APPLICANT_PERMISSIONS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'];
const RECRUITER_PERMISSIONS = [...APPLICANT_PERMISSIONS, 'ManageMessages'];

const openLocks = new KeyedMutex();

/** Lien vers la transcription de la candidature sur le panel web (null si le panel est indisponible). */
function transcriptUrl(ctx, candidature) {
  return webUrl(ctx.config, `m/candidature/transcript?candidature=${candidature.id}`);
}

/** Remplace {user} {username} {category} {id} {number} {status} {reason} {server} {retry} {recruiters} ({invite} à l'acceptation) dans un texte libre. */
function fill(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

/** Date à partir de laquelle le candidat peut se représenter après un refus (null = tout de suite). */
function retryDate(category, from = new Date()) {
  const days = Number(category?.cooldown_days ?? 0);
  return days > 0 ? new Date(from.getTime() + days * DAY_MS) : null;
}

function retryText(category, from) {
  const date = retryDate(category, from);
  return date ? `Tu pourras te représenter ${ui.ts(date, 'R')} (${ui.ts(date, 'D')}).` : 'Tu peux te représenter dès maintenant.';
}

function placeholdersOf(guild, category, candidature, extra = {}) {
  const user = guild.members.cache.get(String(candidature.applicant_id))?.user ?? guild.client.users.cache.get(String(candidature.applicant_id));
  return {
    user: `<@${candidature.applicant_id}>`,
    username: user?.username ?? 'candidat',
    category: category?.label ?? '',
    id: `#${candidature.id}`,
    number: String(candidature.id).padStart(4, '0'),
    status: statusLabel(candidature.status),
    reason: candidature.status_reason ?? '',
    server: guild.name,
    retry: category ? retryText(category) : '',
    recruiters: (category?.recruiter_role_ids ?? []).map((id) => `<@&${id}>`).join(' ') || '—',
    ...extra,
  };
}

/** Déplace un salon sans passer par `channel.setParent()` (qui renvoie `name` et attend la file des renommages). */
async function moveChannel(channel, parentId, reason) {
  if (!parentId || channel.parentId === String(parentId)) return false;
  await channel.client.rest.patch(Routes.channel(channel.id), { body: { parent_id: String(parentId), lock_permissions: false }, reason });
  return true;
}

async function sendLog(ctx, guild, lines) {
  const { logChannelId } = await ctx.services.candidatures.settings(guild.id);
  if (!logChannelId) return;
  try {
    const channel = ctx.client.channels.cache.get(logChannelId) ?? (await ctx.client.channels.fetch(logChannelId));
    if (channel?.isTextBased()) await channel.send({ ...ui.payload(ui.card({ description: lines.filter(Boolean).join('\n'), timestamp: true })), allowedMentions: { parse: [] } });
  } catch (err) {
    ctx.logger.warn(`Journal des candidatures indisponible (salon ${logChannelId})`, err.message);
  }
}

// ── Panels ──────────────────────────────────────────────────────────────────

function panelPayload(panel, categories) {
  const embed = buildEmbed({
    title: panel.title || 'Candidatures',
    description: panel.description || 'Choisis la candidature que tu souhaites déposer : un salon privé est créé pour la rédiger et suivre son avancement.',
    color: panel.color,
    footer: panel.footer,
    image: panel.image,
    thumbnail: panel.thumbnail,
  });
  return { embeds: [embed], components: panelComponents(categories, panel.style) };
}

async function panelMessage(ctx, panel) {
  if (!panel.channel_id || !panel.message_id) return null;
  const channel = ctx.client.channels.cache.get(String(panel.channel_id));
  return channel?.messages ? channel.messages.fetch(String(panel.message_id)).catch(() => null) : null;
}

/** Publie (ou republie) un panel dans un salon : son ancien message est supprimé, un panel n'a qu'un message. */
async function publishPanel(ctx, guild, panel, channel) {
  const { candidatures } = ctx.services;
  const categories = await candidatures.listPanelCategories(panel.id);
  if (!categories.length) return { error: 'Ajoute au moins une catégorie de candidature à ce panel avant de le publier.' };
  const old = await panelMessage(ctx, panel);
  await old?.delete().catch(() => {});
  const message = await channel.send(panelPayload(panel, categories));
  await candidatures.updatePanel(panel.id, { channel_id: channel.id, message_id: message.id });
  return { message };
}

/** Met à jour le message publié d'un panel (catégories ajoutées, renommées, supprimées) sans le republier. */
async function refreshPanel(ctx, panelId) {
  const { candidatures } = ctx.services;
  const panel = await candidatures.getPanel(panelId);
  const message = panel ? await panelMessage(ctx, panel) : null;
  if (!message) return;
  const categories = await candidatures.listPanelCategories(panel.id);
  await message.edit(categories.length ? panelPayload(panel, categories) : { components: [] }).catch(() => {});
}

/** Supprime le message publié d'un panel (avant la suppression du panel). */
async function unpublishPanel(ctx, panel) {
  const message = await panelMessage(ctx, panel);
  await message?.delete().catch(() => {});
}

// ── Ouverture ───────────────────────────────────────────────────────────────

async function openProblem(ctx, { category, guild, user }) {
  const { candidatures } = ctx.services;
  const parent = category.category_id ? guild.channels.cache.get(String(category.category_id)) : null;
  if (!parent) return 'Cette candidature n’est pas configurée correctement (catégorie Discord manquante) : contacte un administrateur.';

  const active = await candidatures.activeForUser(category.id, user.id);
  if (active) return `Tu as déjà une candidature en cours pour **${category.label}** : <#${active.channel_id}>`;

  const refusal = Number(category.cooldown_days) > 0 ? await candidatures.lastRefusal(category.id, user.id) : null;
  const retry = refusal ? retryDate(category, new Date(refusal.status_at)) : null;
  if (retry && retry > new Date()) return `Ta précédente candidature a été refusée : tu pourras te représenter ${ui.ts(retry, 'R')} (${ui.ts(retry, 'D')}).`;

  if (category.max_open && (await candidatures.activeCountForCategory(category.id)) >= category.max_open) return 'Le nombre maximum de candidatures en cours pour cette catégorie est atteint, réessaie plus tard.';
  return null;
}

/** Message d'accueil : le « modèle » de la catégorie (embed configurable) ou, à défaut, un texte par défaut. */
function welcomeEmbed(guild, category, candidature) {
  const values = placeholdersOf(guild, category, candidature);
  return (
    buildEmbed(
      { title: category.opened_title, description: category.opened_description, color: category.opened_color, footer: category.opened_footer, image: category.opened_image, thumbnail: category.opened_thumbnail },
      values,
    ) ??
    buildEmbed(
      {
        title: `Candidature ${category.label}`,
        description: 'Rédige ta candidature dans ce salon (texte, captures, fichiers), puis clique sur **✅ Terminer ma candidature**. Tu pourras suivre son avancement avec `/candidature status`.',
        color: category.opened_color,
      },
      values,
    )
  );
}

/** Ouvre une candidature : salon privé, enregistrement, message d'accueil (modèle de la catégorie). */
function openCandidature(ctx, { category, guild, user }) {
  return openLocks.run(`${category.id}:${user.id}`, async () => {
    const problem = await openProblem(ctx, { category, guild, user });
    if (problem) return { error: problem };
    const { candidatures } = ctx.services;

    const overwrites = [
      { id: guild.id, deny: ['ViewChannel'] },
      { id: user.id, allow: APPLICANT_PERMISSIONS },
      ...category.recruiter_role_ids.map((id) => ({ id, allow: RECRUITER_PERMISSIONS })),
    ];
    const channel = await guild.channels.create({
      name: `candidature-${user.username}`.slice(0, 90).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'candidature',
      type: ChannelType.GuildText,
      parent: String(category.category_id),
      permissionOverwrites: overwrites,
      reason: `Candidature de ${user.username}`,
    });

    let candidature;
    try {
      candidature = await candidatures.createCandidature({ guildId: guild.id, categoryId: category.id, channelId: channel.id, applicantId: user.id });
    } catch (err) {
      await channel.delete('Échec de la création de la candidature en base').catch(() => {});
      throw err;
    }
    await channel.setName(ticketChannelName(category.channel_name_pattern || 'candidature-{number}-{username}', { ticketId: candidature.id, username: user.username, typeLabel: category.label })).catch(() => {});

    const notify = (category.notify_role_ids.length ? category.notify_role_ids : category.recruiter_role_ids).map((id) => `<@&${id}>`).join(' ');
    const message = await channel.send({
      content: `<@${user.id}>${notify ? ` ${notify}` : ''}`,
      embeds: [welcomeEmbed(guild, category, candidature)],
      components: controls(candidature),
      allowedMentions: { parse: ['users', 'roles'] },
    });
    await candidatures.setControlMessage(candidature.id, message.id);

    await sendLog(ctx, guild, [`📨 **Candidature ouverte** — #${candidature.id}`, `👤 Candidat : <@${user.id}>`, `📂 Catégorie : ${category.label}`, `📍 Salon : <#${channel.id}>`]);
    return { candidature, channel };
  });
}

// ── Statut ──────────────────────────────────────────────────────────────────

/** Remet à jour les boutons du message d'accueil (statut courant, candidature terminée…). */
async function refreshControls(ctx, channel, candidature) {
  if (!candidature.control_message_id || !channel?.messages) return;
  const message = await channel.messages.fetch(String(candidature.control_message_id)).catch(() => null);
  await message?.edit({ components: controls(candidature, { transcriptUrl: transcriptUrl(ctx, candidature) }) }).catch(() => {});
}

async function dmApplicant(ctx, guild, candidature, lines) {
  const user = await ctx.client.users.fetch(String(candidature.applicant_id)).catch(() => null);
  if (!user) return false;
  const embed = ui.card({ title: `Candidature #${candidature.id} — ${guild.name}`, description: lines.filter(Boolean).join('\n'), timestamp: true });
  return user.send({ ...ui.payload(embed) }).then(() => true, () => false);
}

/**
 * Change le statut d'une candidature : enregistrement + historique, message dans le salon, message privé au candidat,
 * réponse automatique du statut (si configurée), journal, et — pour un statut final — verrouillage du salon et rôle
 * d'acceptation. `by` nul = décision automatique (salon supprimé à la main).
 * @returns {{ error?: string, candidature?: object }}
 */
async function setStatus(ctx, { candidature, category, guild, channel, status, reason = null, by = null }) {
  const { candidatures } = ctx.services;
  if (!STATUSES[status] || status === 'draft') return { error: 'Statut inconnu.' };
  if (isFinal(candidature.status)) return { error: `Cette candidature est déjà clôturée (${statusLabel(candidature.status)}).` };
  const settings = await candidatures.settings(guild.id);
  const cleanReason = reason ? String(reason).trim().slice(0, 1000) : null;
  if (status === 'refused' && by && settings.refusalReasonRequired && !cleanReason) return { error: 'Le refus doit être motivé : indique la raison.' };

  const final = isFinal(status);
  await candidatures.setStatus(candidature.id, { status, reason: cleanReason, by, final });
  const updated = { ...candidature, status, status_reason: cleanReason, status_by: by, status_at: new Date(), closed_at: final ? new Date() : null };

  const who = by ? `<@${by}>` : `<@${ctx.client.user.id}> (automatique)`;
  const lines = [`${STATUSES[status].emoji} **Statut : ${STATUSES[status].label}**`, `🛠️ Par : ${who}`];
  if (cleanReason) lines.push(`📝 ${status === 'refused' ? 'Motif' : 'Précision'} : ${cleanReason}`);
  if (status === 'refused') lines.push(`🔁 ${retryText(category)}`);
  if (status === 'accepted') lines.push('🎉 Félicitations !');
  lines.push('', timeline(status));

  if (channel) {
    await channel.send({ content: `<@${candidature.applicant_id}>`, ...ui.payload(ui.card({ description: lines.join('\n'), timestamp: true })), allowedMentions: { users: [String(candidature.applicant_id)] } }).catch(() => {});
    const reply = settings.autoReplies?.[status];
    if (reply?.message) await channel.send({ content: fill(reply.message, placeholdersOf(guild, category, updated)).slice(0, 2000), allowedMentions: { users: [String(candidature.applicant_id)] } }).catch(() => {});
    if (final) await channel.permissionOverwrites.edit(String(candidature.applicant_id), { SendMessages: false }).catch(() => {});
    await refreshControls(ctx, channel, updated);
  }

  // Acceptation : rôles, message privé de bienvenue et invitation à usage unique (voir acceptance.js).
  const acceptance = status === 'accepted' ? await accept(ctx, { guild, category, candidature: updated }) : { lines: [], log: [] };

  const reply = settings.autoReplies?.[status];
  const dmLines = [...lines.filter((line) => line !== ''), reply?.dm && reply.message ? `\n${fill(reply.message, placeholdersOf(guild, category, updated))}` : null, ...acceptance.lines];
  const delivered = by !== String(candidature.applicant_id) ? await dmApplicant(ctx, guild, updated, dmLines) : true;
  // Messages privés fermés : le message d'acceptation (lien, invitation) est posté dans le salon privé de la candidature.
  if (!delivered && acceptance.lines.length && channel) {
    await channel
      .send({ content: `<@${candidature.applicant_id}> (tes messages privés sont fermés)`, ...ui.payload(ui.card({ description: acceptance.lines.join('\n') })), allowedMentions: { users: [String(candidature.applicant_id)] } })
      .catch(() => {});
  }

  await sendLog(ctx, guild, [
    `${STATUSES[status].emoji} **Candidature #${candidature.id} — ${STATUSES[status].label}**`,
    `👤 Candidat : <@${candidature.applicant_id}>`,
    `📂 Catégorie : ${category?.label ?? '—'}`,
    `🛠️ Par : ${who}`,
    cleanReason ? `📝 ${cleanReason}` : null,
    ...acceptance.log,
  ]);
  return { candidature: updated };
}

/**
 * Effets de l'acceptation : rôles d'acceptation, message de bienvenue (placeholders + `{invite}`) et invitation à
 * usage unique vers le serveur configuré. Renvoie les lignes du message privé et du journal.
 */
async function accept(ctx, { guild, category, candidature }) {
  const lines = [];
  const log = [];
  const missing = await giveAcceptRoles(ctx, guild, category, candidature);
  if (category?.accept_role_ids?.length) log.push(missing.length ? `⚠️ Rôle(s) non donné(s) : ${missing.map((id) => `<@&${id}>`).join(' ')}` : `🏷️ Rôle(s) donné(s) : ${category.accept_role_ids.map((id) => `<@&${id}>`).join(' ')}`);

  const invite = await createSingleUseInvite(ctx, category, candidature).catch((err) => ({ error: err.message }));
  if (invite.error) {
    log.push(`⚠️ Invitation non générée : ${invite.error}`);
    ctx.logger.warn(`Invitation d’acceptation non générée (candidature #${candidature.id})`, invite.error);
  } else if (invite.url) {
    log.push(`🔗 Invitation à usage unique générée vers **${invite.guildName}**`);
    await ctx.services.candidatures.addEvent(candidature.id, 'invite', { detail: invite.guildName });
  }

  const message = category?.accept_message ? fill(category.accept_message, placeholdersOf(guild, category, candidature, { invite: invite.url ?? '' })).trim() : '';
  if (message) lines.push('', message);
  if (invite.url && !String(category.accept_message ?? '').includes('{invite}')) {
    lines.push('', `🔗 **Invitation personnelle vers ${invite.guildName}** (une seule utilisation, expire ${ui.ts(invite.expiresAt, 'R')}) :`, invite.url);
  }
  return { lines, log };
}

/** Le candidat déclare sa candidature terminée : elle passe « En attente » et les recruteurs sont notifiés. */
async function finishCandidature(ctx, { candidature, category, guild, channel }) {
  const { candidatures } = ctx.services;
  if (candidature.status !== 'draft') return { error: 'Cette candidature a déjà été terminée.' };
  if (!(await candidatures.applicantMessageCount(candidature))) return { error: 'Rédige d’abord ta candidature dans ce salon (au moins un message), puis termine-la.' };

  await candidatures.addEvent(candidature.id, 'submitted', { actorId: candidature.applicant_id });
  const result = await setStatus(ctx, { candidature, category, guild, channel, status: 'pending', by: String(candidature.applicant_id) });
  if (result.error) return result;
  const notify = (category.notify_role_ids.length ? category.notify_role_ids : category.recruiter_role_ids).map((id) => `<@&${id}>`).join(' ');
  if (notify && channel) await channel.send({ content: `📬 ${notify} — nouvelle candidature à traiter.`, allowedMentions: { parse: ['roles'] } }).catch(() => {});
  return result;
}

// ── Catégorie, suppression ──────────────────────────────────────────────────

/** Les recruteurs corrigent une erreur du candidat : le salon change de catégorie Discord et de recruteurs. */
async function changeCategory(ctx, { candidature, fromCategory, toCategory, guild, channel, by }) {
  const { candidatures } = ctx.services;
  if (isFinal(candidature.status)) return { error: 'Cette candidature est clôturée.' };
  if (String(fromCategory?.id) === String(toCategory.id)) return { error: 'La candidature est déjà dans cette catégorie.' };

  if (channel) {
    await moveChannel(channel, toCategory.category_id, `Candidature #${candidature.id} : catégorie « ${toCategory.label} »`).catch((err) => ctx.logger.warn('Déplacement du salon de candidature impossible', err.message));
    const keep = new Set(toCategory.recruiter_role_ids);
    for (const id of fromCategory?.recruiter_role_ids ?? []) if (!keep.has(id)) await channel.permissionOverwrites.delete(id).catch(() => {});
    for (const id of toCategory.recruiter_role_ids) await channel.permissionOverwrites.edit(id, Object.fromEntries(RECRUITER_PERMISSIONS.map((name) => [name, true]))).catch(() => {});
  }
  await candidatures.setCategoryOf(candidature.id, toCategory.id, by, `${fromCategory?.label ?? '?'} → ${toCategory.label}`);
  const updated = { ...candidature, category_id: toCategory.id };

  if (channel) {
    const notify = (toCategory.notify_role_ids.length ? toCategory.notify_role_ids : toCategory.recruiter_role_ids).map((id) => `<@&${id}>`).join(' ');
    await channel
      .send({
        content: `<@${candidature.applicant_id}>${notify ? ` ${notify}` : ''}`,
        embeds: [ui.card({ description: `🔀 **Catégorie modifiée** : ${fromCategory?.label ?? '?'} → **${toCategory.label}**\n🛠️ Par : <@${by}>` }).embed, welcomeEmbed(guild, toCategory, updated)],
        allowedMentions: { parse: ['users', 'roles'] },
      })
      .catch(() => {});
  }
  await sendLog(ctx, guild, [`🔀 **Candidature #${candidature.id} — catégorie modifiée**`, `👤 Candidat : <@${candidature.applicant_id}>`, `📂 ${fromCategory?.label ?? '?'} → ${toCategory.label}`, `🛠️ Par : <@${by}>`]);
  return { candidature: updated };
}

/** Supprime le salon d'une candidature clôturée ; la candidature et sa transcription restent consultables. */
async function deleteChannel(ctx, { candidature, channel, executorId }) {
  if (!isFinal(candidature.status)) return { error: 'Seule une candidature clôturée peut voir son salon supprimé.' };
  await ctx.services.candidatures.markChannelDeleted(candidature.id, executorId);
  if (channel) await channel.delete(`Candidature #${candidature.id} : salon supprimé par ${executorId}`).catch((err) => ctx.logger.warn('Suppression du salon de candidature impossible', err.message));
  return {};
}

module.exports = {
  APPLICANT_PERMISSIONS,
  RECRUITER_PERMISSIONS,
  transcriptUrl,
  fill,
  retryDate,
  retryText,
  placeholdersOf,
  sendLog,
  panelPayload,
  publishPanel,
  refreshPanel,
  unpublishPanel,
  openProblem,
  openCandidature,
  refreshControls,
  setStatus,
  finishCandidature,
  changeCategory,
  deleteChannel,
  categorySelect,
};
