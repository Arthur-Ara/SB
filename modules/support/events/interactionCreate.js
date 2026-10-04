'use strict';

const { Events, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { buildEmbed } = require('../../tickets/lib/embed');
const { pickerRow, responseRow } = require('../lib/components');
const { openTicket, openTicketProblem } = require('../../tickets/lib/lifecycle');
const { hasForm, formModal, readAnswers } = require('../../tickets/lib/form');

function nodeEmbed(node) {
  return buildEmbed({
    title: node.embed_title,
    description: node.embed_description,
    color: node.embed_color,
    footer: node.embed_footer,
    image: node.embed_image,
    thumbnail: node.embed_thumbnail,
  });
}

/** Répond au clic initial (message public du panel, jamais éphémère) ou met à jour le message en
 * place s'il s'agit d'une navigation dans le fil déjà éphémère — un seul message qui se déplie. */
function respondOrUpdate(interaction, payload) {
  const alreadyEphemeral = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
  if (alreadyEphemeral) return interaction.update(payload);
  // Le sélecteur du panel public reste visuellement « sélectionné » pour cet utilisateur tant que
  // le message n'est pas réédité (Discord ne réinitialise pas l'affichage tout seul) : on renvoie
  // les mêmes composants pour le réinitialiser, en parallèle de la réponse éphémère.
  interaction.message?.edit({ components: interaction.message.components }).catch(() => {});
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

const NO_ACCESS = 'Cette rubrique est réservée à certains rôles.';

async function showNode(ctx, interaction, node) {
  const { support } = ctx.services;
  const embed = nodeEmbed(node);
  let components = [];
  let content;

  if (node.kind === 'category') {
    // Sous-menu propre au membre : seules les rubriques auxquelles ses rôles donnent accès y figurent.
    const children = [];
    for (const child of await support.listChildren(node.panel_id, node.id)) {
      if (!child.allowed_role_ids.length || child.allowed_role_ids.some((id) => interaction.member?.roles?.cache?.has(id))) children.push(child);
    }
    if (children.length) components = [pickerRow(children, 'Choisis une option…')];
    else if (!embed) content = 'Aucune option disponible dans cette catégorie pour le moment.';
  } else {
    components = [responseRow(node.id, { allowTicket: Boolean(node.allow_ticket && node.ticket_type_id) })];
    if (!embed) content = 'Aucune information configurée pour cette réponse pour le moment.';
  }

  await respondOrUpdate(interaction, { content, embeds: embed ? [embed] : [], components });
  support.recordView(node).catch(() => {});
}

async function handlePick(ctx, interaction) {
  const { support } = ctx.services;
  const node = await support.getNode(interaction.values[0]);
  if (!node) {
    await interaction.update({ content: 'Cette option n’existe plus.', embeds: [], components: [] }).catch(() => {});
    return;
  }
  // Le menu du panel public est le même pour tous : l'accès est vérifié au choix.
  if (!(await support.canSee(node, interaction.member))) {
    await respondOrUpdate(interaction, { content: `🔒 ${NO_ACCESS}`, embeds: [], components: [] });
    return;
  }
  await showNode(ctx, interaction, node);
}

/** Avis sous une réponse : enregistré (le dernier remplace le précédent), bouton choisi mis en évidence. */
async function handleFeedback(ctx, interaction, nodeId, helpful) {
  const { support } = ctx.services;
  const node = await support.getNode(nodeId);
  if (!node) return ui.replyError(interaction, 'Cette réponse n’existe plus.');
  await support.setFeedback(node, interaction.user.id, helpful);
  const row = responseRow(node.id, { allowTicket: Boolean(node.allow_ticket && node.ticket_type_id), voted: helpful });
  const thanks = helpful ? '👍 Merci pour ton retour !' : `👎 Merci pour ton retour.${node.allow_ticket && node.ticket_type_id ? ' Tu peux ouvrir un ticket avec le bouton 🎫 pour obtenir de l’aide.' : ''}`;
  // Message éphémère de navigation : on le met à jour en place ; sinon (cas rare) simple réponse privée.
  if (interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
    await interaction.update({ content: thanks, components: [row] });
  } else {
    await interaction.reply({ content: thanks, flags: MessageFlags.Ephemeral });
  }
}

/** Réponse, type et panel de tickets visés par un bouton « Créer un ticket » : { node, type, panel, ticketsCtx } ou { error }. */
async function ticketTarget(ctx, interaction, nodeId) {
  const node = await ctx.services.support.getNode(nodeId);
  if (!node || !node.allow_ticket || !node.ticket_type_id) return { error: 'La création de ticket n’est pas (ou plus) disponible pour cette réponse.' };
  if (!(await ctx.services.support.canSee(node, interaction.member))) return { error: NO_ACCESS };
  if (!ctx.modules.isEnabledFor('tickets', interaction.guildId)) return { error: 'Le module Tickets est désactivé sur ce serveur.' };
  const ticketsServices = ctx.modules.services('tickets');
  if (!ticketsServices) return { error: 'Le module Tickets est indisponible pour le moment.' };

  const type = await ticketsServices.tickets.getType(node.ticket_type_id);
  if (!type) return { error: 'Le type de ticket configuré n’existe plus : contacte un administrateur.' };
  const panel = await ticketsServices.tickets.getPanel(type.panel_id);
  if (!panel || String(panel.guild_id) !== interaction.guildId) return { error: 'Le panel de tickets associé n’existe plus sur ce serveur : contacte un administrateur.' };
  // openTicket() n'utilise que ctx.services.tickets/ctx.services.logs : on lui passe le ctx du
  // module Tickets (via l'accesseur ctx.modules.services()) plutôt que le nôtre, qui ne les a pas.
  return { node, type, panel, ticketsCtx: { services: ticketsServices } };
}

async function handleTicketButton(ctx, interaction, nodeId) {
  const target = await ticketTarget(ctx, interaction, nodeId);
  if (target.error) return ui.replyError(interaction, target.error);
  const { node, type, panel, ticketsCtx } = target;

  // Formulaire d'ouverture du type (module Tickets) : vérifications d'abord, puis questions.
  if (hasForm(type)) {
    const problem = await openTicketProblem(ticketsCtx, { type, guild: interaction.guild, opener: interaction.user });
    if (problem) return ui.replyError(interaction, problem, 'Action impossible', '⚠️');
    return interaction.showModal(formModal(type, `support:form:${node.id}`));
  }
  return openFromNode(ctx, interaction, target, []);
}

async function handleFormSubmit(ctx, interaction, nodeId) {
  const target = await ticketTarget(ctx, interaction, nodeId);
  if (target.error) return ui.replyError(interaction, target.error);
  return openFromNode(ctx, interaction, target, readAnswers(interaction, target.type));
}

async function openFromNode(ctx, interaction, { node, type, panel, ticketsCtx }, answers) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await openTicket(ticketsCtx, { panel, type, guild: interaction.guild, opener: interaction.user, answers });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Action impossible', '⚠️'));
  await ctx.services.support.recordEscalation(node, interaction.user.id, result.ticket.id).catch(() => {});

  if (node.ticket_extra_message) {
    await result.channel
      .send(ui.payload(ui.card({ description: `🤖 **Message automatique (support)** :\n${node.ticket_extra_message}`, timestamp: true })))
      .catch(() => {});
  }
  await ui.respond(interaction, ui.successCard('Ticket ouvert', `Ton ticket a été créé : <#${result.channel.id}>`, '🎫'));
}

module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    try {
      if (interaction.isStringSelectMenu() && interaction.customId === 'support:pick') {
        await handlePick(ctx, interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith('support:ticket:')) {
        const [, , nodeId] = interaction.customId.split(':');
        await handleTicketButton(ctx, interaction, nodeId);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith('support:fb:')) {
        const [, , nodeId, value] = interaction.customId.split(':');
        await handleFeedback(ctx, interaction, nodeId, value === '1');
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('support:form:')) {
        const [, , nodeId] = interaction.customId.split(':');
        await handleFormSubmit(ctx, interaction, nodeId);
        return;
      }
    } catch (err) {
      ctx.logger.error('Interaction support impossible', err);
      await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
    }
  },
};
