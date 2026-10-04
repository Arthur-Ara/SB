'use strict';

const { Events, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { STATUSES, RECRUITER_STATUSES, isFinal } = require('../lib/statuses');
const { hasForm, formModal, readAnswers } = require('../lib/form');
const { isRecruiter } = require('../lib/guard');
const { openCandidature, openProblem, setStatus, finishCandidature, changeCategory, deleteChannel } = require('../lib/lifecycle');
const { categorySelect } = require('../lib/components');

const DENIED = ['Réservé aux recruteurs de cette candidature.', 'Accès refusé', ui.EMOJIS.permissions];

async function categoryOf(ctx, interaction, categoryId) {
  const category = await ctx.services.candidatures.getCategory(categoryId);
  if (!category || String(category.guild_id) !== interaction.guildId) return { error: 'Cette candidature n’existe plus.' };
  return { category };
}

/** Candidature + catégorie à partir de l'id d'un composant, en vérifiant qu'elle appartient bien à ce serveur. */
async function loadCandidature(ctx, interaction, id) {
  const candidature = await ctx.services.candidatures.getCandidature(id);
  if (!candidature || String(candidature.guild_id) !== interaction.guildId) return { error: 'Candidature introuvable.' };
  const category = await ctx.services.candidatures.getCategory(candidature.category_id);
  return { candidature, category };
}

/** Clic d'ouverture : formulaire (si activé, après vérification) ou ouverture directe. */
async function handleOpen(ctx, interaction, categoryId) {
  const { category, error } = await categoryOf(ctx, interaction, categoryId);
  if (error) return ui.replyError(interaction, error);
  if (hasForm(category)) {
    const problem = await openProblem(ctx, { category, guild: interaction.guild, user: interaction.user });
    if (problem) return ui.replyError(interaction, problem, 'Action impossible', '⚠️');
    return interaction.showModal(formModal(category, `cand:form:${category.id}`));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await open(ctx, interaction, category, []);
}

async function open(ctx, interaction, category, answers) {
  const result = await openCandidature(ctx, { category, guild: interaction.guild, user: interaction.user, answers });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Action impossible', '⚠️'));
  await ui.respond(interaction, ui.successCard('Candidature ouverte', `Ton salon est créé : <#${result.channel.id}>`, '📨'));
}

async function handleFormSubmit(ctx, interaction, categoryId) {
  const { category, error } = await categoryOf(ctx, interaction, categoryId);
  if (error) return ui.replyError(interaction, error);
  const answers = readAnswers(interaction, category);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await open(ctx, interaction, category, answers);
}

async function handleFinish(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (interaction.user.id !== String(candidature.applicant_id)) return ui.replyError(interaction, 'Seul le candidat peut terminer sa candidature.', 'Accès refusé', ui.EMOJIS.permissions);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await finishCandidature(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Candidature non envoyée', '⚠️'));
  await ui.respond(interaction, ui.successCard('Candidature terminée', `Statut : **${STATUSES[result.candidature.status].label}**.`, STATUSES[result.candidature.status].emoji));
}

async function handleWithdraw(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (interaction.user.id !== String(candidature.applicant_id) && !isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, 'Seul le candidat peut retirer sa candidature.', 'Accès refusé', ui.EMOJIS.permissions);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await setStatus(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel, status: 'withdrawn', reason: 'Candidature retirée.', by: interaction.user.id });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error));
  await ui.respond(interaction, ui.successCard('Candidature retirée', 'Tu peux en déposer une nouvelle quand tu veux.', '↩️'));
}

function reasonModal(candidatureId, status, required) {
  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(status === 'refused' ? 'Motif du refus' : 'Précision (facultatif)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(required)
    .setMaxLength(900);
  return new ModalBuilder().setCustomId(`cand:reason:${candidatureId}:${status}`).setTitle(`${STATUSES[status].label}`.slice(0, 45)).addComponents(new ActionRowBuilder().addComponents(input));
}

/** Menu de statut du salon (recruteurs). Refus / acceptation : une fenêtre demande le motif. */
async function handleStatusSelect(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, ...DENIED);
  const status = interaction.values[0];
  if (!RECRUITER_STATUSES.includes(status)) return ui.replyError(interaction, 'Statut inconnu.');
  if (status === 'refused' || status === 'accepted') {
    const settings = await ctx.services.candidatures.settings(interaction.guildId);
    return interaction.showModal(reasonModal(candidature.id, status, status === 'refused' && settings.refusalReasonRequired));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await setStatus(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel, status, by: interaction.user.id });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error));
  await ui.respond(interaction, ui.successCard('Statut modifié', `${STATUSES[status].emoji} ${STATUSES[status].label}`));
}

async function handleReasonSubmit(ctx, interaction, id, status) {
  if (!RECRUITER_STATUSES.includes(status)) return ui.replyError(interaction, 'Statut inconnu.');
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, ...DENIED);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await setStatus(ctx, { candidature, category, guild: interaction.guild, channel: interaction.channel, status, reason: interaction.fields.getTextInputValue('reason'), by: interaction.user.id });
  if (result.error) return ui.respond(interaction, ui.errorCard(result.error));
  await ui.respond(interaction, ui.successCard('Statut modifié', `${STATUSES[status].emoji} ${STATUSES[status].label}`));
}

async function handleMoveButton(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, ...DENIED);
  if (isFinal(candidature.status)) return ui.replyError(interaction, 'Cette candidature est clôturée.');
  const row = categorySelect(candidature, await ctx.services.candidatures.listCategories(interaction.guildId));
  if (!row) return ui.replyError(interaction, 'Aucune autre catégorie de candidature.', 'Déplacement impossible', '🔀');
  await interaction.reply({
    ...ui.payload(ui.card({ description: `🔀 Vers quelle catégorie déplacer la candidature **#${candidature.id}** ?\n-# Le salon change de catégorie Discord et de recruteurs ; les critères de la nouvelle catégorie s'appliquent.` }), { ephemeral: true }),
    components: [row],
  });
}

async function handleMoveSelect(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return interaction.update({ ...ui.payload(ui.errorCard(error)), components: [] });
  if (!isRecruiter(ctx, interaction.member, category)) return interaction.update({ ...ui.payload(ui.errorCard(...DENIED)), components: [] });
  const { category: target, error: targetError } = await categoryOf(ctx, interaction, interaction.values[0]);
  if (targetError) return interaction.update({ ...ui.payload(ui.errorCard(targetError)), components: [] });
  await interaction.deferUpdate();
  const channel = interaction.guild.channels.cache.get(String(candidature.channel_id)) ?? null;
  const result = await changeCategory(ctx, { candidature, fromCategory: category, toCategory: target, guild: interaction.guild, channel, by: interaction.user.id });
  const card = result.error ? ui.errorCard(result.error) : ui.successCard('Catégorie modifiée', `Candidature #${candidature.id} → **${target.label}**.`, '🔀');
  await interaction.editReply({ ...ui.payload(card), components: [] });
}

async function handleDelete(ctx, interaction, id) {
  const { candidature, category, error } = await loadCandidature(ctx, interaction, id);
  if (error) return ui.replyError(interaction, error);
  if (!isRecruiter(ctx, interaction.member, category)) return ui.replyError(interaction, ...DENIED);
  if (!isFinal(candidature.status)) return ui.replyError(interaction, 'Clôture d’abord la candidature (accepter, refuser ou retirer).');
  await interaction.reply({ ...ui.payload(ui.successCard('Salon supprimé', 'La candidature et sa transcription restent consultables sur le panel.'), { ephemeral: true }) }).catch(() => {});
  await deleteChannel(ctx, { candidature, channel: interaction.channel, executorId: interaction.user.id });
}

module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    if (!interaction.inGuild() || !interaction.customId?.startsWith('cand:')) return;
    const [, action, id, extra] = interaction.customId.split(':');
    try {
      if (interaction.isButton()) {
        if (action === 'open') return await handleOpen(ctx, interaction, id);
        if (action === 'finish') return await handleFinish(ctx, interaction, id);
        if (action === 'withdraw') return await handleWithdraw(ctx, interaction, id);
        if (action === 'move') return await handleMoveButton(ctx, interaction, id);
        if (action === 'delete') return await handleDelete(ctx, interaction, id);
      } else if (interaction.isStringSelectMenu()) {
        if (action === 'open') return await handleOpen(ctx, interaction, interaction.values[0]);
        if (action === 'status') return await handleStatusSelect(ctx, interaction, id);
        if (action === 'moveto') return await handleMoveSelect(ctx, interaction, id);
      } else if (interaction.isModalSubmit()) {
        if (action === 'form') return await handleFormSubmit(ctx, interaction, id);
        if (action === 'reason') return await handleReasonSubmit(ctx, interaction, id, extra);
      }
    } catch (err) {
      ctx.logger.error(`Interaction cand:${action} impossible`, err);
      await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
    }
  },
};
