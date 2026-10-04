'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { STATUSES, RECRUITER_STATUSES, isFinal } = require('./statuses');

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Boutons ou sélecteur du message de panel : un par catégorie de candidature. */
function panelComponents(categories, style) {
  if (!categories.length) return [];
  if (style === 'select') {
    const select = new StringSelectMenuBuilder().setCustomId('cand:open').setPlaceholder('Choisir la candidature à déposer…').addOptions(
      categories.slice(0, 25).map((category) => {
        const option = new StringSelectMenuOptionBuilder().setLabel(category.label.slice(0, 100)).setValue(String(category.id));
        if (category.select_description) option.setDescription(category.select_description.slice(0, 100));
        if (category.emoji) option.setEmoji(category.emoji);
        return option;
      }),
    );
    return [new ActionRowBuilder().addComponents(select)];
  }
  const rows = [];
  for (let i = 0; i < Math.min(categories.length, 25); i += 5) {
    const row = new ActionRowBuilder();
    for (const category of categories.slice(i, i + 5)) {
      const button = new ButtonBuilder().setCustomId(`cand:open:${category.id}`).setLabel(category.label.slice(0, 80)).setStyle(BUTTON_STYLES[category.button_style] ?? ButtonStyle.Primary);
      if (category.emoji) button.setEmoji(category.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Composants du message d'accueil, dans le salon de la candidature :
 *  - candidat : « Terminer » (tant qu'il rédige) et « Retirer » ;
 *  - recruteurs (vérifié au clic) : menu de statut et « Changer de catégorie » ;
 *  - une fois terminée : lien vers la transcription et suppression du salon (recruteurs).
 */
function controls(candidature, { transcriptUrl = null } = {}) {
  if (isFinal(candidature.status)) {
    const buttons = [];
    if (transcriptUrl) buttons.push(new ButtonBuilder().setURL(transcriptUrl).setLabel('Voir la transcription').setStyle(ButtonStyle.Link).setEmoji('📄'));
    buttons.push(new ButtonBuilder().setCustomId(`cand:delete:${candidature.id}`).setLabel('Supprimer le salon').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
    return [new ActionRowBuilder().addComponents(buttons)];
  }
  const buttons = [];
  if (candidature.status === 'draft') buttons.push(new ButtonBuilder().setCustomId(`cand:finish:${candidature.id}`).setLabel('Terminer ma candidature').setStyle(ButtonStyle.Success).setEmoji('✅'));
  buttons.push(new ButtonBuilder().setCustomId(`cand:withdraw:${candidature.id}`).setLabel('Retirer').setStyle(ButtonStyle.Secondary).setEmoji('↩️'));
  buttons.push(new ButtonBuilder().setCustomId(`cand:move:${candidature.id}`).setLabel('Changer de catégorie').setStyle(ButtonStyle.Secondary).setEmoji('🔀'));
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cand:status:${candidature.id}`)
    .setPlaceholder('Recruteurs : changer le statut…')
    .addOptions(RECRUITER_STATUSES.map((key) => new StringSelectMenuOptionBuilder().setLabel(STATUSES[key].label).setValue(key).setEmoji(STATUSES[key].emoji).setDefault(key === candidature.status)));
  return [new ActionRowBuilder().addComponents(buttons), new ActionRowBuilder().addComponents(select)];
}

/** Choix de la catégorie de destination (hors catégorie actuelle). */
function categorySelect(candidature, categories) {
  const options = categories
    .filter((category) => String(category.id) !== String(candidature.category_id))
    .slice(0, 25)
    .map((category) => {
      const option = new StringSelectMenuOptionBuilder().setLabel(category.label.slice(0, 100)).setValue(String(category.id));
      if (category.emoji) option.setEmoji(category.emoji);
      return option;
    });
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`cand:moveto:${candidature.id}`).setPlaceholder('Déplacer vers la catégorie…').addOptions(options));
}

module.exports = { panelComponents, controls, categorySelect };
