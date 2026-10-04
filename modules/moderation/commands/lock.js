'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { isChannelLocked, lockChannel } = require('../lib/channelLock');
const { parseDuration, formatDuration } = require('../../../src/core/duration');

const MAX_LOCK_SECONDS = 30 * 86_400;

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Bloquer l’écriture dans un salon')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon à verrouiller (par défaut : ce salon)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addStringOption((o) => o.setName('raison').setDescription('Raison du verrouillage').setRequired(false).setMaxLength(512))
    .addStringOption((o) => o.setName('duree').setDescription('Déverrouillage automatique après : 10m, 2h, 1j… (30 j max)').setRequired(false).setMaxLength(20)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const channel = interaction.options.getChannel('salon') ?? interaction.channel;
    const reason = interaction.options.getString('raison');
    const durationText = interaction.options.getString('duree');
    const seconds = durationText ? parseDuration(durationText) : null;
    if (durationText && (!seconds || seconds > MAX_LOCK_SECONDS)) {
      return ui.replyError(interaction, 'Durée invalide : par exemple `10m`, `2h` ou `1j` (30 jours maximum).', 'Durée invalide', '🔒');
    }
    const { moderation, logs } = ctx.services;

    if (isChannelLocked(channel)) return ui.replyError(interaction, `<#${channel.id}> est déjà verrouillé.`, 'Déjà verrouillé', '⚠️');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await lockChannel(moderation, channel, interaction.user.id, reason);
    const unlockAt = seconds ? new Date(Date.now() + seconds * 1000) : null;
    if (unlockAt) await moderation.setUnlockAt(guild.id, channel.id, unlockAt);
    const logReason = seconds ? `${reason ?? '—'} (${formatDuration(seconds)})` : reason;
    await moderation.record({ guildId: guild.id, action: 'lock', channelId: channel.id, executorId: interaction.user.id, reason, durationS: seconds, expiresAt: unlockAt });

    const fields = [];
    if (reason) fields.push({ name: 'Raison', value: reason });
    if (unlockAt) fields.push({ name: 'Déverrouillage', value: ui.dateTime(unlockAt) });
    await ui.respond(interaction, actionCard('lock', `<#${channel.id}> a été verrouillé${seconds ? ` pour **${formatDuration(seconds)}**` : ''}.`, fields));
    await logs.action({ guildId: guild.id, action: 'lock', channelId: channel.id, executorId: interaction.user.id, reason: logReason });
  },
};
