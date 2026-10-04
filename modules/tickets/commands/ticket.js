'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, RESTJSONErrorCodes } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { isTicketAdmin, canClose, canManage, roleAccess, claimBlock } = require('../lib/guard');
const { closeTicket, grantAdminAccess, revokeAdminAccess } = require('../lib/lifecycle');
const { fillSnippet } = require('../lib/snippets');
const { applyTicketTag, tagLabel } = require('../lib/tags');
const { sortedOpenTickets, listCard } = require('../lib/autolist');
const { ticketsUrl } = require('../lib/webUrl');
const { isWithinSchedule, computeTimers, panelSchedule } = require('../lib/schedule');

async function ticketOf(ctx, interaction) {
  const ticket = await ctx.services.tickets.getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.status !== 'open') return { error: 'Cette commande s’utilise dans un salon de ticket ouvert.' };
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!type) return { error: 'Le type de ce ticket n’existe plus.' };
  return { ticket, type };
}

async function addRemove(ctx, interaction, mode) {
  const guild = interaction.guild;
  const { ticket, type, error } = await ticketOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce type de ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  const target = interaction.options.getUser('user', true);
  const channel = interaction.channel;

  if (mode === 'add') {
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await ctx.services.tickets.addMember(ticket.id, target.id, interaction.user.id);
    await ui.respond(interaction, ui.successCard('Membre ajouté', `<@${target.id}> a été ajouté au ticket.`, '➕'));
  } else {
    await channel.permissionOverwrites.delete(target.id).catch(() => {});
    await ctx.services.tickets.removeMember(ticket.id, target.id);
    await ui.respond(interaction, ui.successCard('Membre retiré', `<@${target.id}> a été retiré du ticket.`, '➖'));
  }
  await ctx.services.logs.memberChange(guild, ticket, type, interaction.user.id, target.id, mode === 'add');
}

/** N'utilise ni ne met à jour l'activité du ticket : consulter ce délai ne compte pas comme une réponse. */
async function delayInfo(ctx, interaction) {
  const { ticket, type, error } = await ticketOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);

  const panel = await ctx.services.tickets.getPanel(ticket.panel_id);
  const schedule = panelSchedule(panel);
  const timers = computeTimers(ticket, type);
  const paused = schedule.scheduleEnabled && !isWithinSchedule(schedule);

  const lines = [];
  if (!type.reping_minutes && !type.auto_close_minutes) {
    lines.push('Aucun délai de reping ni de clôture automatique n’est configuré pour ce type de ticket.');
  } else {
    if (type.reping_minutes) {
      lines.push(
        timers.repingAt
          ? `⏰ Prochain reping du staff : ${ui.ts(timers.repingAt, 'R')}`
          : '⏰ Reping : en pause (le staff a déjà répondu, ou tu n’as pas encore écrit dans ce ticket).',
      );
    }
    if (type.auto_close_minutes) {
      lines.push(
        timers.autoCloseAt
          ? `🔒 Clôture automatique : ${ui.ts(timers.autoCloseAt, 'R')}`
          : '🔒 Clôture automatique : en pause (le staff n’a pas encore répondu à ton message).',
      );
    }
    if (paused) lines.push('\n😴 Hors de la plage horaire d’activation de ce panel actuellement : les délais sont en pause.');
  }
  await ui.respond(interaction, ui.card({ emoji: '⏱️', title: 'Délais de ce ticket', description: lines.join('\n') }), { ephemeral: true });
}

/** Lien vers la transcription en direct du ticket courant (visible tant qu'il reste ouvert). */
async function liveLink(ctx, interaction) {
  const { ticket, type, error } = await ticketOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (!type.auto_transcript && !type.live_transcript) {
    return ui.replyError(interaction, 'Le transcript n’est pas activé pour ce type de ticket : rien à afficher.', 'Indisponible', '📄');
  }
  const url = ticketsUrl(ctx.config, `transcript?ticket=${ticket.id}`);
  if (!url) return ui.replyError(interaction, 'Le panel web est désactivé sur ce bot.');
  const card = ui.card({
    emoji: '📄',
    title: 'Transcription en direct',
    description: `**${url}**${type.live_transcript ? '\nTu peux aussi y répondre directement depuis le panel.' : ''}`,
    body: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ouvrir le transcript').setURL(url))],
  });
  try {
    await ui.respond(interaction, card, { ephemeral: true });
  } catch (err) {
    if (err?.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType) throw err;
    await ui.respond(interaction, ui.card({ emoji: '📄', title: 'Transcription en direct', description: `**${url}**` }), { ephemeral: true });
  }
}

/** /ticket reponse : publie une réponse prédéfinie dans un simple embed du bot (le transcript la capture comme tel). */
async function snippetReply(ctx, interaction) {
  const { tickets } = ctx.services;
  const { ticket, type, error } = await ticketOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  const member = interaction.member;
  const isStaff = Boolean(roleAccess(type, member)) || (await isTicketAdmin(ctx, member));
  if (!isStaff) return ui.replyError(interaction, 'Réservé au staff de ce ticket.', 'Accès refusé', ui.EMOJIS.permissions);
  const blocked = claimBlock(type, ticket, member.id);
  if (blocked) return ui.replyError(interaction, blocked, 'Réponse réservée', '🙋');
  const name = interaction.options.getString('nom', true);
  const snippet = await tickets.snippetByName(interaction.guildId, name);
  if (!snippet) return ui.replyError(interaction, `Réponse prédéfinie inconnue : \`${name}\` (à créer sur le panel web).`, 'Introuvable', '💬');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const content = fillSnippet(snippet.content, { ticket, type, staffId: member.id }).slice(0, 4000);
  // Message du bot : l'écouteur de messages le capture pour le transcript ; l'activité du staff est notée ici
  // (les messages du bot ne comptent jamais comme une réponse).
  await interaction.channel.send({ ...ui.payload(ui.card({ description: content })), allowedMentions: { parse: ['users'] } });
  await tickets.touchActivity(ticket.id, { isStaff: true, isOpener: false });
  await ui.respond(interaction, ui.successCard('Réponse envoyée', `Réponse prédéfinie **${snippet.name}** publiée dans le ticket.`, '💬'));
}

/** /ticket tag : pose ou retire une étiquette sur le ticket courant (modérateurs du ticket et admins du module). */
async function toggleTag(ctx, interaction) {
  const { tickets } = ctx.services;
  const { ticket, type, error } = await ticketOf(ctx, interaction);
  if (error) return ui.replyError(interaction, error);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  const tag = await tickets.getTag(Number(interaction.options.getString('etiquette', true)));
  if (!tag || String(tag.guild_id) !== interaction.guildId) return ui.replyError(interaction, 'Étiquette inconnue (choisis-la dans la liste).', 'Introuvable', '🏷️');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const on = await applyTicketTag(ctx, { guild: interaction.guild, ticket, type, tag, executorId: interaction.user.id });
  await ui.respond(interaction, ui.successCard(on ? 'Étiquette ajoutée' : 'Étiquette retirée', `**${tagLabel(tag)}** ${on ? 'ajoutée au' : 'retirée du'} ticket #${ticket.id}.`, '🏷️'));
}

/** Staff des tickets : admins du module, ou membre d'un rôle modérateur/helper d'au moins un type du serveur. */
async function staffTypes(ctx, member) {
  const types = await ctx.services.tickets.listAllTypes(member.guild.id);
  if (await isTicketAdmin(ctx, member)) return { admin: true, types };
  return { admin: false, types: types.filter((type) => roleAccess(type, member)) };
}

/** /ticket list : tous les tickets ouverts visibles par ce membre du staff, triés par priorité des étiquettes. */
async function listTickets(ctx, interaction) {
  const { admin, types } = await staffTypes(ctx, interaction.member);
  if (!admin && !types.length) return ui.replyError(interaction, 'Réservé au staff des tickets.', 'Accès refusé', ui.EMOJIS.permissions);
  const allowed = new Set(types.map((type) => String(type.id)));
  const entries = (await sortedOpenTickets(ctx.services.tickets, interaction.guildId)).filter((entry) => admin || allowed.has(String(entry.ticket.type_id)));
  await ui.respond(interaction, listCard(entries), { ephemeral: true });
}

/** /ticket autolist : publie dans ce salon une liste des tickets ouverts visible de tous, tenue à jour automatiquement. */
async function publishAutolist(ctx, interaction) {
  const { tickets, autolist } = ctx.services;
  const raw = interaction.options.getString('categorie');
  let type = null;
  if (raw) {
    type = await tickets.getType(Number(raw));
    const panel = type ? await tickets.getPanel(type.panel_id) : null;
    if (!panel || String(panel.guild_id) !== interaction.guildId) return ui.replyError(interaction, 'Type de ticket inconnu (choisis-le dans la liste).', 'Introuvable', '📋');
  }
  const channel = interaction.channel;
  if (!channel?.isTextBased()) return ui.replyError(interaction, 'Utilise cette commande dans un salon textuel.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = await channel.send({ ...(await autolist.render(interaction.guildId, type?.id ?? null)), allowedMentions: { parse: [] } });
  await tickets.addAutolist({ guildId: interaction.guildId, channelId: channel.id, messageId: message.id, typeId: type?.id ?? null, createdBy: interaction.user.id });
  await ui.respond(
    interaction,
    ui.successCard('Liste publiée', `La liste des tickets ouverts${type ? ` (**${type.label}**)` : ''} est publiée ici et se met à jour toute seule. Supprime le message pour l’arrêter.`, '📋'),
  );
}

/** /ticket blacklist : interdit (ou réautorise) un membre d'ouvrir des tickets et d'écrire au staff par modmail. */
async function toggleBlacklist(ctx, interaction) {
  const { tickets } = ctx.services;
  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('raison');
  const removed = await tickets.removeBlacklist(interaction.guildId, target.id);
  if (!removed) await tickets.addBlacklist(interaction.guildId, target.id, reason, interaction.user.id);
  const text = removed
    ? `<@${target.id}> peut de nouveau ouvrir des tickets.`
    : `<@${target.id}> ne peut plus ouvrir de ticket ni écrire au staff par modmail${reason ? ` (raison : ${reason})` : ''}.`;
  await ui.respond(interaction, ui.successCard(removed ? 'Liste noire : retiré' : 'Liste noire : ajouté', text, '⛔'), { ephemeral: true });
  await ctx.services.logs.send(interaction.guildId, ui.card({ description: `⛔ **Liste noire des tickets** — ${text}\n🛠️ Par : <@${interaction.user.id}>`, timestamp: true }));
}

module.exports = {
  permission: { default: 'everyone' },
  help: {
    adminSubcommands: ['createpanel', 'logs', 'admin', 'blacklist', 'autolist'],
    isAdmin: (ctx, interaction) => isTicketAdmin(ctx, interaction.member),
  },

  async autocomplete(ctx, interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value ?? '').toLowerCase();
    if (focused.name === 'nom') {
      const snippets = await ctx.services.tickets.listSnippets(interaction.guildId);
      await interaction.respond(
        snippets
          .filter((s) => s.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((s) => ({ name: `${s.name} — ${s.content.replace(/\s+/g, ' ')}`.slice(0, 100), value: s.name })),
      );
      return;
    }
    if (focused.name === 'categorie') {
      const types = await ctx.services.tickets.listAllTypes(interaction.guildId);
      await interaction.respond(
        types
          .filter((t) => t.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((t) => ({ name: `${t.emoji ? `${t.emoji} ` : ''}${t.label}`.slice(0, 100), value: String(t.id) })),
      );
      return;
    }
    if (focused.name === 'etiquette') {
      const tags = await ctx.services.tickets.listTags(interaction.guildId);
      await interaction.respond(
        tags
          .filter((t) => t.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((t) => ({ name: `${t.emoji ? `${t.emoji} ` : ''}${t.name}`.slice(0, 100), value: String(t.id) })),
      );
    }
  },

  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Gérer les tickets')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('add').setDescription('Ajouter un membre au ticket courant').addUserOption((o) => o.setName('user').setDescription('Membre à ajouter').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('remove').setDescription('Retirer un membre du ticket courant').addUserOption((o) => o.setName('user').setDescription('Membre à retirer').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Fermer le ticket courant')
        .addStringOption((o) => o.setName('raison').setDescription('Raison de la fermeture').setRequired(true).setMaxLength(512)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reponse')
        .setDescription('Publier une réponse prédéfinie dans le ticket courant (staff)')
        .addStringOption((o) => o.setName('nom').setDescription('Réponse prédéfinie').setRequired(true).setAutocomplete(true).setMaxLength(50)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('tag')
        .setDescription('Ajouter ou retirer une étiquette sur le ticket courant')
        .addStringOption((o) => o.setName('etiquette').setDescription('Étiquette').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('blacklist')
        .setDescription('Interdire (ou réautoriser) un membre à ouvrir des tickets')
        .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
        .addStringOption((o) => o.setName('raison').setDescription('Raison (à l’ajout)').setMaxLength(300)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Lister les tickets ouverts, triés par priorité des étiquettes (staff)'))
    .addSubcommand((sub) =>
      sub
        .setName('autolist')
        .setDescription('Publier ici une liste des tickets ouverts, visible de tous et mise à jour automatiquement')
        .addStringOption((o) => o.setName('categorie').setDescription('Type de ticket à lister (vide = tous)').setAutocomplete(true)),
    )
    .addSubcommand((sub) => sub.setName('delay').setDescription('Voir les délais de reping/clôture automatique du ticket courant'))
    .addSubcommand((sub) => sub.setName('live').setDescription('Obtenir le lien de la transcription en direct du ticket courant'))
    .addSubcommand((sub) => sub.setName('createpanel').setDescription('Obtenir le lien du panel web pour créer/configurer un panel de tickets'))
    .addSubcommand((sub) =>
      sub.setName('logs').setDescription('Définir le salon de journal du module').addChannelOption((o) => o.setName('salon').setDescription('Salon de journal').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('admin').setDescription('Ajouter / retirer un admin du module Tickets').addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true)),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const sub = interaction.options.getSubcommand();

    if (sub === 'add' || sub === 'remove') return addRemove(ctx, interaction, sub);
    if (sub === 'delay') return delayInfo(ctx, interaction);
    if (sub === 'live') return liveLink(ctx, interaction);
    if (sub === 'reponse') return snippetReply(ctx, interaction);
    if (sub === 'tag') return toggleTag(ctx, interaction);
    if (sub === 'list') return listTickets(ctx, interaction);

    if (sub === 'close') {
      const { ticket, type, error } = await ticketOf(ctx, interaction);
      if (error) return ui.replyError(interaction, error);
      if (!(await canClose(ctx, ticket, type, interaction.member))) {
        return ui.replyError(interaction, 'Tu ne peux pas fermer ce ticket.', 'Accès refusé', ui.EMOJIS.permissions);
      }
      const reason = interaction.options.getString('raison', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await closeTicket(ctx, { ticket, type, channel: interaction.channel, closedBy: interaction.user.id, reason });
      await ui.respond(interaction, ui.successCard('Ticket fermé', `Le ticket #${ticket.id} a été fermé.`, '🔒'));
      return;
    }

    if (['createpanel', 'logs', 'admin', 'blacklist', 'autolist'].includes(sub)) {
      if (!(await isTicketAdmin(ctx, interaction.member))) {
        return ui.replyError(interaction, 'Réservé aux admins du module Tickets (voir `/ticket admin`) ou aux administrateurs du serveur.', 'Accès refusé', ui.EMOJIS.permissions);
      }
    }

    if (sub === 'blacklist') return toggleBlacklist(ctx, interaction);
    if (sub === 'autolist') return publishAutolist(ctx, interaction);

    if (sub === 'createpanel') {
      const url = ticketsUrl(ctx.config, `?guild=${guild.id}`);
      if (!url) return ui.replyError(interaction, 'Le panel web est désactivé sur ce bot.');
      const card = ui.card({
        emoji: '🎫',
        title: 'Configuration des panels de tickets',
        description: `**${url}**`,
        body: [
          new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ouvrir le panel').setURL(url)),
        ],
      });
      try {
        await ui.respond(interaction, card, { ephemeral: true });
      } catch (err) {
        if (err?.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType) throw err;
        await ui.respond(interaction, ui.card({ emoji: '🎫', title: 'Configuration des panels de tickets', description: `**${url}**` }), { ephemeral: true });
      }
      return;
    }

    if (sub === 'logs') {
      const channel = interaction.options.getChannel('salon', true);
      const me = guild.members.me;
      if (!channel.permissionsFor?.(me)?.has(['ViewChannel', 'SendMessages'])) {
        return ui.replyError(interaction, `Le bot ne peut pas écrire dans <#${channel.id}>.`, 'Salon inaccessible', '⚠️');
      }
      await ctx.services.tickets.setLogChannel(guild.id, channel.id);
      await ui.respond(interaction, ui.successCard('Journal configuré', `Les tickets seront journalisés dans <#${channel.id}>.`, '🎫'), { ephemeral: true });
      return;
    }

    if (sub === 'admin') {
      const target = interaction.options.getUser('user', true);
      const already = await ctx.services.tickets.isAdmin(guild.id, target.id);
      if (already) {
        await ctx.services.tickets.removeAdmin(guild.id, target.id);
        await revokeAdminAccess(ctx, guild, target.id);
        await ui.respond(interaction, ui.successCard('Admin retiré', `<@${target.id}> n’est plus admin du module Tickets.`, '🎫'), { ephemeral: true });
      } else {
        await ctx.services.tickets.addAdmin(guild.id, target.id, interaction.user.id);
        await grantAdminAccess(ctx, guild, target.id);
        await ui.respond(interaction, ui.successCard('Admin ajouté', `<@${target.id}> est maintenant admin du module Tickets.`, '🎫'), { ephemeral: true });
      }
    }
  },
};
