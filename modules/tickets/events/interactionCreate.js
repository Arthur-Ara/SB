'use strict';

const { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { canClose, canManage } = require('../lib/guard');
const { openTicket, openTicketProblem, closeTicket, reopenTicket, deleteTicket, syncChannelName, transferTicket, refreshLists } = require('../lib/lifecycle');
const { openTicketControls, transferSelect } = require('../lib/components');
const { AUTO_CLOSE_REASON } = require('../lib/autoclose');
const { hasForm, formModal, readAnswers } = require('../lib/form');

async function typeAndPanel(ctx, interaction, typeId) {
  const type = await ctx.services.tickets.getType(typeId);
  if (!type) return { error: 'Ce type de ticket n’existe plus.' };
  const panel = await ctx.services.tickets.getPanel(type.panel_id);
  if (!panel || String(panel.guild_id) !== interaction.guildId) return { error: 'Ce panel n’existe plus.' };
  return { type, panel };
}

/** Clic d'ouverture : formulaire (si activé pour ce type, après les vérifications) ou ouverture directe. */
async function handleOpen(ctx, interaction, typeId) {
  const { type, panel, error } = await typeAndPanel(ctx, interaction, typeId);
  if (error) return ui.replyError(interaction, error);

  if (hasForm(type)) {
    // Vérifié avant d'afficher le formulaire : inutile de le faire remplir pour refuser ensuite.
    const problem = await openTicketProblem(ctx, { type, guild: interaction.guild, opener: interaction.user });
    if (problem) return ui.replyError(interaction, problem, 'Action impossible', '⚠️');
    return interaction.showModal(formModal(type, `ticket:form:${type.id}`));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await openTicket(ctx, { panel, type, guild: interaction.guild, opener: interaction.user });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Action impossible', '⚠️'));
  await ui.respond(interaction, ui.successCard('Ticket ouvert', `Ton ticket a été créé : <#${result.channel.id}>`, '🎫'));
}

/** Formulaire d'ouverture soumis : le ticket est créé avec les réponses. */
async function handleFormSubmit(ctx, interaction, typeId) {
  const { type, panel, error } = await typeAndPanel(ctx, interaction, typeId);
  if (error) return ui.replyError(interaction, error);
  const answers = readAnswers(interaction, type);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await openTicket(ctx, { panel, type, guild: interaction.guild, opener: interaction.user, answers });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Action impossible', '⚠️'));
  await ui.respond(interaction, ui.successCard('Ticket ouvert', `Ton ticket a été créé : <#${result.channel.id}>`, '🎫'));
}

/** Bouton « Transférer » : réservé aux modérateurs du ticket ; propose les autres types du serveur. */
async function handleTransferButton(ctx, interaction, ticketId) {
  const { tickets } = ctx.services;
  const ticket = await tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return ui.replyError(interaction, 'Ce ticket n’est plus ouvert.');
  const type = await tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  const [types, panels] = await Promise.all([tickets.listAllTypes(interaction.guildId), tickets.listPanels(interaction.guildId)]);
  const row = transferSelect(ticket, types, new Map(panels.map((p) => [String(p.id), p])));
  if (!row) return ui.replyError(interaction, 'Aucun autre type de ticket vers lequel transférer.', 'Transfert impossible', '🔀');
  await interaction.reply({
    ...ui.payload(ui.card({ description: `🔀 Vers quel type transférer le ticket **#${ticket.id}** ?\n-# Le salon change de catégorie et de rôles modérateur/helper.` }), { ephemeral: true }),
    components: [row],
  });
}

async function handleTransferSelect(ctx, interaction, ticketId) {
  const { tickets } = ctx.services;
  const ticket = await tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return interaction.update({ ...ui.payload(ui.errorCard('Ce ticket n’est plus ouvert.')), components: [] });
  const fromType = await tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, fromType))) {
    return interaction.update({ ...ui.payload(ui.errorCard('Réservé aux modérateurs de ce ticket.', 'Accès refusé', ui.EMOJIS.permissions)), components: [] });
  }
  const toType = await tickets.getType(interaction.values[0]);
  if (!toType) return interaction.update({ ...ui.payload(ui.errorCard('Ce type n’existe plus.')), components: [] });

  // Deuxième étape : republier (ou non) le message d'accueil du nouveau type dans le ticket.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:transfergo:${ticket.id}:${toType.id}:1`).setLabel('Avec le message d’accueil').setStyle(ButtonStyle.Primary).setEmoji('📨'),
    new ButtonBuilder().setCustomId(`ticket:transfergo:${ticket.id}:${toType.id}:0`).setLabel('Sans').setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    ...ui.payload(ui.card({ description: `🔀 Transfert vers **${toType.label}**.\nRepublier dans le ticket l’embed d’accueil de ce type ?` })),
    components: [row],
  });
}

async function handleTransferGo(ctx, interaction, ticketId, toTypeId, resendWelcome) {
  const { tickets } = ctx.services;
  const ticket = await tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return interaction.update({ ...ui.payload(ui.errorCard('Ce ticket n’est plus ouvert.')), components: [] });
  const fromType = await tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, fromType))) {
    return interaction.update({ ...ui.payload(ui.errorCard('Réservé aux modérateurs de ce ticket.', 'Accès refusé', ui.EMOJIS.permissions)), components: [] });
  }
  const toType = await tickets.getType(toTypeId);
  if (!toType) return interaction.update({ ...ui.payload(ui.errorCard('Ce type n’existe plus.')), components: [] });
  const channel = interaction.guild.channels.cache.get(String(ticket.channel_id));
  if (!channel) return interaction.update({ ...ui.payload(ui.errorCard('Salon du ticket introuvable.')), components: [] });

  await interaction.update({ ...ui.payload(ui.card({ description: `🔀 Transfert vers **${toType.label}**…` })), components: [] });
  const result = await transferTicket(ctx, { ticket, fromType, toType, channel, executorId: interaction.user.id, resendWelcome });
  const card = result.error ? ui.errorCard(result.error, 'Transfert impossible', '🔀') : ui.successCard(
        'Ticket transféré',
        `Le ticket #${ticket.id} est maintenant de type **${toType.label}**.\n-# Le nom du salon peut mettre jusqu’à 10 minutes à suivre : Discord limite le renommage d’un salon à 2 fois par 10 minutes.`,
        '🔀',
      );
  await interaction.editReply({ ...ui.message(card), components: [] }).catch(() => {});
}

async function handleClaim(ctx, interaction, ticketId, claiming) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return ui.replyError(interaction, 'Ce ticket n’est plus ouvert.');
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce type de ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  if (claiming) await ctx.services.tickets.claim(ticket.id, interaction.user.id);
  else await ctx.services.tickets.unclaim(ticket.id);

  const updated = { ...ticket, claimed_by: claiming ? interaction.user.id : null };
  await interaction.update({ components: openTicketControls(updated) }).catch(() => {});
  syncChannelName(ctx, interaction.channel, type, updated, claiming ? 'claimed' : 'open');
  await ctx.services.logs.claim(interaction.guild, updated, type, interaction.user.id, claiming);
  refreshLists(ctx, interaction.guildId);
}

async function handleCloseButton(ctx, interaction, ticketId) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return ui.replyError(interaction, 'Ce ticket n’est plus ouvert.', 'Action impossible', '⚠️');
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!(await canClose(ctx, ticket, type, interaction.member))) {
    return ui.replyError(interaction, 'Tu ne peux pas fermer ce ticket.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  const modal = new ModalBuilder()
    .setCustomId(`ticket:closemodal:${ticketId}`)
    .setTitle('Fermer le ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Raison de la fermeture').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(512),
      ),
    );
  await interaction.showModal(modal);
}

async function handleCloseModal(ctx, interaction, ticketId) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') return ui.replyError(interaction, 'Ce ticket n’est plus ouvert.');
  const type = await ctx.services.tickets.getType(ticket.type_id);
  const reason = interaction.fields.getTextInputValue('reason');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await closeTicket(ctx, { ticket, type, channel: interaction.channel, closedBy: interaction.user.id, reason });
  await ui.respond(interaction, ui.successCard('Ticket fermé', `Le ticket #${ticket.id} a été fermé.`, '🔒'));
}

/**
 * Réponse du staff à la demande de fermeture automatique (voir lib/autoclose.js) : « Confirmer » ferme le
 * ticket comme le bouton Fermer (message de fermeture avec transcript / réouverture / suppression) mais sans
 * demande de notation à l'ouvreur ; « Garder ouvert » relance le délai d'inactivité.
 */
async function handleAutoClose(ctx, interaction, ticketId, confirm) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket || ticket.status !== 'open') {
    await interaction.update({ components: [] }).catch(() => {});
    return;
  }
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce type de ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  if (!confirm) {
    await ctx.services.tickets.keepOpen(ticket.id);
    await interaction.update({
      content: '',
      ...ui.payload(ui.card({ description: `↩️ **Le ticket reste ouvert** (décision de <@${interaction.user.id}>). Le délai d’inactivité repart de zéro.` })),
      components: [],
    });
    return;
  }
  await interaction.update({
    content: '',
    ...ui.payload(ui.card({ description: `🔒 **Fermeture confirmée** par <@${interaction.user.id}>.` })),
    components: [],
  });
  await closeTicket(ctx, { ticket, type, channel: interaction.channel, closedBy: interaction.user.id, reason: AUTO_CLOSE_REASON, auto: true });
}

async function handleReopen(ctx, interaction, ticketId) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket) return ui.replyError(interaction, 'Ce ticket n’existe plus.');
  if (ticket.status !== 'closed') return ui.replyError(interaction, 'Ce ticket n’est pas fermé.', 'Action impossible', '⚠️');
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce type de ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  await interaction.update({ components: [] }).catch(() => {});
  await reopenTicket(ctx, { ticket, channel: interaction.channel, executorId: interaction.user.id });
}

async function handleDelete(ctx, interaction, ticketId) {
  const ticket = await ctx.services.tickets.getTicket(ticketId);
  if (!ticket) return ui.replyError(interaction, 'Ce ticket n’existe plus.');
  if (ticket.status !== 'closed') return ui.replyError(interaction, 'Ferme d’abord ce ticket avant de supprimer son salon.', 'Action impossible', '⚠️');
  const type = await ctx.services.tickets.getType(ticket.type_id);
  if (!(await canManage(ctx, interaction.member, type))) {
    return ui.replyError(interaction, 'Réservé aux modérateurs de ce type de ticket ou aux admins du module.', 'Accès refusé', ui.EMOJIS.permissions);
  }
  await interaction.reply(ui.payload(ui.successCard('Suppression…', 'Ce salon va être supprimé.', '🗑️'), { ephemeral: true })).catch(() => {});
  await deleteTicket(ctx, { ticket, type, channel: interaction.channel, executorId: interaction.user.id });
}

module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    if (!interaction.inGuild()) return;

    if (interaction.isButton()) {
      const [ns, action, id, extra, flag] = interaction.customId.split(':');
      if (ns !== 'ticket') return;
      try {
        if (action === 'open') await handleOpen(ctx, interaction, id);
        else if (action === 'transfergo') await handleTransferGo(ctx, interaction, id, extra, flag === '1');
        else if (action === 'claim') await handleClaim(ctx, interaction, id, true);
        else if (action === 'unclaim') await handleClaim(ctx, interaction, id, false);
        else if (action === 'close') await handleCloseButton(ctx, interaction, id);
        else if (action === 'acyes') await handleAutoClose(ctx, interaction, id, true);
        else if (action === 'acno') await handleAutoClose(ctx, interaction, id, false);
        else if (action === 'reopen') await handleReopen(ctx, interaction, id);
        else if (action === 'delete') await handleDelete(ctx, interaction, id);
        else if (action === 'transfer') await handleTransferButton(ctx, interaction, id);
      } catch (err) {
        ctx.logger.error(`Interaction ticket:${action} impossible`, err);
        await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:open') {
      try {
        await handleOpen(ctx, interaction, interaction.values[0]);
      } catch (err) {
        ctx.logger.error('Interaction ticket:open (sélecteur) impossible', err);
        await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket:transferto:')) {
      try {
        await handleTransferSelect(ctx, interaction, interaction.customId.split(':')[2]);
      } catch (err) {
        ctx.logger.error('Transfert de ticket impossible', err);
        await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const [ns, action, id] = interaction.customId.split(':');
      if (ns !== 'ticket' || (action !== 'closemodal' && action !== 'form')) return;
      try {
        if (action === 'form') await handleFormSubmit(ctx, interaction, id);
        else await handleCloseModal(ctx, interaction, id);
      } catch (err) {
        ctx.logger.error(`Fenêtre ticket:${action} impossible`, err);
        await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
      }
    }
  },
};
