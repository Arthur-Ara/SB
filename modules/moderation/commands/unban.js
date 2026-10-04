'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un membre (par ID Discord)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('id').setDescription('ID Discord du membre banni').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du débannissement').setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const id = interaction.options.getString('id', true).trim();
    const reason = interaction.options.getString('raison');
    if (!/^\d{17,20}$/.test(id)) return ui.replyError(interaction, 'ID Discord invalide (17 à 20 chiffres attendus).');

    const ban = await guild.bans.fetch(id).catch(() => null);
    if (!ban) return ui.replyError(interaction, `<@${id}> n’est pas banni de ce serveur.`, 'Action impossible', '🕊️');
    if (await ctx.services.moderation.blacklistEntry(id)) {
      return ui.replyError(interaction, `<@${id}> est blacklisté : utilise \`/unblacklist\` pour lever le bannissement.`, 'Action impossible', '⛔');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await guild.members.unban(id, reason ?? undefined);
    } catch (err) {
      return ui.replyError(interaction, `Débannissement impossible : ${err.message}`, 'Erreur', '🕊️');
    }

    await ctx.services.moderation.resolveBans(guild.id, id, interaction.user.id);
    await ctx.services.moderation.record({ guildId: guild.id, action: 'unban', targetId: id, executorId: interaction.user.id, reason });
    await ui.respond(interaction, actionCard('unban', `<@${id}> a été débanni.`, [{ name: 'Raison', value: reason ?? '—' }]));
    await ctx.services.logs.action({ guildId: guild.id, action: 'unban', targetId: id, executorId: interaction.user.id, reason });
  },
};
