'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { meta } = require('../lib/format');
const { openTicket } = require('../../tickets/lib/lifecycle');

/** Sanctions qu'un membre encore présent sur le serveur peut contester (un banni ne peut plus lancer de commande). */
const APPEALABLE = ['warn', 'tempmute', 'tempvocmute', 'shadowban', 'automod'];
const MAX_AGE_DAYS = 30;

function recentEnough(row) {
  return Date.now() - new Date(row.created_at).getTime() <= MAX_AGE_DAYS * 86_400_000;
}

/**
 * Contestation d'une sanction par le membre sanctionné : ouvre un ticket du type choisi sur le panel
 * (module Tickets), avec la sanction et le motif en réponses de formulaire. Désactivée par défaut ;
 * une seule contestation par sanction, sur les sanctions des 30 derniers jours.
 */
module.exports = {
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder()
    .setName('contester')
    .setDescription('Contester une sanction reçue (ouvre un ticket auprès du staff)')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('sanction').setDescription('Sanction à contester').setRequired(true).setMinValue(1).setAutocomplete(true))
    .addStringOption((o) => o.setName('motif').setDescription('Pourquoi tu contestes cette sanction').setRequired(true).setMaxLength(1000)),

  async autocomplete(ctx, interaction) {
    if (!interaction.guildId) return interaction.respond([]);
    const rows = (await ctx.services.moderation.appealableActions(interaction.guildId, interaction.user.id, APPEALABLE)).filter(recentEnough);
    const query = String(interaction.options.getFocused() ?? '').trim();
    await interaction.respond(
      rows
        .filter((row) => !query || String(row.id).startsWith(query))
        .slice(0, 25)
        .map((row) => ({
          name: `#${row.id} — ${meta(row.action).label} du ${ui.dateTime(row.created_at)}${row.reason ? ` : ${row.reason}` : ''}`.slice(0, 100),
          value: Number(row.id),
        })),
    );
  },

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { moderation, logs } = ctx.services;
    const settings = await moderation.settings(guild.id);
    if (!settings.appealEnabled || !settings.appealTicketTypeId) {
      return ui.replyError(interaction, 'Les contestations ne sont pas activées sur ce serveur.', 'Indisponible', '⚖️');
    }

    const id = interaction.options.getInteger('sanction', true);
    const reason = interaction.options.getString('motif', true);
    const row = await moderation.get(guild.id, id);
    if (!row || String(row.target_id) !== interaction.user.id || !APPEALABLE.includes(row.action)) {
      return ui.replyError(interaction, `La sanction #${id} n’existe pas ou ne te concerne pas.`, 'Introuvable', '⚖️');
    }
    if (!recentEnough(row)) return ui.replyError(interaction, `Cette sanction date de plus de ${MAX_AGE_DAYS} jours : elle ne peut plus être contestée.`, 'Trop ancienne', '⚖️');
    if (await moderation.appealFor(row.id)) return ui.replyError(interaction, 'Tu as déjà contesté cette sanction.', 'Déjà contestée', '⚖️');

    if (!ctx.modules.isEnabledFor('tickets', guild.id)) return ui.replyError(interaction, 'Le module Tickets est désactivé : contestation impossible pour le moment.', 'Indisponible', '⚖️');
    const ticketsServices = ctx.modules.services('tickets');
    const type = ticketsServices ? await ticketsServices.tickets.getType(settings.appealTicketTypeId) : null;
    const panel = type ? await ticketsServices.tickets.getPanel(type.panel_id) : null;
    if (!panel || String(panel.guild_id) !== guild.id) return ui.replyError(interaction, 'Le type de ticket des contestations n’existe plus : préviens un administrateur.', 'Indisponible', '⚖️');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { label } = meta(row.action);
    const answers = [
      { question: 'Sanction contestée', answer: `#${row.id} — ${label} du ${ui.dateTime(row.created_at)}${row.reason ? `\nRaison : ${row.reason}` : ''}` },
      { question: 'Motif de la contestation', answer: reason },
    ];
    // openTicket() n'utilise que les services du module Tickets : on lui passe son ctx (comme le module Support).
    const result = await openTicket({ services: ticketsServices, logger: ctx.logger }, { panel, type, guild, opener: interaction.user, answers });
    if (result.error) return ui.respond(interaction, ui.errorCard(result.error, 'Action impossible', '⚖️'));

    await moderation.recordAppeal({ actionId: row.id, guildId: guild.id, userId: interaction.user.id, ticketId: result.ticket.id, reason });
    await logs.send(guild.id, ui.card({ description: `⚖️ <@${interaction.user.id}> conteste la sanction \`#${row.id}\` (${label}) — ticket <#${result.channel.id}>\n📝 ${reason}`, timestamp: true }));
    await ui.respond(interaction, ui.successCard('Contestation envoyée', `Ton ticket a été créé : <#${result.channel.id}>. Le staff étudiera ta demande.`, '⚖️'));
  },
};
