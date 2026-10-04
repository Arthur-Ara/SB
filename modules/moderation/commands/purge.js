'use strict';

const { SlashCommandBuilder, InteractionContextType, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Recréer un salon à l’identique (vide tous les messages)')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon à purger (par défaut : ce salon)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)
        .setRequired(false),
    )
    .addStringOption((o) => o.setName('raison').setDescription('Raison de la purge').setRequired(false).setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const oldChannel = interaction.options.getChannel('salon') ?? interaction.channel;
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    // Action irréversible (tous les messages du salon sont perdus) : confirmation obligatoire, comme /permission purge.
    const confirmed = await ui.confirm(interaction, {
      prompt: ui.card({
        title: 'Purger ce salon ?',
        description:
          `${ui.EMOJIS.warning} <#${oldChannel.id}> va être **recréé à l’identique** : tous ses messages seront définitivement perdus.\n` +
          'Les journaux, panels et menus des modules qui y étaient publiés seront rattachés au nouveau salon.',
      }),
      confirmLabel: 'Purger le salon',
    });
    if (!confirmed) {
      await ui.respond(interaction, ui.card({ description: `${ui.EMOJIS.error} Purge annulée : rien n’a été modifié.` }));
      return;
    }

    const position = oldChannel.position;
    const oldId = oldChannel.id;
    const newChannel = await oldChannel.clone({ reason: reason ?? 'Purge du salon' });
    await newChannel.setPosition(position).catch(() => {});
    await oldChannel.delete(reason ?? 'Purge du salon').catch(() => {});

    // Chaque module rattache lui-même ses journaux, panels et menus au nouveau salon (crochet onChannelReplaced).
    const actor = { id: interaction.user.id, name: interaction.member?.displayName ?? interaction.user.username, web: false, member: interaction.member };
    const reassigned = await ctx.modules.callHook('onChannelReplaced', guild.id, guild, oldId, newChannel, actor);

    await moderation.record({
      guildId: guild.id,
      action: 'purge',
      channelId: newChannel.id,
      executorId: interaction.user.id,
      reason,
      metadata: { oldChannelId: oldId, newChannelId: newChannel.id, reassigned },
    });

    await ui
      .respond(
        interaction,
        actionCard(
          'purge',
          `<#${newChannel.id}> a été recréé.${reassigned.length ? `\n♻️ Rattaché au nouveau salon : ${reassigned.join(', ')}.` : ''}`,
          reason ? [{ name: 'Raison', value: reason }] : [],
        ),
      )
      .catch(() => {}); // la commande a pu être lancée depuis le salon purgé
    await logs.action({ guildId: guild.id, action: 'purge', channelId: newChannel.id, executorId: interaction.user.id, reason });
  },
};
