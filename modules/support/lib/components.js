'use strict';

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/** Menu déroulant listant des nœuds (catégories/réponses) — 25 options max, limite Discord. */
function pickerRow(nodes, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('support:pick')
      .setPlaceholder((placeholder || 'Choisis une option…').slice(0, 150))
      .addOptions(
        nodes.slice(0, 25).map((n) => ({
          label: n.label.slice(0, 100),
          value: String(n.id),
          description: n.select_description ? n.select_description.slice(0, 100) : undefined,
          emoji: n.emoji || undefined,
        })),
      ),
  );
}

/**
 * Boutons sous une réponse : avis (« Ça m'a aidé » / « Pas résolu », mesure de l'efficacité) et, si configuré,
 * « Créer un ticket ». `voted` : avis déjà donné par ce membre (true / false), mis en évidence.
 */
function responseRow(nodeId, { allowTicket = false, voted = null } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`support:fb:${nodeId}:1`)
      .setLabel('Ça m’a aidé')
      .setEmoji('👍')
      .setStyle(voted === true ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`support:fb:${nodeId}:0`)
      .setLabel('Pas résolu')
      .setEmoji('👎')
      .setStyle(voted === false ? ButtonStyle.Danger : ButtonStyle.Secondary),
  );
  if (allowTicket) {
    row.addComponents(new ButtonBuilder().setCustomId(`support:ticket:${nodeId}`).setLabel('Créer un ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'));
  }
  return row;
}

module.exports = { pickerRow, responseRow };
