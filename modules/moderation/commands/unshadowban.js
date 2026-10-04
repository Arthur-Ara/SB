'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { restoreChannelAccess } = require('../lib/prison');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('unshadow-ban')
    .setDescription('Lever le shadow-ban d’un membre')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(false).setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    const existing = await moderation.shadowban(guild.id, target.id);
    if (!existing) return ui.replyError(interaction, `<@${target.id}> n’est pas shadow-ban.`, 'Pas shadow-ban', '⚠️');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const restored = await restoreChannelAccess(guild, target.id, existing.previous_state, {
      prisonChannelId: existing.prison_channel_id,
      reason: reason ?? 'Fin du shadow-ban',
    });

    await moderation.removeShadowban(guild.id, target.id);
    await moderation.record({ guildId: guild.id, action: 'unshadowban', targetId: target.id, executorId: interaction.user.id, reason });

    // Répondre avant de supprimer le salon prison : si la commande est lancée depuis ce salon
    // (cas fréquent), le supprimer d'abord invalide le contexte de la réponse différée (« Unknown
    // Message » — Discord ne peut plus éditer la réponse une fois son salon d'origine disparu).
    await ui.respond(interaction, actionCard('unshadowban', `Le shadow-ban de <@${target.id}> a été levé.`, reason ? [{ name: 'Raison', value: reason }] : []));
    await logs.action({ guildId: guild.id, action: 'unshadowban', targetId: target.id, executorId: interaction.user.id, reason, extra: { stats: [['Salons restaurés', String(restored)]] } });

    const prisonChannel = guild.channels.cache.get(existing.prison_channel_id);
    if (prisonChannel) await prisonChannel.delete(reason ?? 'Fin du shadow-ban').catch(() => {});
  },
};
