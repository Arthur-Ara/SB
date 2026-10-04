'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { resolveTarget } = require('../lib/guard');
const { actionCard } = require('../lib/format');

/** Lève l'exclusion temporaire (texte, timeout Discord) et le mute vocal temporaire actif, l'un ou l'autre ou les deux. */
module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Lever l’exclusion temporaire (texte et/ou vocal) d’un membre')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison');

    const { user, member, error } = await resolveTarget(interaction);
    if (error) return ui.replyError(interaction, error, 'Action impossible', '🔊');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const lifted = [];

    if (member.communicationDisabledUntil) {
      try {
        await member.timeout(null, reason ?? undefined);
        lifted.push('exclusion temporaire (texte)');
        await ctx.services.moderation.record({ guildId: guild.id, action: 'unmute', targetId: user.id, executorId: interaction.user.id, reason });
        await ctx.services.logs.action({ guildId: guild.id, action: 'unmute', targetId: user.id, executorId: interaction.user.id, reason });
      } catch (err) {
        return ui.replyError(interaction, `Levée de l’exclusion impossible : ${err.message}`, 'Erreur', '🔊');
      }
    }

    const activeVocMute = await ctx.services.moderation.activeTempVocMute(guild.id, user.id);
    if (activeVocMute || member.voice.serverMute) {
      try {
        if (member.voice.serverMute) await member.voice.setMute(false, reason ?? undefined);
        if (activeVocMute) await ctx.services.moderation.resolve(activeVocMute.id, interaction.user.id);
        lifted.push('mute vocal');
        await ctx.services.moderation.record({ guildId: guild.id, action: 'untempvocmute', targetId: user.id, executorId: interaction.user.id, reason });
        await ctx.services.logs.action({ guildId: guild.id, action: 'untempvocmute', targetId: user.id, executorId: interaction.user.id, reason });
      } catch (err) {
        return ui.replyError(interaction, `Levée du mute vocal impossible : ${err.message}`, 'Erreur', '🔊');
      }
    }

    if (!lifted.length) return ui.replyError(interaction, `<@${user.id}> n’a aucune exclusion active.`, 'Rien à faire', '🔊');
    await ui.respond(interaction, actionCard('unmute', `<@${user.id}> : ${lifted.join(' et ')} levé(e)(s).`, [{ name: 'Raison', value: reason ?? '—' }]));
  },
};
