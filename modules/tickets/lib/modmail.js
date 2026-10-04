'use strict';

const { ChannelType, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { slugifyChannelName } = require('./channelName');
const { isTicketAdmin } = require('./guard');
const { ticketsUrl } = require('./webUrl');
const { downloadAttachment, stickersOf } = require('./attachments');

const STAFF_PERMISSIONS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'ManageMessages'];
/** Préfixe d'un message du staff qui ne doit PAS être transmis au membre (note interne). */
const NOTE_PREFIX = '//';

/** Staff modmail : rôles de la catégorie du fil (ou fournis explicitement), ou admin du module/serveur. */
async function isModmailStaff(ctx, member, staffRoleIds) {
  if (!member) return false;
  if ((staffRoleIds || []).some((id) => member.roles.cache.has(id))) return true;
  return isTicketAdmin(ctx, member);
}

/** Staff d'AU MOINS UNE catégorie du serveur (utilisé avant qu'un fil/une catégorie ne soit choisi). */
async function isModmailStaffAnywhere(ctx, guild, member) {
  if (!member) return false;
  if (await isTicketAdmin(ctx, member)) return true;
  const categories = await ctx.services.tickets.listModmailCategories(guild.id);
  return categories.some((category) => category.staff_role_ids.some((id) => member.roles.cache.has(id)));
}

/** Texte d'un message + liens de ses pièces jointes (les fichiers eux-mêmes ne sont pas retransmis sur Discord). */
function messageText(message) {
  const parts = [];
  if (message.content) parts.push(message.content);
  const files = [...message.attachments.values()];
  if (files.length) parts.push(files.map((a) => `📎 [${a.name}](${a.url})`).join('\n'));
  if (message.stickers?.size) parts.push([...message.stickers.values()].map((s) => `🏷️ ${s.name}`).join(' '));
  return parts.join('\n').slice(0, 4000) || '*(message vide)*';
}

function closeButton(ctx, threadId) {
  const buttons = [new ButtonBuilder().setCustomId(`modmail:close:${threadId}`).setLabel('Fermer le fil').setStyle(ButtonStyle.Danger).setEmoji('🔒')];
  const url = ticketsUrl(ctx.config, `transcript?modmail=${threadId}`);
  if (url) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Transcript').setEmoji('📄').setURL(url));
  return new ActionRowBuilder().addComponents(buttons);
}

/** Message du membre (MP) → salon du fil. */
async function relayToStaff(channel, user, message) {
  await channel.send({
    ...ui.payload(ui.card({ author: { name: user.globalName ?? user.username, iconURL: user.displayAvatarURL({ size: 64 }) }, description: messageText(message) })),
    allowedMentions: { parse: [] },
  });
}

/**
 * Préfixe de grade du membre du staff, affiché au membre devant son nom (ex. « [Admin] ») : celui du rôle le
 * plus haut parmi les rôles du staff qui ont un préfixe défini sur le panel (`null` s'il n'en a aucun).
 */
async function rolePrefix(ctx, guild, member) {
  if (!member?.roles?.cache) return null;
  const prefixes = await ctx.services.tickets.rolePrefixes(guild.id);
  if (!prefixes.size) return null;
  const best = [...member.roles.cache.values()].filter((role) => prefixes.has(role.id)).sort((a, b) => b.position - a.position)[0];
  return best ? prefixes.get(best.id) : null;
}

/** Nom du staff tel que le membre le voit : « [Admin] Pseudo — Serveur », ou « Staff — Serveur » en anonyme. */
async function staffDisplayName(ctx, guild, { member, name, anonymous }) {
  if (anonymous) return `Staff — ${guild.name}`;
  const prefix = await rolePrefix(ctx, guild, member);
  return `${prefix ? `${prefix} ` : ''}${name} — ${guild.name}`;
}

/** Carte envoyée au membre en MP (réponse du staff). Renvoie true s'il l'a bien reçue. */
async function deliverToUser(ctx, guild, user, { member, name, avatar, text, anonymous = false }) {
  try {
    await user.send(
      ui.payload(
        ui.card({
          author: {
            name: await staffDisplayName(ctx, guild, { member, name, anonymous }),
            iconURL: anonymous ? guild.iconURL({ size: 64 }) ?? undefined : avatar,
          },
          description: text,
          footer: 'Réponds simplement à ce message pour écrire au staff.',
        }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/** Message du staff (salon) → MP du membre. Renvoie true si le membre a bien reçu le message. */
async function relayToUser(ctx, guild, user, message) {
  return deliverToUser(ctx, guild, user, {
    member: message.member,
    name: message.member?.displayName ?? message.author.username,
    avatar: message.author.displayAvatarURL({ size: 64 }),
    text: messageText(message),
  });
}

/**
 * Capture un message pour le transcript web du fil (voir panel `/m/tickets/`) : message du membre
 * (`member`), du staff (`staff`), note interne (`note`) ou message système (`system`, ouverture/fermeture).
 * `discordMessage` (facultatif) fournit pièces jointes/autocollants/embeds à conserver. Un message du membre
 * ou du staff compte comme activité (fermeture automatique du fil).
 */
async function captureModmailMessage(ctx, threadId, { kind, authorId, authorName, authorAvatar = null, content = null, discordMessage = null, viaWeb = false, anonymous = false }) {
  const rowId = await ctx.services.tickets.appendModmailMessage({
    threadId,
    messageId: discordMessage?.id ?? null,
    authorId,
    authorName,
    authorAvatar,
    authorBot: kind === 'system',
    kind,
    content,
    embeds: discordMessage?.embeds?.length ? discordMessage.embeds.map((e) => e.toJSON()) : null,
    createdAt: discordMessage?.createdAt ?? new Date(),
    viaWeb,
    anonymous,
  });
  if (kind === 'member' || kind === 'staff') await ctx.services.tickets.touchModmail(threadId);
  if (!rowId || !discordMessage) return;
  const stickers = stickersOf(discordMessage);
  if (!discordMessage.attachments.size && !stickers.length) return;
  const save = (file) => ctx.services.tickets.saveModmailAttachment({ messageRowId: rowId, ...file });
  const downloaded = await Promise.all([...discordMessage.attachments.values()].map((a) => downloadAttachment(a, save, ctx.logger)));
  await ctx.services.tickets.setModmailMessageAttachments(rowId, [...downloaded, ...stickers]);
}

/**
 * Ouvre un fil : salon privé pour le staff + enregistrement. `firstMessage` (MP du membre) est
 * retransmis dans le salon. `category` : ligne `modmail_categories` déjà choisie — sinon résolue
 * automatiquement s'il n'en existe qu'une pour ce serveur (sinon `error` liste les choix possibles).
 */
async function openModmail(ctx, { guild, user, openedBy = null, firstMessage = null, category = null }) {
  const { tickets } = ctx.services;
  const enabled = await tickets.modmailEnabled(guild.id);
  if (!enabled) return { error: 'Le modmail n’est pas activé sur ce serveur.' };
  const categories = await tickets.listModmailCategories(guild.id);
  if (!categories.length) return { error: 'Le modmail n’est pas configuré : réglez-le sur le panel web (`/m/tickets/`).' };
  // Liste noire des tickets : s'applique aussi au modmail ouvert par le membre (pas à celui ouvert par le staff).
  if (!openedBy && (await tickets.blacklistEntry(guild.id, user.id))) return { error: 'Tu ne peux pas contacter le staff de ce serveur.' };

  let chosen = category;
  if (!chosen) {
    if (categories.length > 1) return { error: 'Plusieurs catégories sont configurées pour ce serveur : précise laquelle contacter.', categories };
    [chosen] = categories;
  }
  const panelOnly = Boolean(Number(chosen.panel_only));
  const categoryChannel = chosen.category_id ? guild.channels.cache.get(chosen.category_id) : null;
  if (!panelOnly && !categoryChannel) return { error: 'Le modmail n’est pas configuré correctement (catégorie Discord manquante) : réglez-le sur le panel web (`/m/tickets/`).' };
  if (await tickets.openModmailForUser(guild.id, user.id)) return { error: `Un fil modmail est déjà ouvert avec <@${user.id}>.` };
  if (panelOnly) return openPanelOnlyModmail(ctx, { guild, user, openedBy, firstMessage, category: chosen });

  const overwrites = [{ id: guild.id, deny: ['ViewChannel'] }, ...chosen.staff_role_ids.map((id) => ({ id, allow: STAFF_PERMISSIONS }))];
  const channel = await guild.channels.create({
    name: `modmail-${slugifyChannelName(user.username)}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: categoryChannel.id,
    topic: `Modmail avec ${user.username} (${user.id}) — ${chosen.name}`,
    permissionOverwrites: overwrites,
    reason: `Modmail ${openedBy ? `ouvert par le staff (${openedBy})` : `de ${user.username}`}`,
  });
  for (const admin of await tickets.listAdmins(guild.id)) {
    await channel.permissionOverwrites.edit(admin.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
  }

  let thread;
  try {
    thread = await tickets.createModmailThread({ guildId: guild.id, userId: user.id, channelId: channel.id, openedBy, category: chosen });
  } catch (err) {
    await channel.delete('Échec de la création du fil modmail').catch(() => {});
    throw err;
  }

  const member = guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
  const info = [
    `📨 **Nouveau modmail** — <@${user.id}> (\`${user.id}\`)`,
    `🗂️ Catégorie : ${chosen.name}`,
    `🗓️ Compte créé : ${ui.ts(user.createdAt, 'R')}`,
    member?.joinedAt ? `📥 A rejoint le serveur : ${ui.ts(member.joinedAt, 'R')}` : null,
    '',
    `Écris dans ce salon pour répondre au membre (message privé). Commence par \`${NOTE_PREFIX}\` pour une **note interne** non transmise.`,
    openedBy ? `🛠️ Ouvert par <@${openedBy}>.` : null,
  ].filter((line) => line !== null);
  await channel.send({
    ...ui.payload(ui.card({ description: info.join('\n'), thumbnail: user.displayAvatarURL({ size: 128 }), timestamp: true })),
    components: [closeButton(ctx, thread.id)],
  });
  await captureModmailMessage(ctx, thread.id, { kind: 'system', authorId: ctx.client.user.id, authorName: 'Système', authorAvatar: ctx.client.user.displayAvatarURL({ size: 64 }), content: info.join('\n') });

  if (firstMessage) {
    await relayToStaff(channel, user, firstMessage);
    await captureModmailMessage(ctx, thread.id, {
      kind: 'member',
      authorId: user.id,
      authorName: user.globalName ?? user.username,
      authorAvatar: user.displayAvatarURL({ size: 64 }),
      content: firstMessage.content || null,
      discordMessage: firstMessage,
    });
  }

  await ctx.services.logs.send(
    guild.id,
    ui.card({ description: `📨 **Modmail ouvert** — <@${user.id}>\n🗂️ Catégorie : ${chosen.name}\n📍 Salon : <#${channel.id}>${openedBy ? `\n🛠️ Par : <@${openedBy}>` : ''}`, timestamp: true }),
  );
  return { thread, channel, category: chosen };
}

/**
 * Catégorie « panel uniquement » : aucun salon Discord n'est créé. Le fil n'existe qu'en base : le staff le lit,
 * y répond et le ferme depuis le panel web (transcript), et le journal reçoit un lien vers ce transcript.
 */
async function openPanelOnlyModmail(ctx, { guild, user, openedBy, firstMessage, category }) {
  const thread = await ctx.services.tickets.createModmailThread({ guildId: guild.id, userId: user.id, channelId: null, openedBy, category });
  const info = [
    `📨 **Nouveau modmail** — ${user.username} (\`${user.id}\`)`,
    `🗂️ Catégorie : ${category.name} (traitée depuis le panel web)`,
    openedBy ? `🛠️ Ouvert par <@${openedBy}>.` : null,
  ].filter(Boolean);
  await captureModmailMessage(ctx, thread.id, { kind: 'system', authorId: ctx.client.user.id, authorName: 'Système', authorAvatar: ctx.client.user.displayAvatarURL({ size: 64 }), content: info.join('\n') });
  if (firstMessage) {
    await captureModmailMessage(ctx, thread.id, {
      kind: 'member',
      authorId: user.id,
      authorName: user.globalName ?? user.username,
      authorAvatar: user.displayAvatarURL({ size: 64 }),
      content: firstMessage.content || null,
      discordMessage: firstMessage,
    });
  }
  const url = ticketsUrl(ctx.config, `transcript?modmail=${thread.id}`);
  await ctx.services.logs.send(
    guild.id,
    ui.card({
      description: `📨 **Modmail ouvert** — <@${user.id}>\n🗂️ Catégorie : ${category.name}\n🌐 À traiter depuis le panel web${url ? ` : ${url}` : ''}${openedBy ? `\n🛠️ Par : <@${openedBy}>` : ''}`,
      timestamp: true,
    }),
  );
  return { thread, channel: null, category };
}

/** Texte brut de l'échange (pour le journal) : un message par ligne, notes internes incluses et signalées. */
async function buildTranscript(ctx, channel) {
  const all = [];
  let before;
  for (let i = 0; i < 10; i += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const stamp = (d) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  return all
    .map((m) => {
      let who = m.author.username;
      let text = m.content;
      if (m.author.id === ctx.client.user.id) {
        const embed = m.embeds[0];
        if (!embed) return null;
        who = embed.author?.name ?? 'Système';
        text = embed.description ?? '';
      } else if (m.content.startsWith(NOTE_PREFIX)) {
        text = `[note interne] ${m.content.slice(NOTE_PREFIX.length).trim()}`;
      }
      const files = [...m.attachments.values()].map((a) => a.url).join(' ');
      return `[${stamp(m.createdAt)}] ${who} : ${text.replace(/\n/g, '\n    ')}${files ? ` ${files}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Ferme un fil : enregistre, publie le transcript (fichier texte) dans le journal, prévient le
 * membre puis supprime le salon quelques secondes plus tard — sans attendre, pour que la réponse
 * à la commande/au bouton qui a déclenché la fermeture parte avant la suppression du salon.
 * Le transcript reste aussi consultable en détail (embeds, pièces jointes…) sur le panel web.
 */
async function closeModmail(ctx, thread, { closedBy, reason = null, notifyUser = true }) {
  const { tickets } = ctx.services;
  await tickets.closeModmail(thread.id, closedBy, reason);
  const guild = ctx.client.guilds.cache.get(thread.guild_id);
  const channel = guild?.channels.cache.get(thread.channel_id);

  const closeText = [`🔒 **Modmail fermé** — <@${thread.user_id}>`, closedBy ? `🛠️ Par : <@${closedBy}>` : '🛠️ Automatiquement', reason ? `📝 Raison : ${reason}` : null]
    .filter(Boolean)
    .join('\n');
  await captureModmailMessage(ctx, thread.id, {
    kind: 'system',
    authorId: ctx.client.user.id,
    authorName: 'Système',
    authorAvatar: ctx.client.user.displayAvatarURL({ size: 64 }),
    content: closeText,
  });

  if (channel?.isTextBased()) {
    const transcript = await buildTranscript(ctx, channel).catch(() => null);
    const card = ui.card({ description: closeText, timestamp: true });
    const { logChannelId } = await tickets.settings(thread.guild_id);
    const logChannel = logChannelId ? (ctx.client.channels.cache.get(logChannelId) ?? (await ctx.client.channels.fetch(logChannelId).catch(() => null))) : null;
    if (logChannel?.isTextBased()) {
      const payload = ui.payload(card);
      if (transcript) payload.files = [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `modmail-${thread.id}.txt` })];
      await logChannel.send(payload).catch((err) => ctx.logger.warn('Journal du modmail indisponible', err.message));
    }
    await channel.send(ui.payload(ui.card({ description: '🔒 **Fil fermé** — ce salon sera supprimé dans quelques secondes.' }))).catch(() => {});
    setTimeout(() => channel.delete('Modmail fermé').catch(() => {}), 5000).unref();
  } else if (!thread.channel_id && guild) {
    // Fil « panel uniquement » : pas de salon à archiver, le transcript complet reste sur le panel.
    const url = ticketsUrl(ctx.config, `transcript?modmail=${thread.id}`);
    await ctx.services.logs.send(thread.guild_id, ui.card({ description: `${closeText}${url ? `\n📄 Transcript : ${url}` : ''}`, timestamp: true })).catch(() => {});
  }

  if (notifyUser) {
    const user = await ctx.client.users.fetch(thread.user_id).catch(() => null);
    const text = `🔒 Ta conversation avec le staff de **${guild?.name ?? 'ce serveur'}** est terminée.${reason ? `\n📝 ${reason}` : ''}\nÉcris-moi de nouveau pour en ouvrir une nouvelle.`;
    await user?.send(ui.payload(ui.card({ description: text }))).catch(() => {});
  }
}

/**
 * MP en attente d'un choix (serveur et/ou catégorie) : `{ message, guildId, at }`, `guildId` renseigné une fois
 * le serveur choisi. Les choix restés sans réponse expirent (la Map ne grossit pas indéfiniment).
 */
const pending = new Map();
const PENDING_TTL_MS = 15 * 60_000;

function setPending(userId, entry) {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > PENDING_TTL_MS) pending.delete(key);
  pending.set(userId, { ...entry, at: now });
}

/** Ouvre un fil suite à un MP du membre et le prévient (ou lui explique pourquoi c'est impossible). */
async function startThread(ctx, guild, user, firstMessage, dmChannel, category = null) {
  const result = await openModmail(ctx, { guild, user, firstMessage, category });
  if (result.error) {
    await dmChannel.send(ui.payload(ui.errorCard(result.error, 'Modmail indisponible', '📨'))).catch(() => {});
    return null;
  }
  // Message d'accueil de la catégorie (panel web) si défini, sinon le message par défaut.
  const custom = result.category?.welcome_message?.trim();
  const text = custom
    ? custom.replace(/\{server\}/g, guild.name).replace(/\{category\}/g, result.category.name).replace(/\{user\}/g, `<@${user.id}>`)
    : `📨 Ton message a été transmis au staff de **${guild.name}**. Tu recevras leur réponse ici — continue simplement d’écrire pour ajouter des messages.`;
  await dmChannel.send(ui.payload(ui.card({ description: text.slice(0, 4000) }))).catch(() => {});
  return result;
}

/**
 * Réponse du staff envoyée autrement que par un message dans le salon du fil (panel web, /modmail anonyme) :
 * MP au membre (préfixe de grade, ou « Staff — Serveur » en anonyme), copie dans le salon pour le reste du staff,
 * capture pour le transcript. Renvoie { delivered } ou { error }.
 */
async function staffReply(ctx, thread, { authorId, authorName, authorAvatar, member = null, content, anonymous = false, viaWeb = false }) {
  const guild = ctx.client.guilds.cache.get(String(thread.guild_id));
  if (!guild) return { error: 'Serveur introuvable.' };
  const user = await ctx.client.users.fetch(String(thread.user_id)).catch(() => null);
  const delivered = user ? await deliverToUser(ctx, guild, user, { member, name: authorName, avatar: authorAvatar, text: content.slice(0, 4000), anonymous }) : false;

  const channel = guild.channels.cache.get(String(thread.channel_id));
  if (channel?.isTextBased()) {
    const origin = [anonymous ? '🕶️ anonyme' : null, viaWeb ? '🌐 panel web' : null].filter(Boolean).join(' · ');
    await channel
      .send({
        ...ui.payload(ui.card({ author: { name: `${authorName}${origin ? ` (${origin})` : ''}`, iconURL: authorAvatar ?? undefined }, description: content.slice(0, 4000) })),
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  await captureModmailMessage(ctx, thread.id, { kind: 'staff', authorId, authorName, authorAvatar, content, viaWeb, anonymous });
  return { delivered };
}

/** Serveur connu (choisi ou seul candidat) : ouvre directement s'il n'y a qu'une catégorie, sinon propose un choix. */
async function pickCategoryOrStart(ctx, guild, user, message, dmChannel) {
  const categories = await ctx.services.tickets.listModmailCategories(guild.id);
  if (categories.length <= 1) {
    await startThread(ctx, guild, user, message, dmChannel, categories[0] ?? null);
    return;
  }
  setPending(user.id, { message, guildId: guild.id });
  const select = new StringSelectMenuBuilder()
    .setCustomId('modmail:pickcategory')
    .setPlaceholder('Choisir la catégorie…')
    .addOptions(categories.slice(0, 25).map((c) => ({ label: c.name.slice(0, 100), value: String(c.id) })));
  await dmChannel.send({
    ...ui.payload(ui.card({ description: `📨 À quel sujet écris-tu au staff de **${guild.name}** ?` })),
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

module.exports = {
  NOTE_PREFIX,
  pending,
  setPending,
  isModmailStaff,
  isModmailStaffAnywhere,
  openModmail,
  closeModmail,
  startThread,
  pickCategoryOrStart,
  relayToStaff,
  relayToUser,
  staffReply,
  rolePrefix,
  messageText,
  captureModmailMessage,
};
