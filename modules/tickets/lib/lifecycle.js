'use strict';

const { ChannelType, RESTJSONErrorCodes, Routes, WebhookClient } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { buildEmbed } = require('./embed');
const { panelComponents, openTicketControls, closedTicketControls } = require('./components');
const { slugifyChannelName, ticketChannelName, tagPrefix } = require('./channelName');
const { ticketsUrl } = require('./webUrl');
const { sendRatingPrompt } = require('./rating');
const { KeyedMutex } = require('../../../src/core/keyedMutex');
const { answersEmbed } = require('./form');

const MOD_PERMISSIONS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'ManageMessages'];
const HELPER_PERMISSIONS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'];

/** Envoie un message avec bouton lien ; si Discord refuse l'URL (ex. localhost), renvoie sans le lien. */
async function sendResilient(channel, payload, linkFallbackPayload) {
  try {
    return await channel.send(payload);
  } catch (err) {
    if (err?.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType || !linkFallbackPayload) throw err;
    return channel.send(linkFallbackPayload);
  }
}

/**
 * Envoie un message dans le salon d'un ticket « sous l'identité » d'un membre du staff (réponse depuis le
 * panel web, réponse prédéfinie) : pseudo et photo de profil Discord réels, via un webhook du salon créé à
 * la volée et réutilisé ensuite. Si la création du webhook échoue (permission « Gérer les
 * webhooks » manquante, salon supprimé entre-temps…), repli sur un message classique du bot,
 * préfixé pour rester traçable (`origin` : « panel web », « réponse prédéfinie »…).
 */
async function sendAsWebUser(ctx, ticket, channel, webUser, content, { origin = 'panel web' } = {}) {
  let webhook = null;
  if (ticket.webhook_id && ticket.webhook_token) {
    webhook = new WebhookClient({ id: String(ticket.webhook_id), token: ticket.webhook_token });
  } else {
    try {
      const created = await channel.createWebhook({ name: 'Tickets (panel web)', reason: 'Relais des réponses envoyées depuis le panel web' });
      await ctx.services.tickets.setWebhook(ticket.id, created.id, created.token);
      webhook = new WebhookClient({ id: created.id, token: created.token });
    } catch (err) {
      ctx.logger.warn(`Webhook du ticket #${ticket.id} impossible (permission « Gérer les webhooks » ?)`, err.message);
    }
  }

  if (webhook) {
    try {
      return await webhook.send({ content, username: webUser.name.slice(0, 80), avatarURL: webUser.avatar, allowedMentions: { parse: [] } });
    } catch (err) {
      ctx.logger.warn(`Envoi via webhook impossible pour le ticket #${ticket.id}`, err.message);
    }
  }
  return channel.send({ content: `🌐 **${webUser.name}** (${origin}) : ${content}`, allowedMentions: { parse: [] } });
}

async function refreshPanelMessage(ctx, panel) {
  if (!panel.channel_id || !panel.message_id) return;
  try {
    const channel = ctx.client.channels.cache.get(panel.channel_id) ?? (await ctx.client.channels.fetch(panel.channel_id).catch(() => null));
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(panel.message_id).catch(() => null);
    if (!message) return;
    const types = await ctx.services.tickets.listTypes(panel.id);
    const embed = buildEmbed({ title: panel.open_title, description: panel.open_description, color: panel.open_color, footer: panel.open_footer, image: panel.open_image, thumbnail: panel.open_thumbnail });
    await message.edit({ embeds: embed ? [embed] : [], components: panelComponents(types, panel.style) });
  } catch (err) {
    ctx.logger.warn(`Rafraîchissement du panel #${panel.id} impossible`, err.message);
  }
}

/**
 * Publie (ou republie) le message d'un panel dans un salon. Un panel n'a qu'un seul message actif :
 * l'ancien (même salon ou non) est supprimé une fois le nouveau envoyé.
 */
async function publishPanel(ctx, panel, channel) {
  const types = await ctx.services.tickets.listTypes(panel.id);
  if (!types.length) return { error: 'Ajoute au moins un type de ticket (bouton/option) avant de publier ce panel.' };
  const embed = buildEmbed({ title: panel.open_title, description: panel.open_description, color: panel.open_color, footer: panel.open_footer, image: panel.open_image, thumbnail: panel.open_thumbnail });

  let previous = null;
  if (panel.channel_id && panel.message_id) {
    const oldChannel = ctx.client.channels.cache.get(String(panel.channel_id)) ?? (await ctx.client.channels.fetch(String(panel.channel_id)).catch(() => null));
    previous = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(String(panel.message_id)).catch(() => null) : null;
  }

  const message = await channel.send({ embeds: embed ? [embed] : [], components: panelComponents(types, panel.style) });
  await ctx.services.tickets.setPanelMessage(panel.id, channel.id, message.id);
  if (previous && previous.id !== message.id) await previous.delete().catch((err) => ctx.logger.warn(`Ancien message du panel #${panel.id} non supprimé`, err.message));
  return { message };
}

/**
 * Renomme le salon selon l'état du ticket : 'open' (format d'ouverture), 'claimed' (pris en charge)
 * ou 'closed' (fermé), précédé des préfixes de ses étiquettes (ex. « urgent-ticket-0042-bob »). Sans préfixe,
 * un état sans format dédié ne renomme rien (open/claimed retombent sur le format d'ouverture, closed laisse le
 * nom tel quel). Non bloquant : Discord limite le renommage d'un salon à 2 fois par 10 minutes, et discord.js
 * attendrait la fin du délai avant de répondre.
 * `force` (transfert, étiquette posée ou retirée) : le nom est toujours recalculé.
 */
function syncChannelName(ctx, channel, type, ticket, state, { force = false } = {}) {
  const dedicated =
    state === 'closed'
      ? Boolean(type.closed_channel_name_pattern)
      : state === 'claimed'
        ? Boolean(type.claimed_channel_name_pattern)
        : Boolean(type.claimed_channel_name_pattern || type.closed_channel_name_pattern);
  // Format de repli quand l'état n'a pas le sien : celui de la prise en charge (si pris), sinon celui d'ouverture.
  const pattern =
    (state === 'closed' ? type.closed_channel_name_pattern : null) ||
    (state !== 'open' && ticket.claimed_by ? type.claimed_channel_name_pattern : null) ||
    type.channel_name_pattern;

  (async () => {
    const tags = (await ctx.services.tickets.tagsForTickets([ticket.id])).get(String(ticket.id)) ?? [];
    const prefix = tagPrefix(tags);
    if (!force && !dedicated && !prefix) return;
    const guild = channel.guild;
    const opener = ctx.client.users.cache.get(ticket.opener_id) ?? (await ctx.client.users.fetch(ticket.opener_id).catch(() => null));
    const claimerMember = ticket.claimed_by ? guild.members.cache.get(ticket.claimed_by) ?? (await guild.members.fetch(ticket.claimed_by).catch(() => null)) : null;
    const base = ticketChannelName(pattern, {
      ticketId: ticket.id,
      username: opener?.username ?? 'membre',
      typeLabel: type.label,
      claimer: claimerMember?.displayName ?? '',
    });
    const name = (prefix ? `${prefix}-${base}` : base).slice(0, 100);
    if (name) queueRename(ctx, channel, name, `Ticket #${ticket.id} : ${state}`);
  })().catch((err) => ctx.logger?.warn(`Renommage du salon du ticket #${ticket.id} impossible`, err.message));
}

/**
 * Renommages en attente, par salon : Discord n'autorise que 2 renommages d'un salon par 10 minutes (au-delà,
 * discord.js attend la fin du délai sans erreur). Les demandes rapprochées (ouverture, prise en charge, étiquette,
 * transfert…) sont donc regroupées : un seul renommage à la fois, et seul le dernier nom voulu est appliqué.
 */
const pendingRenames = new Map(); // channelId → { wanted, reason }

function queueRename(ctx, channel, name, reason) {
  const existing = pendingRenames.get(channel.id);
  if (existing) {
    existing.wanted = name;
    existing.reason = reason;
    return;
  }
  if (name === channel.name) return;
  const entry = { wanted: name, reason };
  pendingRenames.set(channel.id, entry);
  (async () => {
    try {
      while (entry.wanted && entry.wanted !== channel.name) {
        const target = entry.wanted;
        await channel.setName(target, entry.reason);
        if (entry.wanted === target) break;
      }
    } catch (err) {
      ctx.logger?.warn(`Renommage du salon ${channel.id} impossible`, err.message);
    } finally {
      pendingRenames.delete(channel.id);
    }
  })();
}

/**
 * Déplace un salon dans une autre catégorie (sans toucher à ses permissions). Requête envoyée sans le champ `name` :
 * `channel.setParent()` l'inclut toujours, ce qui fait attendre le déplacement derrière un renommage limité par
 * Discord (jusqu'à 10 minutes, sans erreur). Renvoie false si le salon y est déjà.
 */
async function moveChannel(channel, parentId, reason) {
  if (!parentId || channel.parentId === String(parentId)) return false;
  await channel.client.rest.patch(Routes.channel(channel.id), { body: { parent_id: String(parentId), lock_permissions: false }, reason });
  return true;
}

// Ouvertures d'un même type traitées une par une : un double-clic (ou deux membres en même temps face à la
// limite `max_open`) ne peut plus créer de ticket en trop, la 2e demande voit le ticket créé par la 1re.
const openLocks = new KeyedMutex();

/** Ouvre un ticket pour `opener` à partir d'un type donné (`answers` : réponses au formulaire, facultatives). */
function openTicket(ctx, options) {
  return openLocks.run(`type:${options.type.id}`, () => openTicketNow(ctx, options));
}

/**
 * Vérifications préalables à l'ouverture (liste noire, ticket déjà ouvert, limite, catégorie) : renvoie le
 * message d'erreur, ou null. Appelée avant d'afficher le formulaire (le membre ne le remplit pas pour rien),
 * puis de nouveau, sous verrou, au moment de créer le ticket.
 */
async function openTicketProblem(ctx, { type, guild, opener }) {
  const { tickets } = ctx.services;
  const banned = await tickets.blacklistEntry(guild.id, opener.id);
  if (banned) return `Tu ne peux pas ouvrir de ticket sur ce serveur${banned.reason ? ` (${banned.reason})` : ''}.`;

  const existing = await tickets.openTicketForUser(type.id, opener.id);
  if (existing) return `Tu as déjà un ticket ouvert pour **${type.label}** : <#${existing.channel_id}>`;

  if (type.max_open) {
    const count = await tickets.openCountForType(type.id);
    if (count >= type.max_open) return 'Le nombre maximum de tickets ouverts pour ce type est atteint, réessaie plus tard.';
  }

  const category = type.category_id ? guild.channels.cache.get(type.category_id) : null;
  if (!category) return 'Ce type de ticket n’est pas configuré correctement (catégorie manquante) : contacte un administrateur.';
  return null;
}

async function openTicketNow(ctx, { panel, type, guild, opener, answers = [] }) {
  const problem = await openTicketProblem(ctx, { type, guild, opener });
  if (problem) return { error: problem };
  const category = guild.channels.cache.get(type.category_id);

  const overwrites = [
    { id: guild.id, deny: ['ViewChannel'] },
    { id: opener.id, allow: HELPER_PERMISSIONS },
    ...type.mod_role_ids.map((id) => ({ id, allow: MOD_PERMISSIONS })),
    ...type.helper_role_ids.map((id) => ({ id, allow: HELPER_PERMISSIONS })),
  ];

  const channel = await guild.channels.create({
    name: `nouveau-ticket-${slugifyChannelName(opener.username)}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    reason: `Ticket ouvert par ${opener.tag ?? opener.username}`,
  });

  let ticket;
  try {
    ticket = await ctx.services.tickets.createTicket({
      guildId: guild.id,
      panelId: panel.id,
      typeId: type.id,
      channelId: channel.id,
      openerId: opener.id,
      subject: type.label,
      formAnswers: answers,
    });
  } catch (err) {
    await channel.delete('Échec de la création du ticket en base').catch(() => {});
    throw err;
  }

  const channelName = ticketChannelName(type.channel_name_pattern, { ticketId: ticket.id, username: opener.username, typeLabel: type.label });
  await channel.setName(channelName).catch(() => {});

  const admins = await ctx.services.tickets.listAdmins(guild.id);
  for (const admin of admins) {
    await channel.permissionOverwrites.edit(admin.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
  }

  const embed = welcomeEmbed({ guild, type, ticket, opener, category });
  const mentions = [`<@${opener.id}>`, ...type.notify_role_ids.map((id) => `<@&${id}>`)].join(' ');
  const answersCard = answersEmbed(answers);

  await channel.send({
    content: mentions,
    embeds: [embed, answersCard].filter(Boolean),
    components: openTicketControls(ticket),
    allowedMentions: { parse: ['users', 'roles'] },
  });

  await ctx.services.logs.opened(guild, ticket, type);
  refreshLists(ctx, guild.id);
  return { ticket, channel };
}

/** Embed d'accueil d'un type (placeholders remplis) : à l'ouverture, et à nouveau sur demande après un transfert. */
function welcomeEmbed({ guild, type, ticket, opener, category }) {
  const placeholders = {
    user: `<@${opener.id}>`,
    username: opener.username,
    type: type.label,
    ticket: `#${ticket.id}`,
    number: String(ticket.id).padStart(4, '0'),
    server: guild.name,
    category: category?.name ?? '',
    mods: type.mod_role_ids.map((id) => `<@&${id}>`).join(' ') || '—',
  };
  return buildEmbed(
    { title: type.opened_title, description: type.opened_description, color: type.opened_color, footer: type.opened_footer, image: type.opened_image, thumbnail: type.opened_thumbnail },
    placeholders,
  );
}

/** Les messages « liste des tickets » (/ticket autolist) suivent chaque changement (regroupés, non bloquant). */
function refreshLists(ctx, guildId) {
  ctx.services.autolist?.refresh(guildId);
}

/**
 * Ferme un ticket : verrouille le salon, génère le transcript si activé, propose le lien si activé.
 * Ne publie plus de log immédiat dans le salon de journal (voir `deleteTicket` pour l'archive
 * complète, postée une seule fois à la suppression du salon) — seul un événement est enregistré
 * pour l'historique.
 */
async function closeTicket(ctx, { ticket, type, channel, closedBy, reason, auto = false }) {
  await ctx.services.tickets.closeTicket(ticket.id, { reason, closedBy, auto });
  await ctx.services.tickets.recordEvent(ticket.id, 'closed', closedBy, reason);
  const updated = { ...ticket, status: 'closed', close_reason: reason ?? null, closed_by: closedBy, auto_closed: auto ? 1 : 0 };

  await channel.permissionOverwrites.edit(ticket.opener_id, { SendMessages: false }).catch(() => {});
  for (const member of await ctx.services.tickets.listMembers(ticket.id)) {
    await channel.permissionOverwrites.edit(member.user_id, { SendMessages: false }).catch(() => {});
  }

  let transcriptUrl = null;
  if (type.auto_transcript || type.live_transcript) {
    await ctx.services.tickets.markTranscriptGenerated(ticket.id);
    transcriptUrl = ticketsUrl(ctx.config, `transcript?ticket=${ticket.id}`);
  }

  // closedBy est nul pour une clôture automatique (aucun exécuteur humain) : on mentionne le bot
  // plutôt que <@null>, qui ne pingerait personne et s'afficherait littéralement.
  const executorMention = closedBy ? `<@${closedBy}>` : `<@${ctx.client.user.id}> (automatique)`;
  const lines = ['🔒 **Ticket fermé**', `🛠️ Par : ${executorMention}`];
  if (reason) lines.push(`📝 Raison : ${reason}`);
  // Un seul message : l'embed de fermeture porte directement les boutons (transcript, réouvrir, supprimer).
  const closedCard = ui.payload(ui.card({ description: lines.join('\n'), timestamp: true }));
  await sendResilient(
    channel,
    { ...closedCard, components: closedTicketControls(updated, { transcriptUrl }) },
    { ...closedCard, components: closedTicketControls(updated, {}) },
  );
  syncChannelName(ctx, channel, type, updated, 'closed');
  refreshLists(ctx, channel.guild.id);

  return updated;
}

/** Réouvre un ticket fermé : redéverrouille le salon et le repasse en statut ouvert. */
async function reopenTicket(ctx, { ticket, channel, executorId }) {
  await ctx.services.tickets.reopenTicket(ticket.id);
  await ctx.services.tickets.recordEvent(ticket.id, 'reopened', executorId, null);
  const updated = { ...ticket, status: 'open' };
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (type) syncChannelName(ctx, channel, type, updated, updated.claimed_by ? 'claimed' : 'open');

  await channel.permissionOverwrites.edit(ticket.opener_id, { SendMessages: true }).catch(() => {});
  for (const member of await ctx.services.tickets.listMembers(ticket.id)) {
    await channel.permissionOverwrites.edit(member.user_id, { SendMessages: true }).catch(() => {});
  }

  await sendResilient(channel, ui.payload(ui.card({ description: `🔓 **Ticket réouvert**\n🛠️ Par : <@${executorId}>`, timestamp: true })));
  await sendResilient(channel, { components: openTicketControls(updated) });
  refreshLists(ctx, channel.guild.id);
  return updated;
}

/**
 * Supprime le salon Discord d'un ticket déjà fermé et publie l'archive complète (fermetures,
 * réouvertures, suppression) en un seul log. La fiche du ticket et les messages capturés restent en
 * base (transcript toujours consultable sur le panel web après suppression du salon).
 */
async function deleteTicket(ctx, { ticket, type, channel, executorId }) {
  const guild = channel.guild;
  const channelName = channel.name;
  await ctx.services.tickets.recordEvent(ticket.id, 'deleted', executorId, null);
  // Marqué AVANT la suppression : l'événement « salon supprimé » qui suit sait alors que c'est le bot.
  await ctx.services.tickets.markDeleted(ticket.id);
  await channel.delete(executorId ? 'Ticket supprimé' : 'Ticket supprimé automatiquement (délai après fermeture)').catch(() => {});
  const events = await ctx.services.tickets.listEvents(ticket.id);
  await ctx.services.logs.archived(guild, ticket, type, events, { deletedBy: executorId, channelName });

  // La notation n'est demandée qu'une fois le ticket définitivement archivé (salon supprimé) : un
  // ticket fermé peut encore être réouvert, ce qui rendrait une notation prématurée trompeuse. Elle
  // n'est jamais demandée pour un ticket qui n'a pas été pris en charge (personne à noter), ni pour
  // un ticket fermé automatiquement (membre silencieux ou parti).
  if (type?.rating_enabled && ticket.claimed_by && !ticket.auto_closed) {
    sendRatingPrompt(ctx, ticket, type).catch((err) => ctx.logger.warn(`Demande de notation du ticket #${ticket.id} impossible`, err.message));
  }
}

/**
 * Prend en charge / relâche un ticket depuis un contexte sans interaction Discord (panel web) : met à jour la base,
 * le nom du salon, le journal et les boutons du message d'accueil (voir `refreshOpenControls`).
 */
async function setClaim(ctx, { ticket, type, channel, userId, claiming }) {
  if (claiming) await ctx.services.tickets.claim(ticket.id, userId);
  else await ctx.services.tickets.unclaim(ticket.id);
  const updated = { ...ticket, claimed_by: claiming ? userId : null };
  syncChannelName(ctx, channel, type, updated, claiming ? 'claimed' : 'open');
  await ctx.services.logs.claim(channel.guild, updated, type, userId, claiming);
  await refreshOpenControls(ctx, channel, updated);
  refreshLists(ctx, channel.guild.id);
  return updated;
}

/**
 * Remet à jour le bouton « Prendre en charge / Relâcher » des messages du bot qui portent les contrôles du ticket
 * (le message d'accueil, et ceux postés à chaque réouverture) : l'identifiant du message n'est pas conservé, on
 * retrouve donc les messages récents du salon qui portent ces boutons.
 */
async function refreshOpenControls(ctx, channel, ticket) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const message of messages.values()) {
      if (message.author.id !== ctx.client.user.id) continue;
      const ids = message.components.flatMap((row) => row.components.map((component) => component.customId));
      if (!ids.some((id) => id === `ticket:claim:${ticket.id}` || id === `ticket:unclaim:${ticket.id}`)) continue;
      await message.edit({ components: openTicketControls(ticket) });
    }
  } catch (err) {
    ctx.logger.warn(`Boutons du ticket #${ticket.id} non mis à jour`, err.message);
  }
}

function permissionObject(names, value = true) {
  return Object.fromEntries(names.map((name) => [name, value]));
}

/**
 * Transfère un ticket ouvert vers un autre type (de n'importe quel panel du serveur) : nouvelle catégorie,
 * rôles modérateur/helper de l'ancien type remplacés par ceux du nouveau (ouvreur, membres ajoutés et admins du
 * module gardent leur accès), nom du salon selon le format du nouveau type, rôles notifiés du nouveau type
 * mentionnés, événement conservé pour l'archive et log. `resendWelcome` : republie l'embed d'accueil du nouveau
 * type dans le ticket. Renvoie { ticket } ou { error }.
 */
async function transferTicket(ctx, { ticket, fromType, toType, channel, executorId, resendWelcome = false }) {
  const { tickets } = ctx.services;
  const guild = channel.guild;
  const toPanel = await tickets.getPanel(toType.panel_id);
  if (!toPanel || String(toPanel.guild_id) !== guild.id) return { error: 'Ce type de ticket n’existe plus sur ce serveur.' };
  const category = toType.category_id ? guild.channels.cache.get(toType.category_id) : null;
  if (!category) return { error: `Le type **${toType.label}** n’a pas de catégorie Discord valide : configure-le d’abord.` };

  // Rôles de l'ancien type qui n'ont plus rien à faire dans ce ticket.
  const keep = new Set([...toType.mod_role_ids, ...toType.helper_role_ids].map(String));
  for (const roleId of [...(fromType?.mod_role_ids ?? []), ...(fromType?.helper_role_ids ?? [])]) {
    if (!keep.has(String(roleId))) await channel.permissionOverwrites.delete(roleId, 'Transfert du ticket').catch(() => {});
  }
  // Une étiquette qui déplace le ticket garde la main sur la catégorie ; sinon, celle du nouveau type.
  const tags = (await tickets.tagsForTickets([ticket.id])).get(String(ticket.id)) ?? [];
  const parentId = desiredCategoryId(guild, toType, tags) ?? category.id;
  await moveChannel(channel, parentId, `Transfert du ticket #${ticket.id}`);
  for (const roleId of toType.mod_role_ids) await channel.permissionOverwrites.edit(roleId, permissionObject(MOD_PERMISSIONS)).catch(() => {});
  for (const roleId of toType.helper_role_ids) await channel.permissionOverwrites.edit(roleId, permissionObject(HELPER_PERMISSIONS)).catch(() => {});

  await tickets.transferTicket(ticket.id, { typeId: toType.id, panelId: toPanel.id, subject: toType.label });
  const fromLabel = fromType?.label ?? ticket.subject ?? 'type supprimé';
  await tickets.recordEvent(ticket.id, 'transferred', executorId, `${fromLabel} → ${toType.label}`);
  const updated = { ...ticket, type_id: toType.id, panel_id: toPanel.id, subject: toType.label };
  syncChannelName(ctx, channel, toType, updated, updated.claimed_by ? 'claimed' : 'open', { force: true });

  const mentions = toType.notify_role_ids.map((id) => `<@&${id}>`).join(' ');
  await channel
    .send({
      content: mentions || undefined,
      ...ui.payload(ui.card({ description: `🔀 **Ticket transféré** : ${fromLabel} → **${toType.label}**\n🛠️ Par : <@${executorId}>`, timestamp: true })),
      allowedMentions: { parse: ['roles'] },
    })
    .catch(() => {});
  if (resendWelcome) {
    const opener = ctx.client.users.cache.get(String(ticket.opener_id)) ?? (await ctx.client.users.fetch(String(ticket.opener_id)).catch(() => null));
    const embed = opener ? welcomeEmbed({ guild, type: toType, ticket: updated, opener, category }) : null;
    if (embed) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  }
  await ctx.services.logs.event(guild, {
    emoji: '🔀',
    label: 'Ticket transféré',
    ticket: updated,
    type: toType,
    executorId,
    extraLines: [`↪️ Depuis : ${fromLabel}`],
  });
  refreshLists(ctx, guild.id);
  return { ticket: updated };
}

/**
 * Catégorie Discord où doit se trouver un ticket : celle de sa plus prioritaire étiquette qui en impose une
 * (si elle existe encore), sinon `null` (= catégorie de son type).
 */
function desiredCategoryId(guild, type, tags) {
  const tagged = tags.find((tag) => tag.category_id && guild.channels.cache.has(String(tag.category_id)));
  return tagged ? String(tagged.category_id) : null;
}

/** Ajoute/retire l'accès d'un admin du module à tous les tickets actuellement ouverts du serveur. */
async function grantAdminAccess(ctx, guild, userId) {
  for (const ticket of await ctx.services.tickets.listOpenTickets(guild.id)) {
    const channel = guild.channels.cache.get(ticket.channel_id);
    if (!channel) continue;
    await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
  }
}

async function revokeAdminAccess(ctx, guild, userId) {
  for (const ticket of await ctx.services.tickets.listOpenTickets(guild.id)) {
    const channel = guild.channels.cache.get(ticket.channel_id);
    if (!channel) continue;
    if (userId === ticket.opener_id) continue; // ne retire jamais l'accès de l'ouvreur
    if (await ctx.services.tickets.isMember(ticket.id, userId)) continue; // ajouté explicitement : on n'y touche pas
    await channel.permissionOverwrites.delete(userId).catch(() => {});
  }
}

module.exports = {
  publishPanel,
  refreshPanelMessage,
  syncChannelName,
  setClaim,
  openTicket,
  openTicketProblem,
  closeTicket,
  reopenTicket,
  deleteTicket,
  transferTicket,
  desiredCategoryId,
  moveChannel,
  refreshLists,
  grantAdminAccess,
  revokeAdminAccess,
  sendAsWebUser,
};
