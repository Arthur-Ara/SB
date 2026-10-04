'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Boutons ou sélecteur du message de panel, un par type (bouton/option), pour ouvrir un ticket. */
function panelComponents(types, style) {
  if (!types.length) return [];
  if (style === 'select') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('ticket:open')
      .setPlaceholder('Choisir le type de ticket à ouvrir…')
      .addOptions(
        types.slice(0, 25).map((type) => {
          const option = new StringSelectMenuOptionBuilder().setLabel(type.label.slice(0, 100)).setValue(String(type.id));
          if (type.select_description) option.setDescription(type.select_description.slice(0, 100));
          if (type.emoji) option.setEmoji(type.emoji);
          return option;
        }),
      );
    return [new ActionRowBuilder().addComponents(select)];
  }
  const rows = [];
  for (let i = 0; i < Math.min(types.length, 25); i += 5) {
    const row = new ActionRowBuilder();
    for (const type of types.slice(i, i + 5)) {
      const button = new ButtonBuilder()
        .setCustomId(`ticket:open:${type.id}`)
        .setLabel(type.label.slice(0, 80))
        .setStyle(BUTTON_STYLES[type.button_style] ?? ButtonStyle.Primary);
      if (type.emoji) button.setEmoji(type.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

/** Boutons du message d'accueil, à l'intérieur d'un ticket ouvert : prendre en charge / transférer / fermer. */
function openTicketControls(ticket) {
  const claim = ticket.claimed_by
    ? new ButtonBuilder().setCustomId(`ticket:unclaim:${ticket.id}`).setLabel('Relâcher').setStyle(ButtonStyle.Secondary).setEmoji('🙋')
    : new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Secondary).setEmoji('🙋');
  // Réservé aux modérateurs du ticket (vérifié au clic) : changer de type déplace le salon et ses rôles.
  const transfer = new ButtonBuilder().setCustomId(`ticket:transfer:${ticket.id}`).setLabel('Transférer').setStyle(ButtonStyle.Secondary).setEmoji('🔀');
  const close = new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒');
  return [new ActionRowBuilder().addComponents(claim, transfer, close)];
}

/** Choix du type de destination d'un transfert (types des autres panels inclus, hors type actuel). */
function transferSelect(ticket, types, panelsById) {
  const options = types
    .filter((type) => String(type.id) !== String(ticket.type_id))
    .slice(0, 25)
    .map((type) => {
      const option = new StringSelectMenuOptionBuilder().setLabel(type.label.slice(0, 100)).setValue(String(type.id));
      const panel = panelsById.get(String(type.panel_id));
      option.setDescription(`Panel #${type.panel_id}${panel?.open_title ? ` — ${panel.open_title}` : ''}`.slice(0, 100));
      if (type.emoji) option.setEmoji(type.emoji);
      return option;
    });
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`ticket:transferto:${ticket.id}`).setPlaceholder('Transférer vers le type…').addOptions(options),
  );
}

/** Boutons affichés une fois le ticket fermé : lien transcript (facultatif), réouverture, suppression du salon. */
function closedTicketControls(ticket, { transcriptUrl } = {}) {
  const buttons = [];
  if (transcriptUrl) buttons.push(new ButtonBuilder().setURL(transcriptUrl).setLabel('Voir le transcript').setStyle(ButtonStyle.Link).setEmoji('📄'));
  buttons.push(new ButtonBuilder().setCustomId(`ticket:reopen:${ticket.id}`).setLabel('Réouvrir').setStyle(ButtonStyle.Secondary).setEmoji('↩️'));
  buttons.push(new ButtonBuilder().setCustomId(`ticket:delete:${ticket.id}`).setLabel('Supprimer le salon').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
  return [new ActionRowBuilder().addComponents(buttons)];
}

module.exports = { panelComponents, openTicketControls, closedTicketControls, transferSelect };
